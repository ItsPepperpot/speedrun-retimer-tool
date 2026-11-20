/*
 * Minimal MP4 / MOV (ISO-BMFF / QuickTime) parser.
 * Reads only the 'moov' box of a local File and extracts, for the first video
 * track, the exact presentation timestamp of every frame (stts + ctts + elst).
 * This gives exact frame rate and frame-accurate navigation without a server.
 */
(function (global) {
  'use strict';

  const CONTAINER_TOP = /^(ftyp|moov|mdat|free|skip|wide|pnot|uuid|styp|sidx|moof|mfra|meta|PICT)$/;

  async function readSlice(file, start, end) {
    return new DataView(await file.slice(start, end).arrayBuffer());
  }
  function u64(dv, o) { return dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4); }
  function i64(dv, o) { return dv.getInt32(o) * 4294967296 + dv.getUint32(o + 4); }
  function fourcc(dv, o) {
    return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  }
  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

  // Walk top-level boxes using only their headers, return the moov box bytes.
  async function findMoov(file) {
    let off = 0;
    let first = true;
    while (off + 8 <= file.size) {
      const dv = await readSlice(file, off, Math.min(off + 16, file.size));
      let size = dv.getUint32(0);
      const type = fourcc(dv, 4);
      let hdr = 8;
      if (first) {
        if (!CONTAINER_TOP.test(type)) return null; // not an ISO-BMFF file
        first = false;
      }
      if (size === 1) { if (dv.byteLength < 16) return null; size = u64(dv, 8); hdr = 16; }
      else if (size === 0) size = file.size - off;
      if (size < hdr) return null;
      if (type === 'moov') {
        if (size > 1024 * 1024 * 1024) return null;
        return readSlice(file, off, off + size);
      }
      off += size;
    }
    return null;
  }

  function children(dv, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = fourcc(dv, o + 4);
      let hdr = 8;
      if (size === 1) { size = u64(dv, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o + hdr, end: o + size });
      o += size;
    }
    return out;
  }
  function child(dv, box, type) {
    return box ? children(dv, box.start, box.end).find(b => b.type === type) : undefined;
  }

  function parseVideoTrack(dv, trak, movieTs, fragmented) {
    const mdia = child(dv, trak, 'mdia');
    const hdlr = child(dv, mdia, 'hdlr');
    if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'vide') return null;

    const mdhd = child(dv, mdia, 'mdhd');
    if (!mdhd) return null;
    const mdv = dv.getUint8(mdhd.start);
    const ts = dv.getUint32(mdhd.start + (mdv === 1 ? 20 : 12));
    const stbl = child(dv, child(dv, mdia, 'minf'), 'stbl');
    if (!stbl || !ts) return null;

    const result = { codec: '', width: 0, height: 0, timescale: ts, fragmented, frameCount: 0, times: null };

    const stsd = child(dv, stbl, 'stsd');
    if (stsd && stsd.start + 16 <= stsd.end) {
      const e = stsd.start + 8;
      result.codec = fourcc(dv, e + 4).trim();
      if (e + 8 + 28 <= stsd.end) {
        result.width = dv.getUint16(e + 8 + 24);
        result.height = dv.getUint16(e + 8 + 26);
      }
    }

    const stts = child(dv, stbl, 'stts');
    if (!stts) return result;
    const nStts = dv.getUint32(stts.start + 4);
    const entries = [];
    let total = 0;
    for (let k = 0; k < nStts; k++) {
      const o = stts.start + 8 + k * 8;
      if (o + 8 > stts.end) break;
      const c = dv.getUint32(o), d = dv.getUint32(o + 4);
      entries.push([c, d]);
      total += c;
    }
    if (total === 0) return result; // fragmented MP4: samples live in moof boxes

    // Decode timestamps
    const pts = new Float64Array(total);
    let i = 0, t = 0;
    for (const [c, d] of entries) {
      for (let k = 0; k < c; k++) { pts[i++] = t; t += d; }
    }
    // Composition offsets (B-frames)
    const ctts = child(dv, stbl, 'ctts');
    if (ctts) {
      const n = dv.getUint32(ctts.start + 4);
      let j = 0;
      for (let k = 0; k < n && j < total; k++) {
        const o = ctts.start + 8 + k * 8;
        if (o + 8 > ctts.end) break;
        const c = dv.getUint32(o), off = dv.getInt32(o + 4);
        for (let q = 0; q < c && j < total; q++) pts[j++] += off;
      }
    }
    // Edit list
    let mediaStart = 0, emptyDur = 0;
    const elst = child(dv, child(dv, trak, 'edts'), 'elst');
    if (elst) {
      const ev = dv.getUint8(elst.start);
      const n = dv.getUint32(elst.start + 4);
      let o = elst.start + 8;
      for (let k = 0; k < n; k++) {
        let seg, mt;
        if (ev === 1) { seg = u64(dv, o); mt = i64(dv, o + 8); o += 20; }
        else { seg = dv.getUint32(o); mt = dv.getInt32(o + 4); o += 12; }
        if (mt === -1) emptyDur += seg / movieTs;
        else { mediaStart = mt; break; }
      }
    }

    pts.sort();
    let first = 0;
    while (first < total && pts[first] < mediaStart) first++;
    if (first >= total) first = 0;
    const times = new Float64Array(total - first);
    for (let k = 0; k < times.length; k++) times[k] = (pts[first + k] - mediaStart) / ts + emptyDur;

    // Constant frame rate if every stts entry (bar a trailing one) shares a duration
    let mainD = entries[0][1], mainC = 0;
    for (const [c, d] of entries) if (c > mainC) { mainC = c; mainD = d; }
    const cfr = entries.every((e, idx) => e[1] === mainD || idx === entries.length - 1);

    let fps, fpsNum = 0, fpsDen = 0;
    if (cfr && mainD > 0) {
      const g = gcd(ts, mainD);
      fpsNum = ts / g; fpsDen = mainD / g; fps = ts / mainD;
    } else {
      const span = times[times.length - 1] - times[0];
      fps = span > 0 ? (times.length - 1) / span : 30;
    }

    return Object.assign(result, { frameCount: times.length, times, cfr, fps, fpsNum, fpsDen });
  }

  async function parse(file) {
    const dv = await findMoov(file);
    if (!dv) return null;
    const moov = { start: dv.getUint32(0) === 1 ? 16 : 8, end: dv.byteLength };
    let movieTs = 1000;
    const mvhd = child(dv, moov, 'mvhd');
    if (mvhd) {
      const v = dv.getUint8(mvhd.start);
      movieTs = dv.getUint32(mvhd.start + (v === 1 ? 20 : 12)) || 1000;
    }
    const fragmented = !!child(dv, moov, 'mvex');
    for (const trak of children(dv, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      const r = parseVideoTrack(dv, trak, movieTs, fragmented);
      if (r) return r;
    }
    return null;
  }

  global.MP4Info = { parse };
})(window);
