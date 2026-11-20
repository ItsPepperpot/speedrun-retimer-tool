(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const ui = {
    panes: $('#panes'), paneTpl: $('#paneTpl'), fileInput: $('#fileInput'),
    singleBtn: $('#singleBtn'), dualBtn: $('#dualBtn'), syncBtn: $('#syncBtn'),
    themeBtn: $('#themeBtn'), helpBtn: $('#helpBtn'), helpDlg: $('#helpDlg'),
    fpsDlg: $('#fpsDlg'), fpsInput: $('#fpsInput'), fpsDlgInfo: $('#fpsDlgInfo'), fpsPresets: $('#fpsPresets'),
    toast: $('#toast'),
  };

  const COLORS = ['#4f7cff', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#2d9cdb', '#e056a0', '#8d6e63'];
  const COMMON_FPS = [
    [24000 / 1001, '23.976'], [24, '24'], [25, '25'], [30000 / 1001, '29.97'], [30, '30'],
    [48, '48'], [50, '50'], [60000 / 1001, '59.94'], [60, '60'], [90, '90'], [100, '100'],
    [120000 / 1001, '119.88'], [120, '120'], [144, '144'], [240, '240'],
  ];
  const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => motionQuery.matches;
  // Restart a one-shot CSS animation class on an element
  function replay(el, cls) {
    if (!el || reducedMotion()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  // ---------------------------------------------------------------------------
  // Formatting / parsing
  // ---------------------------------------------------------------------------
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // Whole milliseconds, rounded down (16.67 ms -> 16 ms). The tiny epsilon stops
  // floating-point error turning an exact value like 0.29 s (0.28999…) into 289 ms.
  const floorMs = t => Math.floor(Math.abs(t) * 1000 + 1e-6);

  function splitMs(t) {
    let ms = floorMs(t);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    return { h, m, s, ms };
  }
  function fmtTC(t) {
    const { h, m, s, ms } = splitMs(t);
    return `${t < 0 ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }
  function fmtHuman(t) {
    const { h, m, s, ms } = splitMs(t);
    const sign = t < 0 ? '−' : '';
    if (h) return `${sign}${h}h ${pad(m)}m ${pad(s)}s ${pad(ms, 3)}ms`;
    if (m) return `${sign}${m}m ${pad(s)}s ${pad(ms, 3)}ms`;
    return `${sign}${s}s ${pad(ms, 3)}ms`;
  }
  const fmtFps = f => isFinite(f) ? f.toFixed(3).replace(/\.?0+$/, '') : '–';

  // Accepts "1:02:03.456", "2:03", "75.5", "f1200" / "#1200" (frame index).
  function parseTime(str) {
    str = str.trim();
    const m = /^[f#](\d+)$/i.exec(str);
    if (m) return { frame: parseInt(m[1], 10) };
    if (!/^[\d:.\s]+$/.test(str)) return null;
    const parts = str.split(':').map(s => s.trim());
    if (parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return null;
    let t = 0;
    for (const p of parts) t = t * 60 + Number(p);
    return { time: t };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = 0;
  function toast(msg) {
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    replay(ui.toast, 'pop-in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2200);
  }
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); }
    catch (e) { toast('Copy failed – clipboard not available'); }
  }

  // ---------------------------------------------------------------------------
  // Frame model: maps between frame indices and presentation times.
  // 'table' = exact per-frame timestamps from the container; 'cfr' = i / fps.
  // ---------------------------------------------------------------------------
  class FrameModel {
    constructor() { this.kind = 'cfr'; this.times = null; this.fps = 30; this.count = 1; this.duration = 0; this.mediaDuration = 0; }
    setTable(times, fps) { this.kind = 'table'; this.times = times; this.fps = fps; this.count = times.length; }
    setCfr(fps) {
      this.kind = 'cfr'; this.times = null; this.fps = fps;
      this.count = Math.max(1, Math.round(this.duration * fps));
    }
    frameTime(i) { return this.kind === 'table' ? this.times[i] : i / this.fps; }
    frameAt(t) {
      if (this.kind === 'table') {
        const a = this.times;
        if (t < a[0]) return 0;
        let lo = 0, hi = a.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (a[mid] <= t + 1e-4) lo = mid; else hi = mid - 1;
        }
        return lo;
      }
      return clamp(Math.floor(t * this.fps + 1e-4), 0, this.count - 1);
    }
    frameDur(i) {
      if (this.kind === 'table') {
        if (i + 1 < this.count) return this.times[i + 1] - this.times[i];
        if (i > 0) return this.times[i] - this.times[i - 1];
      }
      return 1 / this.fps;
    }
    // Seek to the middle of a frame so the browser reliably shows that frame.
    seekTime(i) {
      let t = this.frameTime(i) + this.frameDur(i) / 2;
      const end = this.mediaDuration || this.duration;
      if (end) t = Math.min(t, Math.max(0, end - 0.0005));
      return Math.max(0, t);
    }
  }

  // ---------------------------------------------------------------------------
  // Player: one video panel with its own frame model and timespans
  // ---------------------------------------------------------------------------
  class Player {
    constructor(index) {
      this.index = index;
      this.root = ui.paneTpl.content.firstElementChild.cloneNode(true);
      const q = s => this.root.querySelector(s);
      this.video = q('video');
      this.el = {
        tag: q('.pane-tag'), fileName: q('.file-name'), openBtn: q('.open-btn'),
        videoWrap: q('.video-wrap'), drop: q('.drop'), overlay: q('.overlay-msg'),
        timeInput: q('.timecode'), frameNum: q('.frame-num'), frameCount: q('.frame-count'),
        fpsBtn: q('.fps-btn'), fpsInfo: q('.fps-info'), durText: q('.dur-text'), mediaInfo: q('.media-info'),
        timeline: q('.timeline'), tlSpans: q('.tl-spans'), tlPlayhead: q('.tl-playhead'), tlHover: q('.tl-hover'),
        transport: q('.transport'), playBtn: q('.play'), rateSel: q('.rate-sel'),
        addSpan: q('.add-span'), spanList: q('.span-list'), copyAll: q('.copy-all'), csv: q('.csv'), clear: q('.clear'),
      };
      this.el.tag.textContent = index + 1;
      // Controls and info stay hidden until the first video loads (see .pane.empty in CSS)
      this.root.classList.add('empty');
      this.model = new FrameModel();
      this.s = {
        file: null, loaded: false, loadToken: 0, estimating: false, frame: 0,
        spans: [], activeId: null, detected: null, fpsSource: '', override: false, info: null,
      };
      this.objectUrl = null;
      this.pendingSeek = null;
      ui.panes.appendChild(this.root);
      this.bind();
      this.renderAll();
    }

    // --- Navigation (seeks are coalesced so holding a key stays responsive) ---
    requestSeek(t) {
      this.pendingSeek = t;
      if (!this.video.seeking) this.flushSeek();
    }
    flushSeek() {
      if (this.pendingSeek == null) return;
      const t = this.pendingSeek;
      this.pendingSeek = null;
      this.video.currentTime = t;
    }
    goToFrame(i) {
      if (!this.s.loaded) return;
      i = clamp(Math.round(i), 0, this.model.count - 1);
      this.s.frame = i;
      if (!this.video.paused) {
        this.pendingSeek = null;
        this.video.currentTime = this.model.seekTime(i);
      } else {
        this.requestSeek(this.model.seekTime(i));
      }
      this.renderReadout();
    }
    stepFrames(n) {
      if (!this.s.loaded) return;
      if (!this.video.paused) this.video.pause();
      this.goToFrame(this.s.frame + n);
    }
    stepSeconds(sec) {
      if (!this.s.loaded) return;
      const t = clamp(this.model.frameTime(this.s.frame) + sec, 0, this.model.duration);
      this.goToFrame(this.model.frameAt(t));
    }
    goToTime(t) { if (this.s.loaded) this.goToFrame(this.model.frameAt(t)); }
    goFirst() { this.goToFrame(0); }
    goLast() { this.goToFrame(this.model.count - 1); }
    get playing() { return !this.video.paused; }
    play() {
      if (!this.s.loaded) return;
      if (this.s.frame >= this.model.count - 1) this.goToFrame(0);
      this.video.play().catch(() => {});
    }
    pause() { if (!this.video.paused) this.video.pause(); }

    // --- Loading ---
    showOverlay(msg) {
      this.el.overlay.textContent = msg || '';
      this.el.overlay.hidden = !msg;
    }

    async estimateFps() {
      if (!HAS_RVFC) return null;
      const v = this.video;
      const wasMuted = v.muted;
      v.muted = true;
      const times = [];
      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const cb = (now, meta) => {
          if (done) return;
          times.push(meta.mediaTime);
          if (times.length >= 24) finish(); else v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        v.play().catch(finish);
        setTimeout(finish, 4000);
      });
      v.pause();
      v.muted = wasMuted;
      const deltas = [];
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1];
        if (d > 1e-4) deltas.push(d);
      }
      if (deltas.length < 3) return null;
      // Timestamps may be rounded, and frames are often skipped when decoding can't keep up,
      // so treat the shortest typical delta as one frame and average over the whole run.
      const sorted = [...deltas].sort((a, b) => a - b);
      const typical = sorted[Math.floor(sorted.length * 0.1)];
      let intervals = 0, span = 0;
      for (const d of deltas) { intervals += Math.max(1, Math.round(d / typical)); span += d; }
      const raw = intervals / span;
      let fps = raw, best = 0.01;
      for (const [f] of COMMON_FPS) {
        const err = Math.abs(f - raw) / f;
        if (err < best) { best = err; fps = f; }
      }
      return fps;
    }

    async load(file) {
      if (!file) return;
      const s = this.s, v = this.video;
      const token = ++s.loadToken;
      Object.assign(s, { loaded: false, estimating: false, file, frame: 0, override: false });
      this.pendingSeek = null;
      this.el.fileName.textContent = file.name;
      this.el.fileName.title = file.name;
      this.el.fileName.classList.remove('muted');
      this.el.drop.classList.add('hidden-drop');
      this.showOverlay('Loading…');
      updateTitle();

      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(file);

      const parseP = (async () => {
        try {
          const mp4 = await MP4Info.parse(file);
          if (mp4) return mp4;
        } catch (err) { console.warn('MP4 parse failed', err); }
        try {
          return await WebMInfo.parse(file, p => {
            if (token === s.loadToken) this.showOverlay(`Reading frame timestamps… ${Math.round(p * 100)}%`);
          });
        } catch (err) { console.warn('WebM parse failed', err); }
        return null;
      })();
      const readyP = new Promise((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(v.error); };
        const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); };
        v.addEventListener('loadeddata', ok);
        v.addEventListener('error', bad);
      });
      v.src = this.objectUrl;
      v.playbackRate = Number(this.el.rateSel.value);
      v.load();

      let info;
      try {
        [info] = await Promise.all([parseP, readyP]);
      } catch (err) {
        if (token !== s.loadToken) return;
        this.showOverlay('This browser can’t play this video format/codec. Try an MP4 (H.264) or WebM file, or another browser.');
        this.el.drop.classList.remove('hidden-drop');
        this.renderAll();
        return;
      }
      if (token !== s.loadToken) return;

      s.info = info;
      if (!isFinite(v.duration)) {
        // e.g. WebM from MediaRecorder: seeking far past the end makes the browser compute the duration
        this.showOverlay('Reading duration…');
        await new Promise(resolve => {
          const done = () => { v.removeEventListener('durationchange', check); resolve(); };
          const check = () => { if (isFinite(v.duration)) done(); };
          v.addEventListener('durationchange', check);
          v.currentTime = 1e101;
          setTimeout(done, 5000);
        });
        if (token !== s.loadToken) return;
      }
      const m = this.model;
      const hasTable = info && info.times && info.times.length > 1;
      const vd = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      m.mediaDuration = vd;
      if (hasTable) {
        const t = info.times, n = t.length;
        m.duration = Math.max(vd, t[n - 1] + (t[n - 1] - t[n - 2]));
        m.setTable(t, info.fps);
        s.fpsSource = info.cfr ? 'constant · read from file' : 'variable · read from file';
      } else {
        m.duration = vd;
        s.estimating = true;
        this.showOverlay('Measuring frame rate…');
        const fps = await this.estimateFps();
        if (token !== s.loadToken) return;
        s.estimating = false;
        m.setCfr(fps || 30);
        s.fpsSource = fps ? 'estimated from playback' : 'assumed – click to set';
      }
      s.detected = { kind: m.kind, times: m.times, fps: m.fps, source: s.fpsSource };

      this.showOverlay('');
      s.loaded = true;
      this.root.classList.remove('empty');
      this.loadSpans();
      this.goToFrame(0);
      this.renderAll();
    }

    // --- Timespans ---
    activeSpan() { return this.s.spans.find(sp => sp.id === this.s.activeId) || null; }

    nextColor() {
      const used = this.s.spans.map(sp => sp.color);
      return COLORS.find(c => !used.includes(c)) || COLORS[this.s.spans.length % COLORS.length];
    }

    newSpan(withStart = true) {
      if (!this.s.loaded) return null;
      const spans = this.s.spans;
      let n = spans.length + 1;
      while (spans.some(sp => sp.name === `Span ${n}`)) n++;
      const span = {
        id: Math.random().toString(36).slice(2, 10),
        name: `Span ${n}`,
        color: this.nextColor(),
        start: withStart ? this.model.frameTime(this.s.frame) : null,
        end: null,
      };
      spans.push(span);
      this.s.activeId = span.id;
      this.anim = { enter: span.id };
      this.saveSpans();
      this.renderSpans();
      this.scrollActiveIntoView();
      return span;
    }

    setPoint(which) {
      if (!this.s.loaded) return;
      const span = this.activeSpan() || this.newSpan(false);
      span[which] = this.model.frameTime(this.s.frame);
      this.anim = { flash: span.id, which };
      this.saveSpans();
      this.renderSpans();
      toast(`${which === 'start' ? 'Start' : 'End'} of “${span.name}” set to ${fmtTC(span[which])}`);
    }

    jumpToPoint(which, span = this.activeSpan()) {
      if (!span || span[which] == null) return;
      this.pause();
      this.goToTime(span[which]);
    }

    selectRelative(dir) {
      const spans = this.s.spans;
      if (!spans.length) return;
      const idx = spans.findIndex(sp => sp.id === this.s.activeId);
      const next = idx < 0 ? 0 : clamp(idx + dir, 0, spans.length - 1);
      this.s.activeId = spans[next].id;
      this.saveSpans();
      this.renderSpans();
      this.scrollActiveIntoView();
    }

    deleteSpan(id) {
      const card = this.el.spanList.querySelector(`.span-card[data-id="${id}"]`);
      if (card && !reducedMotion() && !card.classList.contains('leave')) {
        card.classList.add('leave');
        let done = false;
        const finish = () => { if (!done) { done = true; this.removeSpan(id); } };
        card.addEventListener('animationend', finish, { once: true });
        setTimeout(finish, 400);
        return;
      }
      this.removeSpan(id);
    }

    removeSpan(id) {
      const spans = this.s.spans;
      const idx = spans.findIndex(sp => sp.id === id);
      if (idx < 0) return;
      spans.splice(idx, 1);
      if (this.s.activeId === id) {
        const sp = spans[Math.min(idx, spans.length - 1)];
        this.s.activeId = sp ? sp.id : null;
      }
      this.saveSpans();
      this.renderSpans();
    }

    spanDuration(sp) { return sp.start == null || sp.end == null ? null : sp.end - sp.start; }
    spanFrames(sp) { return sp.start == null || sp.end == null ? null : this.model.frameAt(sp.end) - this.model.frameAt(sp.start); }

    storageKey() { return `vt:spans:${this.s.file.name}:${this.s.file.size}`; }
    saveSpans() {
      if (!this.s.file) return;
      try { localStorage.setItem(this.storageKey(), JSON.stringify({ spans: this.s.spans, activeId: this.s.activeId })); }
      catch (e) { /* storage unavailable */ }
    }
    loadSpans() {
      this.s.spans = [];
      this.s.activeId = null;
      try {
        const raw = localStorage.getItem(this.storageKey());
        if (raw) {
          const d = JSON.parse(raw);
          if (Array.isArray(d.spans)) this.s.spans = d.spans;
          this.s.activeId = d.activeId || (this.s.spans[0] && this.s.spans[0].id) || null;
          const n = this.s.spans.length;
          if (n) toast(`Restored ${n} saved timespan${n > 1 ? 's' : ''} for ${this.s.file.name}`);
        }
      } catch (e) { /* ignore */ }
    }

    rows() {
      return this.s.spans.map(sp => {
        const d = this.spanDuration(sp);
        return {
          video: this.s.file ? this.s.file.name : '',
          name: sp.name,
          start: sp.start == null ? '' : fmtTC(sp.start),
          end: sp.end == null ? '' : fmtTC(sp.end),
          seconds: d == null ? '' : `${d < 0 ? '-' : ''}${(floorMs(d) / 1000).toFixed(3)}`,
          hms: d == null ? '' : fmtTC(d),
          human: d == null ? '' : fmtHuman(d),
          frames: d == null ? '' : String(this.spanFrames(sp)),
        };
      });
    }

    copyAll() {
      if (!this.s.spans.length) return toast('No timespans to copy');
      const lines = ['Name\tStart\tEnd\tDuration\tDuration (s)\tFrames'];
      for (const r of this.rows()) lines.push([r.name, r.start, r.end, r.human, r.seconds, r.frames].join('\t'));
      copyText(lines.join('\n'), 'Copied all timespans (tab-separated, pastes into spreadsheets)');
    }

    exportCsv() {
      if (!this.s.spans.length) return toast('No timespans to export');
      const esc = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const lines = ['video,name,start,end,duration,duration_seconds,duration_readable,frames'];
      for (const r of this.rows()) lines.push([r.video, r.name, r.start, r.end, r.hms, r.seconds, r.human, r.frames].map(esc).join(','));
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.s.file ? this.s.file.name.replace(/\.[^.]+$/, '') : 'timespans'}-timespans.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // --- Rendering ---
    renderReadout() {
      const t = this.s.loaded ? this.model.frameTime(this.s.frame) : 0;
      if (document.activeElement !== this.el.timeInput) this.el.timeInput.value = fmtTC(t);
      this.el.frameNum.textContent = this.s.loaded ? this.s.frame : '–';
      const pct = this.s.loaded && this.model.duration ? clamp(t / this.model.duration, 0, 1) * 100 : 0;
      this.el.tlPlayhead.style.left = pct + '%';
    }

    renderInfo() {
      const e = this.el, s = this.s, m = this.model;
      if (!s.loaded) {
        e.frameCount.textContent = '–';
        e.fpsBtn.textContent = '–';
        e.fpsInfo.textContent = '';
        e.durText.textContent = '–';
        e.mediaInfo.textContent = '';
        return;
      }
      e.frameCount.textContent = m.count - 1;
      const info = s.info;
      let fpsText = `${fmtFps(m.fps)} fps`;
      if (!s.override && info && info.cfr && info.fpsDen > 1) fpsText += ` (${info.fpsNum}/${info.fpsDen})`;
      if (!s.override && info && info.times && !info.cfr) fpsText = `~${fmtFps(m.fps)} fps avg`;
      e.fpsBtn.textContent = fpsText;
      e.fpsInfo.textContent = s.override ? 'manual override' : s.fpsSource;
      e.durText.textContent = fmtTC(m.duration);
      const w = this.video.videoWidth || (info && info.width), h = this.video.videoHeight || (info && info.height);
      e.mediaInfo.textContent = [w && h ? `${w}×${h}` : '', info && info.codec ? info.codec : ''].filter(Boolean).join(' · ');
    }

    renderSpans() {
      const s = this.s;
      if (!s.spans.length) {
        this.el.spanList.innerHTML = s.loaded
          ? `<div class="empty">No timespans yet.<br>Press <kbd>N</kbd> to start one at the current frame,<br>then move to the end and press <kbd>O</kbd>.</div>`
          : `<div class="empty">Open a video to start measuring.</div>`;
      } else {
        const anim = reducedMotion() ? {} : (this.anim || {});
        this.el.spanList.innerHTML = s.spans.map(sp => {
          const d = this.spanDuration(sp);
          const frames = this.spanFrames(sp);
          const active = sp.id === s.activeId;
          let durHtml;
          if (d == null) {
            durHtml = `<div class="dur-human pending">${sp.start == null ? 'Set a start (I)' : 'Set an end (O)'}</div>`;
          } else {
            durHtml = `<div class="dur-human ${d < 0 ? 'warn' : ''}">${fmtHuman(d)}</div>
              <div class="dur-sub">${fmtTC(d)} · ${frames} frame${Math.abs(frames) === 1 ? '' : 's'}${d < 0 ? ' · <span class="warn">end before start</span>' : ''}</div>`;
          }
          const tcBtn = which => sp[which] == null
            ? `<button class="tc" disabled>––:––:––.–––</button>`
            : `<button class="tc${anim.flash === sp.id && anim.which === which ? ' flash' : ''}" data-act="go-${which}" title="Jump to ${which}">${fmtTC(sp[which])}</button>`;
          return `<div class="span-card ${active ? 'active' : ''}${anim.enter === sp.id ? ' enter' : ''}" data-id="${sp.id}" style="--c:${sp.color}">
            <div class="span-row">
              <input class="span-name" value="${escapeHtml(sp.name)}" spellcheck="false" aria-label="Timespan name">
              <button class="icon-btn" data-act="copy" title="Copy duration">⧉</button>
              <button class="icon-btn del" data-act="del" title="Delete (Del)">✕</button>
            </div>
            <div class="ends">
              <span class="lbl">Start</span>${tcBtn('start')}<button class="btn small" data-act="set-start" title="Set start to current frame (I)">Set</button>
              <span class="lbl">End</span>${tcBtn('end')}<button class="btn small" data-act="set-end" title="Set end to current frame (O)">Set</button>
            </div>
            <div class="dur"><div class="dur-main">${durHtml}</div></div>
          </div>`;
        }).join('');
      }
      this.anim = null;
      this.renderTimelineSpans();
    }

    renderTimelineSpans() {
      const m = this.model;
      if (!this.s.loaded || !m.duration) { this.el.tlSpans.innerHTML = ''; return; }
      const D = m.duration;
      this.el.tlSpans.innerHTML = this.s.spans.map(sp => {
        if (sp.start == null && sp.end == null) return '';
        const active = sp.id === this.s.activeId ? ' active' : '';
        if (sp.start == null || sp.end == null) {
          const p = (sp.start ?? sp.end) / D * 100;
          return `<div class="tl-span marker${active}" style="--c:${sp.color};left:${p}%"><span class="tl-label">${escapeHtml(sp.name)}</span></div>`;
        }
        const a = Math.min(sp.start, sp.end) / D * 100, b = Math.max(sp.start, sp.end) / D * 100;
        return `<div class="tl-span${active}" style="--c:${sp.color};left:${a}%;width:${b - a}%"><span class="tl-label">${escapeHtml(sp.name)}</span></div>`;
      }).join('');
    }

    renderAll() {
      this.renderReadout();
      this.renderInfo();
      this.renderSpans();
    }

    scrollActiveIntoView() {
      const el = this.el.spanList.querySelector('.span-card.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    focusTimeInput() { this.el.timeInput.focus(); }
    renameActive() {
      const input = this.el.spanList.querySelector('.span-card.active .span-name');
      if (input) { input.focus(); input.select(); }
    }

    // --- Events ---
    bind() {
      const v = this.video, e = this.el;
      v.addEventListener('seeked', () => this.flushSeek());

      const onFrame = (now, meta) => {
        if (!v.paused && !v.seeking && this.s.loaded) {
          this.s.frame = this.model.frameAt(meta.mediaTime);
          this.renderReadout();
        }
        v.requestVideoFrameCallback(onFrame);
      };
      if (HAS_RVFC) v.requestVideoFrameCallback(onFrame);
      const rafLoop = () => {
        if (v.paused) return;
        if (!v.seeking && this.s.loaded) {
          this.s.frame = this.model.frameAt(v.currentTime);
          this.renderReadout();
        }
        requestAnimationFrame(rafLoop);
      };

      v.addEventListener('play', () => {
        e.playBtn.textContent = '❚❚';
        replay(e.playBtn, 'boing');
        if (!HAS_RVFC) requestAnimationFrame(rafLoop);
      });
      v.addEventListener('pause', () => {
        e.playBtn.textContent = '▶';
        replay(e.playBtn, 'boing');
        if (!this.s.loaded || this.s.estimating) return;
        this.goToFrame(this.model.frameAt(v.currentTime)); // snap onto the shown frame
      });
      v.addEventListener('ended', () => { e.playBtn.textContent = '▶'; });

      // Any interaction with a pane selects it
      this.root.addEventListener('pointerdown', () => setActive(this.index), true);
      this.root.addEventListener('focusin', () => setActive(this.index));

      e.openBtn.addEventListener('click', () => openFileFor(this.index));
      e.drop.addEventListener('click', () => openFileFor(this.index));
      e.fpsBtn.addEventListener('click', () => openFpsDialog(this));
      e.playBtn.addEventListener('click', () => togglePlay(this));
      e.rateSel.addEventListener('change', () => { v.playbackRate = Number(e.rateSel.value); });
      e.transport.addEventListener('click', ev => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.frames) forTargets(this, p => p.stepFrames(Number(b.dataset.frames)));
        else if (b.dataset.sec) forTargets(this, p => p.stepSeconds(Number(b.dataset.sec)));
      });

      // Drag & drop onto this pane
      let depth = 0;
      this.root.addEventListener('dragenter', ev => {
        if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
        depth++;
        e.videoWrap.classList.add('dragging');
      });
      this.root.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (!depth) e.videoWrap.classList.remove('dragging');
      });
      this.root.addEventListener('drop', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        depth = 0;
        e.videoWrap.classList.remove('dragging');
        const f = ev.dataTransfer && ev.dataTransfer.files[0];
        if (f) { setActive(this.index); this.load(f); }
      });

      // Time input
      e.timeInput.addEventListener('focus', () => setTimeout(() => e.timeInput.select(), 0));
      e.timeInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          const r = parseTime(e.timeInput.value);
          if (!r) { e.timeInput.classList.add('invalid'); return; }
          e.timeInput.classList.remove('invalid');
          this.pause();
          if (r.frame != null) this.goToFrame(r.frame); else this.goToTime(r.time);
          e.timeInput.blur();
        } else if (ev.key === 'Escape') {
          e.timeInput.blur();
        }
      });
      e.timeInput.addEventListener('blur', () => { e.timeInput.classList.remove('invalid'); this.renderReadout(); });

      // Timeline scrubbing
      const tlTime = ev => {
        const r = e.timeline.getBoundingClientRect();
        return clamp((ev.clientX - r.left) / r.width, 0, 1) * this.model.duration;
      };
      e.timeline.addEventListener('pointerdown', ev => {
        if (!this.s.loaded) return;
        e.timeline.setPointerCapture(ev.pointerId);
        this.pause();
        this.goToTime(tlTime(ev));
        const move = mv => this.goToTime(tlTime(mv));
        const up = () => {
          e.timeline.removeEventListener('pointermove', move);
          e.timeline.removeEventListener('pointerup', up);
          e.timeline.removeEventListener('pointercancel', up);
        };
        e.timeline.addEventListener('pointermove', move);
        e.timeline.addEventListener('pointerup', up);
        e.timeline.addEventListener('pointercancel', up);
      });
      e.timeline.addEventListener('pointermove', ev => {
        if (!this.s.loaded) return;
        const t = this.model.frameTime(this.model.frameAt(tlTime(ev)));
        const r = e.timeline.getBoundingClientRect();
        e.tlHover.style.left = clamp(ev.clientX - r.left, 0, r.width) + 'px';
        e.tlHover.textContent = fmtTC(t);
        e.tlHover.hidden = false;
      });
      e.timeline.addEventListener('pointerleave', () => { e.tlHover.hidden = true; });

      // Span list
      e.addSpan.addEventListener('click', () => this.newSpan(true));
      e.spanList.addEventListener('click', ev => {
        const card = ev.target.closest('.span-card');
        if (!card) return;
        const id = card.dataset.id;
        const span = this.s.spans.find(sp => sp.id === id);
        const act = ev.target.closest('[data-act]');
        if (this.s.activeId !== id) { this.s.activeId = id; this.saveSpans(); }
        if (act) {
          switch (act.dataset.act) {
            case 'set-start': this.setPoint('start'); return;
            case 'set-end': this.setPoint('end'); return;
            case 'go-start': this.jumpToPoint('start', span); break;
            case 'go-end': this.jumpToPoint('end', span); break;
            case 'del': this.deleteSpan(id); return;
            case 'copy': {
              const d = this.spanDuration(span);
              if (d == null) toast('Span is incomplete');
              else copyText(`${fmtHuman(d)} (${fmtTC(d)})`, `Copied duration of “${span.name}”`);
              break;
            }
          }
        }
        if (!ev.target.classList.contains('span-name')) this.renderSpans();
        else {
          e.spanList.querySelectorAll('.span-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
          this.renderTimelineSpans();
        }
      });
      e.spanList.addEventListener('input', ev => {
        if (!ev.target.classList.contains('span-name')) return;
        const span = this.s.spans.find(sp => sp.id === ev.target.closest('.span-card').dataset.id);
        if (span) { span.name = ev.target.value; this.saveSpans(); this.renderTimelineSpans(); }
      });
      e.spanList.addEventListener('keydown', ev => {
        if (ev.target.classList.contains('span-name') && (ev.key === 'Enter' || ev.key === 'Escape')) {
          ev.preventDefault();
          ev.target.blur();
        }
      });
      e.copyAll.addEventListener('click', () => this.copyAll());
      e.csv.addEventListener('click', () => this.exportCsv());
      e.clear.addEventListener('click', () => {
        const n = this.s.spans.length;
        if (!n || !confirm(`Delete all ${n} timespans for ${this.s.file ? this.s.file.name : 'this video'}?`)) return;
        this.s.spans = [];
        this.s.activeId = null;
        this.saveSpans();
        this.renderSpans();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // App: layout, active pane, sync
  // ---------------------------------------------------------------------------
  const app = { players: [], active: 0, dual: false, sync: false, openTarget: 0 };
  app.players = [new Player(0), new Player(1)];
  const activePlayer = () => app.players[app.active];

  function setActive(i) {
    if (!app.dual) i = 0;
    app.active = i;
    app.players.forEach((p, j) => p.root.classList.toggle('active', j === i));
  }

  // The players a navigation command applies to
  function navTargets(origin = activePlayer()) {
    if (app.dual && app.sync) return app.players.filter(p => p.s.loaded);
    return [origin];
  }
  function forTargets(origin, fn) { navTargets(origin).forEach(fn); }

  function togglePlay(origin = activePlayer()) {
    const ps = navTargets(origin).filter(p => p.s.loaded);
    if (!ps.length) return;
    if (ps.some(p => p.playing)) ps.forEach(p => p.pause());
    else ps.forEach(p => p.play());
  }

  function setDual(on) {
    app.dual = on;
    ui.panes.classList.toggle('dual', on);
    app.players[1].root.hidden = !on;
    if (!on) app.players[1].pause();
    ui.singleBtn.classList.toggle('on', !on);
    ui.dualBtn.classList.toggle('on', on);
    ui.syncBtn.hidden = !on;
    setActive(on ? app.active : 0);
    try { localStorage.setItem('vt:dual', on ? '1' : '0'); } catch (e) { /* ignore */ }
    updateTitle();
  }

  function setSync(on) {
    app.sync = on;
    ui.syncBtn.classList.toggle('on', on);
    ui.syncBtn.setAttribute('aria-pressed', on);
    toast(on ? 'Sync on: navigation and play/pause apply to both videos' : 'Sync off');
  }

  function updateTitle() {
    const names = app.players.filter((p, i) => p.s.file && (i === 0 || app.dual)).map(p => p.s.file.name);
    document.title = names.length ? `${names.join(' | ')} – Video Timer` : 'Video Timer';
  }

  function openFileFor(index) {
    app.openTarget = index;
    ui.fileInput.click();
  }
  ui.fileInput.addEventListener('change', () => {
    const f = ui.fileInput.files[0];
    if (f) app.players[app.openTarget].load(f);
    ui.fileInput.value = '';
  });

  // Dropping outside a pane loads into the active pane
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) activePlayer().load(f);
  });

  ui.singleBtn.addEventListener('click', () => setDual(false));
  ui.dualBtn.addEventListener('click', () => setDual(true));
  ui.syncBtn.addEventListener('click', () => setSync(!app.sync));

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeButton() {
    const t = currentTheme();
    ui.themeBtn.textContent = t === 'dark' ? '☀' : '☾';
    ui.themeBtn.title = `Switch to ${t === 'dark' ? 'light' : 'dark'} theme (T)`;
  }
  function toggleTheme() {
    const t = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('vt:theme', t); } catch (e) { /* ignore */ }
    syncThemeButton();
    replay(ui.themeBtn, 'spin');
  }
  ui.themeBtn.addEventListener('click', toggleTheme);
  syncThemeButton();

  // ---------------------------------------------------------------------------
  // Frame rate override dialog
  // ---------------------------------------------------------------------------
  let fpsTarget = null;
  ui.fpsPresets.innerHTML = COMMON_FPS.map(([f, label]) =>
    `<button type="button" class="btn small" data-fps="${f}">${label}</button>`).join('');
  ui.fpsPresets.addEventListener('click', e => {
    const b = e.target.closest('[data-fps]');
    if (b) ui.fpsInput.value = Number(b.dataset.fps).toFixed(6).replace(/\.?0+$/, '');
  });
  function openFpsDialog(p) {
    if (!p.s.loaded) return;
    fpsTarget = p;
    const d = p.s.detected;
    ui.fpsDlgInfo.textContent = `${p.s.file.name} — detected: ${fmtFps(d.fps)} fps (${d.source}).`;
    ui.fpsInput.value = Number(p.model.fps.toFixed(6));
    ui.fpsDlg.returnValue = '';
    ui.fpsDlg.showModal();
    ui.fpsInput.select();
  }
  ui.fpsDlg.addEventListener('close', () => {
    const v = ui.fpsDlg.returnValue, p = fpsTarget;
    if (!p || (v !== 'apply' && v !== 'reset')) return;
    const t = p.model.frameTime(p.s.frame);
    if (v === 'reset') {
      const d = p.s.detected;
      if (d.kind === 'table') p.model.setTable(d.times, d.fps); else p.model.setCfr(d.fps);
      p.s.fpsSource = d.source;
      p.s.override = false;
    } else {
      const f = parseFloat(ui.fpsInput.value);
      if (!(f > 0 && f <= 1000)) return toast('Invalid frame rate');
      p.model.setCfr(f);
      p.s.override = true;
    }
    p.goToFrame(p.model.frameAt(t));
    p.renderAll();
  });
  ui.fpsInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); ui.fpsDlg.close('apply'); }
  });

  ui.helpBtn.addEventListener('click', () => ui.helpDlg.showModal());

  // Don't let clicked buttons keep focus (so Space/arrows always go to the player)
  document.addEventListener('pointerup', e => {
    const b = e.target.closest('button');
    if (b && !b.closest('dialog')) setTimeout(() => b.blur(), 0);
  });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', e => {
    const tgt = e.target;
    const typing = (tgt.tagName === 'INPUT' && !['button', 'range', 'checkbox', 'file'].includes(tgt.type))
      || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable;
    if (typing) return;
    if (document.querySelector('dialog[open]')) return;

    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const mod = e.ctrlKey || e.metaKey;
    const p = activePlayer();
    const nav = fn => forTargets(p, fn);
    let handled = true;

    switch (lower) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (e.altKey) { handled = false; break; } // leave browser back/forward alone
        const dir = k === 'ArrowRight' ? 1 : -1;
        if (mod) nav(x => x.stepSeconds(dir));
        else if (e.shiftKey) nav(x => x.stepFrames(dir * 10));
        else nav(x => x.stepFrames(dir));
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = k === 'ArrowUp' ? 1 : -1;
        if (e.altKey) p.selectRelative(-dir);
        else if (e.shiftKey) nav(x => x.stepSeconds(dir * 60));
        else nav(x => x.stepSeconds(dir * 10));
        break;
      }
      case 'PageUp': nav(x => x.stepSeconds(600)); break;
      case 'PageDown': nav(x => x.stepSeconds(-600)); break;
      case ',': nav(x => x.stepFrames(-1)); break;
      case '.': nav(x => x.stepFrames(1)); break;
      case '<': nav(x => x.stepFrames(-10)); break;
      case '>': nav(x => x.stepFrames(10)); break;
      case 'Home': nav(x => x.goFirst()); break;
      case 'End': nav(x => x.goLast()); break;
      default: {
        if (mod) { handled = false; break; }
        switch (lower) {
          case 'j': nav(x => x.stepSeconds(-1)); break;
          case 'l': nav(x => x.stepSeconds(1)); break;
          case ' ':
          case 'k': togglePlay(p); break;
          case 'n': p.newSpan(true); break;
          case 'i': case '[': case '{':
            if (e.shiftKey) p.jumpToPoint('start'); else p.setPoint('start');
            break;
          case 'o': case ']': case '}':
            if (!p.s.loaded && !e.shiftKey) { openFileFor(app.active); break; }
            if (e.shiftKey) p.jumpToPoint('end'); else p.setPoint('end');
            break;
          case 'g': p.focusTimeInput(); break;
          case 'F2': p.renameActive(); break;
          case 'Delete': { const sp = p.activeSpan(); if (sp) p.deleteSpan(sp.id); break; }
          case '1': setActive(0); break;
          case '2': if (app.dual) setActive(1); else handled = false; break;
          case 'd': setDual(!app.dual); break;
          case 's': if (app.dual) setSync(!app.sync); else handled = false; break;
          case 't': toggleTheme(); break;
          case '?': ui.helpDlg.showModal(); break;
          default: handled = false;
        }
      }
    }
    if (handled) e.preventDefault();
  });

  let startDual = false;
  try { startDual = localStorage.getItem('vt:dual') === '1'; } catch (e) { /* ignore */ }
  setDual(startDual);
  setActive(0);
})();
