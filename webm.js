/*
 * Minimal WebM / Matroska (EBML) parser.
 * Reads the header (TimestampScale, track DefaultDuration, codec, size) and scans
 * every Cluster for the video track's block timestamps, giving the exact
 * presentation time of each frame. Block payloads are skipped, never decoded.
 */
(function (global) {
  'use strict';

  const ID = {
    EBML: 0x1A45DFA3, Segment: 0x18538067, Info: 0x1549A966, TimestampScale: 0x2AD7B1,
    Duration: 0x4489, Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83,
    DefaultDuration: 0x23E383, CodecID: 0x86, Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
    Cluster: 0x1F43B675, Timestamp: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
  };
  // Elements we step into rather than skip (works with unknown-size Segment/Cluster too)
  const DESCEND = new Set([ID.Segment, ID.Cluster, ID.BlockGroup]);
  const CHUNK = 4 * 1024 * 1024;

  const COMMON = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 90, 100, 120000 / 1001, 120, 144, 240];
  const RATIONAL = { [24000 / 1001]: [24000, 1001], [30000 / 1001]: [30000, 1001], [60000 / 1001]: [60000, 1001], [120000 / 1001]: [120000, 1001] };

  class Reader {
    constructor(file) { this.file = file; this.size = file.size; this.start = 0; this.buf = new Uint8Array(0); }
    async need(pos, n) {
      if (pos >= this.start && pos + n <= this.start + this.buf.length) return true;
      if (pos >= this.size) return false;
      const end = Math.min(this.size, pos + Math.max(n, CHUNK));
      this.buf = new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
      this.start = pos;
      return pos + n <= end;
    }
    byte(pos) { return this.buf[pos - this.start]; }
  }

  // Variable-length integers. Returns { value, length, unknown }.
  function vint(r, pos, keepMarker) {
    const first = r.byte(pos);
    if (first === undefined || first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    let value = keepMarker ? first : first & (mask - 1);
    let allOnes = value === mask - 1;
    for (let i = 1; i < len; i++) {
      const b = r.byte(pos + i);
      if (b === undefined) return null;
      value = value * 256 + b;
      if (b !== 0xFF) allOnes = false;
    }
    return { value, length: len, unknown: !keepMarker && allOnes };
  }

  function readUint(bytes) { let v = 0; for (const b of bytes) v = v * 256 + b; return v; }
  function readFloat(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return bytes.length === 4 ? dv.getFloat32(0) : bytes.length === 8 ? dv.getFloat64(0) : 0;
  }

  // Parse a small master element (already in memory) into [{id, data}] children.
  function children(bytes) {
    const r = { byte: i => bytes[i] };
    const out = [];
    let p = 0;
    while (p < bytes.length) {
      const id = vint(r, p, true); if (!id) break;
      const sz = vint(r, p + id.length, false); if (!sz) break;
      const s = p + id.length + sz.length;
      out.push({ id: id.value, data: bytes.subarray(s, Math.min(bytes.length, s + sz.value)) });
      p = s + sz.value;
    }
    return out;
  }

  function parseTracks(bytes) {
    for (const te of children(bytes)) {
      if (te.id !== ID.TrackEntry) continue;
      const t = { number: 0, type: 0, defaultDuration: 0, codec: '', width: 0, height: 0 };
      for (const c of children(te.data)) {
        if (c.id === ID.TrackNumber) t.number = readUint(c.data);
        else if (c.id === ID.TrackType) t.type = readUint(c.data);
        else if (c.id === ID.DefaultDuration) t.defaultDuration = readUint(c.data);
        else if (c.id === ID.CodecID) t.codec = new TextDecoder().decode(c.data).replace(/^V_/, '').replace('MPEG4/ISO/AVC', 'H.264').replace('MPEGH/ISO/HEVC', 'H.265');
        else if (c.id === ID.Video) {
          for (const v of children(c.data)) {
            if (v.id === ID.PixelWidth) t.width = readUint(v.data);
            else if (v.id === ID.PixelHeight) t.height = readUint(v.data);
          }
        }
      }
      if (t.type === 1) return t; // first video track
    }
    return null;
  }

  function snap(fps, tol) {
    let best = fps, bestErr = tol;
    for (const f of COMMON) {
      const e = Math.abs(f - fps) / f;
      if (e < bestErr) { bestErr = e; best = f; }
    }
    return best;
  }

  async function parse(file, onProgress) {
    const r = new Reader(file);
    if (!(await r.need(0, 4))) return null;
    const magic = vint(r, 0, true);
    if (!magic || magic.value !== ID.EBML) return null;

    let scale = 1e6, track = null;
    const ts = [];
    let clusterTs = 0, pos = 0, lastReport = 0;

    while (pos < r.size) {
      if (!(await r.need(pos, 12))) { if (!(await r.need(pos, 2))) break; }
      const id = vint(r, pos, true); if (!id) break;
      const sz = vint(r, pos + id.length, false); if (!sz) break;
      const dataPos = pos + id.length + sz.length;
      const idv = id.value;

      if (DESCEND.has(idv)) { pos = dataPos; continue; }
      if (sz.unknown) break; // unknown-size element we don't understand

      if (idv === ID.Info || idv === ID.Tracks || idv === ID.Timestamp) {
        await r.need(dataPos, sz.value);
        const bytes = r.buf.subarray(dataPos - r.start, dataPos - r.start + sz.value);
        if (idv === ID.Timestamp) clusterTs = readUint(bytes);
        else if (idv === ID.Info) {
          for (const c of children(bytes)) if (c.id === ID.TimestampScale) scale = readUint(c.data);
        } else track = parseTracks(bytes);
      } else if ((idv === ID.SimpleBlock || idv === ID.Block) && track) {
        await r.need(dataPos, 11);
        const tn = vint(r, dataPos, false);
        if (tn && tn.value === track.number) {
          const o = dataPos + tn.length;
          let rel = (r.byte(o) << 8) | r.byte(o + 1);
          if (rel & 0x8000) rel -= 0x10000;
          ts.push(clusterTs + rel);
        }
      }
      pos = dataPos + sz.value;

      if (onProgress && pos - lastReport > 32 * 1024 * 1024) { lastReport = pos; onProgress(pos / r.size); }
    }

    if (!track) return null;
    const result = { codec: track.codec, width: track.width, height: track.height, timescale: 1e9 / scale, frameCount: 0, times: null };

    let headerFps = track.defaultDuration ? 1e9 / track.defaultDuration : 0;
    if (ts.length < 2) {
      if (!headerFps) return result;
      return Object.assign(result, rateInfo(snap(headerFps, 0.001), true));
    }

    const times = Float64Array.from(ts).sort();
    for (let i = 0; i < times.length; i++) times[i] = times[i] * scale / 1e9;
    const span = times[times.length - 1] - times[0];
    const avg = span > 0 ? (times.length - 1) / span : headerFps || 30;
    // Constant if every interval matches the average within timestamp rounding
    const tick = scale / 1e9, mean = 1 / avg;
    let cfr = true;
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(times[i] - times[i - 1] - mean) > tick * 1.01 + 1e-6) { cfr = false; break; }
    }
    const fps = !cfr ? avg : headerFps ? snap(headerFps, 0.001) : snap(avg, 0.002);
    return Object.assign(result, { frameCount: times.length, times }, rateInfo(fps, cfr));
  }

  function rateInfo(fps, cfr) {
    const rat = RATIONAL[fps] || (Number.isInteger(fps) ? [fps, 1] : [0, 0]);
    return { fps, cfr, fpsNum: rat[0], fpsDen: rat[1] };
  }

  global.WebMInfo = { parse };
})(window);
