// Lahja — Arabic dialect → English subtitles for YouTube (phone web app).
// Gemini listens to the video in parts, detects the dialect, transcribes the Arabic as spoken
// and translates it. Everything is saved on this phone (IndexedDB) so rewatching is free.
(() => {
  'use strict';
  const APP_VERSION = '1.4';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- settings (this phone only) ----------------
  const DEFAULTS = {
    key: '', model: 'gemini-3.6-flash', custom: '', partMinutes: 10,
    busyFallback: true, glossary: '', fontScale: 1, showArabic: true, learnMode: false, speed: 1
  };
  const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  const WORKERS = 2, MAX_TRIES = 3;
  let settings = loadSettings();
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('lahja.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem('lahja.settings', JSON.stringify(settings)); } catch (e) {}
  }
  const modelId = () => (settings.custom || '').trim() || settings.model;
  const partSec = () => Math.max(60, Math.min(1800, (Number(settings.partMinutes) || 10) * 60));

  // ---------------- storage: IndexedDB ----------------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('lahja', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('videos', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function dbGet(id) {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const q = d.transaction('videos').objectStore('videos').get(id);
        q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
      });
    } catch (e) { return null; }
  }
  async function dbPut(rec) {
    try {
      const d = await db();
      await new Promise((res, rej) => {
        const t = d.transaction('videos', 'readwrite'); t.objectStore('videos').put(rec);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    } catch (e) { console.warn('save failed', e); }
  }
  async function dbAll() {
    try {
      const d = await db();
      return await new Promise((res, rej) => {
        const q = d.transaction('videos').objectStore('videos').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
    } catch (e) { return []; }
  }
  async function dbDel(id) {
    try {
      const d = await db();
      await new Promise((res, rej) => {
        const t = d.transaction('videos', 'readwrite');
        id ? t.objectStore('videos').delete(id) : t.objectStore('videos').clear();
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
    } catch (e) {}
  }
  // ask the phone to keep our data even when storage is low
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------- helpers ----------------
  function videoIdFrom(text) {
    const t = String(text || '').trim();
    const m = t.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(t) ? t : null;
  }
  const fmt = s => ytdsFmtTime(s);
  let toastT = null;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600);
  }
  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function parseJson(text) {
    const t = String(text || '').replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('No JSON in response');
    return JSON.parse(t.slice(a, b + 1));
  }
  function friendlyError(raw) {
    const m = String(raw || '');
    const model = (m.match(/model:\s*([\w.\-]+)/) || [])[1];
    if (/HTTP 429/.test(m) && /limit:\s*0\b/.test(m)) return `${model || 'This model'} isn't in your free plan. Pick Gemini 3.6 Flash in Settings, or enable billing in Google AI Studio.`;
    if (/HTTP 401|HTTP 403|API key not valid|API_KEY_INVALID/i.test(m)) return 'API key rejected — check it in Settings.';
    if (/HTTP 404|not found/i.test(m)) return `Model ${model || ''} not found — check the model in Settings.`;
    if (/private|unlisted|permission|not accessible|unavailable/i.test(m) && /video|youtube|file/i.test(m)) return 'Gemini can\'t open this video (it must be public).';
    return m.length > 180 ? m.slice(0, 180) + '…' : m;
  }
  function rateLimitInfo(m) {
    if (!/HTTP 429|RESOURCE_EXHAUSTED|quota/i.test(m)) return null;
    let waitMs = 60000;
    const r = m.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
    if (r) waitMs = ((+r[1] || 0) * 3600 + (+r[2] || 0) * 60 + parseFloat(r[3])) * 1000 + 1500;
    const perMinute = /per.?minute/i.test(m), perDay = /per.?day/i.test(m);
    const noAccess = /limit:\s*0\b/.test(m);
    return { daily: noAccess || (perDay && !perMinute) || waitMs > 15 * 60000, noAccess, waitMs };
  }

  // ---------------- Gemini ----------------
  async function geminiVideo({ model, videoId, start, end, system, user, maxTokens }) {
    if (!settings.key) throw new Error('API key missing');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = lean => JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
          videoMetadata: Object.assign({ startOffset: `${start}s`, endOffset: `${end}s` }, lean ? {} : { fps: 0.2 }) },
        { text: user }
      ] }],
      generationConfig: Object.assign({ maxOutputTokens: maxTokens, temperature: 0.2, responseMimeType: 'application/json' },
        lean ? {} : { mediaResolution: 'MEDIA_RESOLUTION_LOW' })
    });
    const send = async lean => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.key }, body: body(lean) });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) {
        const e = j && j.error;
        throw new Error(`HTTP ${r.status}${e && e.message ? ': ' + e.message : ''}`);
      }
      return j || {};
    };
    let j;
    try { j = await send(false); }
    catch (e) {
      if (/HTTP 400/.test(e.message) && /fps|media.?resolution|video.?metadata|unknown name/i.test(e.message)) j = await send(true);
      else throw e;
    }
    const c = j.candidates && j.candidates[0];
    if (!c) throw new Error('Gemini returned no answer');
    if (c.finishReason === 'MAX_TOKENS') throw new Error('Response cut off (max_tokens)');
    return ((c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
  }

  // ---------------- timing helpers ----------------
  function toSec(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    const t = v.trim();
    if (/^\d+(\.\d+)?s?$/.test(t)) return parseFloat(t);
    const p = t.split(':').map(Number);
    return p.some(isNaN) ? NaN : p.reduce((a, x) => a * 60 + x, 0);
  }
  function normalizeLines(lines, start, end) {
    const parsed = (lines || []).map(l => ({ s: toSec(l.start), e: toSec(l.end), ar: String(l.ar || '').trim(), en: String(l.en || '').trim() }))
      .filter(l => isFinite(l.s) && (l.ar || l.en));
    const len = end - start;
    const inAbs = parsed.filter(l => l.s >= start - 5 && l.s <= end + 5).length;
    const inRel = parsed.filter(l => l.s >= -1 && l.s <= len + 5).length;
    const off = start > 0 && inRel > inAbs ? start : 0;
    return parsed.map(l => {
      let s = l.s + off, e = isFinite(l.e) ? l.e + off : s + 3;
      if (!(e > s)) e = s + 2;
      s = Math.max(start, Math.min(s, end));
      e = Math.min(Math.max(e, s + 0.6), end + 2);
      return { s, e, ar: l.ar, en: l.en };
    });
  }

  // ---------------- current video state ----------------
  let V = null;   // { id, title, duration, part, total, segs[], done:Set, dialect, ... }
  let player = null, playerReady = false, gen = 0;

  function mergeLines(newSegs, start, end) {
    const a = V.segs.filter(x => x.s < start || x.s >= end).concat(newSegs);
    a.sort((x, y) => x.s - y.s);
    for (let i = 0; i < a.length - 1; i++) if (a[i].e > a[i + 1].s) a[i].e = Math.max(a[i].s + 0.3, a[i + 1].s);
    V.segs = a;
  }
  function findSeg(t) {
    const a = V ? V.segs : []; let lo = 0, hi = a.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < a[m].s) hi = m - 1; else if (t >= a[m].e) lo = m + 1; else return m;
    }
    return -1;
  }
  async function saveVideo() {
    if (!V) return;
    await dbPut({
      id: V.id, title: V.title, duration: V.duration, part: V.part, total: V.total,
      done: [...V.done], segs: V.segs, dialect: V.dialect, savedAt: Date.now()
    });
  }

  // ---------------- dialect chip ----------------
  const RANK = { high: 3, medium: 2, low: 1 };
  function showDialect() {
    const el = $('dialectChip');
    if (!V || (!V.dialect && !V.running)) { el.hidden = true; return; }
    el.hidden = false;
    if (!V.dialect) { el.textContent = 'Dialect: detecting…'; el.title = ''; return; }
    const d = YTDS_DIALECTS[V.dialect.dialect];
    el.innerHTML = '';
    el.append(`Dialect: ${d ? d.label : V.dialect.dialect} `);
    if (d) { const s = document.createElement('span'); s.className = 'ar'; s.textContent = '· ' + d.ar; el.append(s); }
    if (V.dialect.confidence) el.append(` (${V.dialect.confidence})`);
    el.title = (V.dialect.evidence || []).join('\n');
  }
  function updateDialect(d) {
    const rank = c => RANK[String(c || '').toLowerCase()] || 0;
    if (!V.dialect || rank(d.confidence) > rank(V.dialect.confidence)) {
      V.dialect = { dialect: d.dialect, confidence: d.confidence, evidence: d.evidence || [] };
    } else if (V.dialect.dialect === d.dialect) {
      V.dialect.evidence = Array.from(new Set((V.dialect.evidence || []).concat(d.evidence || []))).slice(0, 6);
    }
    showDialect();
  }

  // ---------------- translate / stop ----------------
  function setGo(state) {
    const b = $('goBtn');
    V && (V.btn = state);
    b.hidden = state === 'hidden';
    b.disabled = state === 'stopping';
    b.classList.toggle('stop', state === 'stop' || state === 'stopping');
    b.textContent = { translate: '▶ Translate', continue: '▶ Continue translating', retry: '↻ Try again', stop: '■ Stop', stopping: 'Stopping…' }[state] || '';
  }
  $('goBtn').addEventListener('click', () => {
    if (!V) return;
    if (V.btn === 'stop') return stopRun();
    if (['translate', 'continue', 'retry'].includes(V.btn)) startRun();
  });

  const range = i => `${fmt(i * V.part)}–${fmt(Math.min(V.duration, (i + 1) * V.part))}`;
  const lookahead = () => Math.max(1, Math.round(900 / V.part));

  function nextPart() {
    const t = playerTime();
    const cur = Math.min(V.total - 1, Math.floor(t / V.part));
    const last = Math.min(V.total - 1, cur + lookahead());
    for (let i = cur; i <= last; i++) {
      if (!V.done.has(i) && !V.inFlight.has(i) && (V.tries.get(i) || 0) < MAX_TRIES) return i;
    }
    return null;
  }

  function progressStatus() {
    if (!V || !V.running || V.stopped || V.fatal) return;
    if (V.pausedUntil > Date.now()) {
      const secs = Math.ceil((V.pausedUntil - Date.now()) / 1000);
      setStatus(V.pauseReason === 'busy'
        ? `Gemini is busy (high demand) — retrying in ${secs}s · ${V.done.size}/${V.total} parts ready`
        : `Free-tier speed limit — continuing in ${secs}s · ${V.done.size}/${V.total} parts ready`, 'warn');
      return;
    }
    if (V.inFlight.size) {
      const list = [...V.inFlight].sort((a, b) => a - b);
      const secs = Math.round((Date.now() - (V.startedAt.get(list[0]) || Date.now())) / 1000);
      const el = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const expect = V.part <= 330 ? '30–60 s' : V.part <= 630 ? '1–2 min' : '2–3 min';
      if (!V.done.size) setStatus(`${secs < 3 ? 'Step 1/2 · Sending video to Gemini' : 'Step 2/2 · Gemini is listening & translating'} ${range(list[0])} · ${el} (usually ${expect})`);
      else setStatus(`Preparing ${list.map(range).join(', ')} · ${el} · ${V.done.size}/${V.total} parts ready`);
    } else if (V.done.size === V.total) {
      setStatus('✓ All subtitles ready');
    } else {
      setStatus(`Ready ahead ✓ · ${V.done.size}/${V.total} parts · keeps preparing as you watch`);
    }
  }

  async function processPart(g, i) {
    const start = Math.floor(i * V.part), end = Math.ceil(Math.min(V.duration, (i + 1) * V.part));
    const prev = V.segs.filter(s => s.e <= start).slice(-5).map(s => ({ ar: s.ar, en: s.en }));
    const user = ytdsBuildAudioUser({ meta: { title: V.title }, glossary: settings.glossary, start, end, dialectInfo: V.dialect, prev });
    const model = V.fallbackUntil > Date.now() ? FALLBACK_MODEL : modelId();
    try {
      const text = await geminiVideo({ model, videoId: V.id, start, end, system: ytdsBuildAudioPrompt(), user, maxTokens: V.part > 330 ? 32000 : 16000 });
      if (g !== gen) return;
      const data = parseJson(text);
      mergeLines(normalizeLines(data.lines, start, end), start, end);
      if (data.dialect && YTDS_DIALECTS[data.dialect]) updateDialect(data);
      const first = V.done.size === 0;
      V.done.add(i);
      V.lastError = null;
      renderTranscript();
      if (first) toast(`Subtitles ready for ${range(i)}`);
      await saveVideo();
    } catch (e) {
      if (g !== gen) return;
      const msg = String(e && e.message || e);
      const rl = rateLimitInfo(msg);
      if (rl && rl.daily) {
        V.fatal = true;
        setStatus(rl.noAccess ? friendlyError(msg)
          : `Daily free limit used up — resumes after ${new Date(Date.now() + rl.waitMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Saved parts stay on this phone.`, 'err');
        return;
      }
      if (rl) { V.single = true; V.pauseReason = 'limit'; V.pausedUntil = Math.max(V.pausedUntil, Date.now() + rl.waitMs); return; }
      if (/HTTP 50[0-4]|overloaded|high demand|UNAVAILABLE|try again later|Failed to fetch|NetworkError/i.test(msg)) {
        const n = (V.busy.get(i) || 0) + 1; V.busy.set(i, n);
        V.pauseReason = 'busy';
        V.pausedUntil = Math.max(V.pausedUntil, Date.now() + Math.min(60000, 10000 * n));
        if (n >= 3 && settings.busyFallback && modelId() !== FALLBACK_MODEL && !(V.fallbackUntil > Date.now())) {
          V.fallbackUntil = Date.now() + 10 * 60000; V.pausedUntil = Date.now() + 2000;
          toast('Gemini is overloaded — using Flash-Lite as backup for 10 min');
        }
        if (n >= 10) V.tries.set(i, MAX_TRIES);
        return;
      }
      if (/API key|HTTP 401|HTTP 403|HTTP 404|not found/i.test(msg)) { V.fatal = true; setStatus(friendlyError(msg), 'err'); return; }
      V.tries.set(i, (V.tries.get(i) || 0) + 1);
      V.lastError = friendlyError(msg);
      setStatus('A part failed, retrying: ' + V.lastError, 'warn');
      await sleep(1500);
    }
  }

  async function worker(g, w) {
    try {
      while (g === gen && V && !V.fatal && !V.stopped) {
        if (V.done.size === V.total) return;
        if (w > 0 && V.single) return;
        if (V.pausedUntil > Date.now()) { await sleep(1000); continue; }
        const i = nextPart();
        if (i === null) { await sleep(2000); continue; }
        V.inFlight.add(i); V.startedAt.set(i, Date.now());
        await processPart(g, i);
        if (g !== gen || !V) return;
        V.inFlight.delete(i);
      }
    } finally {
      if (g === gen && V && --V.running <= 0) onIdle();
    }
  }

  function onIdle() {
    V.running = 0;
    showDialect();
    if (V.done.size === V.total) { setGo('hidden'); setStatus('✓ All subtitles ready — saved on this phone'); return; }
    if (V.fatal) { setGo('retry'); return; }
    if (V.stopped) { setStatus(`Stopped — ${V.done.size}/${V.total} parts saved`); setGo('continue'); return; }
    setGo('retry');
  }

  function startRun() {
    if (!settings.key) { openSettings(); toast('Add your Gemini API key first'); return; }
    if (!V || V.running) return;
    if (!V.total) { toast('The video is still loading — try again in a moment'); return; }
    Object.assign(V, { stopped: false, fatal: false, single: false, pausedUntil: 0, lastError: null, running: WORKERS });
    V.tries = new Map(); V.busy = new Map(); V.inFlight = new Set(); V.startedAt = new Map();
    setGo('stop');
    showDialect();
    setStatus('Step 1/2 · Sending video to Gemini…');
    const g = gen;
    for (let w = 0; w < WORKERS; w++) worker(g, w);
  }
  function stopRun() {
    V.stopped = true;
    if (V.inFlight.size) { setGo('stopping'); setStatus('Stopping after the current part finishes (so nothing is wasted)…'); }
  }

  // ---------------- player (official YouTube embed) ----------------
  function loadYT() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    return new Promise(res => {
      window.onYouTubeIframeAPIReady = res;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.append(s);
    });
  }
  function playerTime() { try { return playerReady ? player.getCurrentTime() || 0 : 0; } catch (e) { return 0; } }

  async function openVideo(id) {
    gen++;
    const g = gen;
    location.hash = 'v=' + id;
    $('home').hidden = true; $('watch').hidden = false; $('backBtn').hidden = false;
    document.body.classList.add('watching');
    setStatus('Loading video…'); setGo('hidden'); $('now').innerHTML = ''; $('lines').innerHTML = '';
    $('dialectChip').hidden = true;

    const saved = await dbGet(id);
    V = {
      id, title: saved ? saved.title : '', duration: saved ? saved.duration : 0,
      part: partSec(), total: 0, segs: saved ? saved.segs || [] : [], done: new Set(),
      dialect: saved ? saved.dialect : null, running: 0, inFlight: new Set(), tries: new Map(), busy: new Map(),
      startedAt: new Map(), pausedUntil: 0, savedPart: saved ? saved.part : 0, savedDone: saved ? saved.done || [] : []
    };
    renderTranscript(); showDialect();

    await loadYT();
    if (g !== gen) return;
    playerReady = false;
    if (player) { try { player.destroy(); } catch (e) {} }
    $('stage').querySelector('#player') || $('stage').prepend(Object.assign(document.createElement('div'), { id: 'player' }));
    player = new YT.Player('player', {
      videoId: id,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 0, origin: location.origin },
      events: {
        onReady: () => { playerReady = true; try { player.setPlaybackRate(settings.speed || 1); } catch (e) {} afterReady(g); },
        onError: ev => {
          if (ev.data === 101 || ev.data === 150) setStatus('The owner doesn\'t allow this video to play inside other apps. Subtitles can still be made, but watch it in YouTube.', 'err');
          else setStatus('This video can\'t be played here (error ' + ev.data + ').', 'err');
        }
      }
    });
  }

  async function afterReady(g) {
    // duration is known once metadata loads
    for (let t = 0; t < 40 && g === gen; t++) {
      const d = player.getDuration && player.getDuration();
      if (d > 0) { V.duration = d; break; }
      await sleep(250);
    }
    if (g !== gen) return;
    try { const vd = player.getVideoData(); if (vd && vd.title) V.title = vd.title; } catch (e) {}
    if (!V.duration) { setStatus('Press play once to load the video length.', 'warn'); await waitFor(() => player.getDuration() > 0, 120000); V.duration = player.getDuration(); }
    if (g !== gen || !V.duration) return;

    V.total = Math.ceil(V.duration / V.part);
    // restore saved parts (also when the part length setting changed)
    const oldPart = V.savedPart || V.part, oldDone = new Set(V.savedDone);
    for (let i = 0; i < V.total; i++) {
      const a = i * V.part, b = Math.min(V.duration, (i + 1) * V.part);
      let ok = oldDone.size > 0;
      for (let j = Math.floor(a / oldPart); ok && j * oldPart < b; j++) if (!oldDone.has(j)) ok = false;
      if (ok) V.done.add(i);
    }
    if (V.done.size === V.total) { setGo('hidden'); setStatus('✓ Saved subtitles loaded — no internet needed for them'); }
    else if (V.done.size) { setGo('continue'); setStatus(`${V.done.size}/${V.total} parts saved on this phone`); }
    else { setGo('translate'); setStatus(settings.key ? 'Tap Translate to start. Nothing is sent until you do.' : 'Add your Gemini API key in Settings, then tap Translate.', settings.key ? '' : 'warn'); }
    showDialect();
    if (V.title || V.done.size) saveVideo();
  }
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (fn()) return true; } catch (e) {} await sleep(500); }
    return false;
  }

  // ---------------- rendering ----------------
  const hasArabic = t => /[\u0600-\u06FF]/.test(t || '');
  const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '');
  // Arabic line is hidden when the speaker spoke English (it would just repeat the English line)
  const arFor = s => (settings.showArabic && s.ar && (hasArabic(s.ar) || norm(s.ar) !== norm(s.en))) ? s.ar : '';
  let lastSig = '', lastCur = -1;
  function renderNow() {
    if (!V || $('watch').hidden) return;
    const t = playerTime();
    const idx = findSeg(t);
    let seg = idx >= 0 ? V.segs[idx] : null;
    // between two lines (short pause / video paused): keep showing the last line for up to 4 s
    if (!seg && V.segs.length) {
      let lo = 0, hi = V.segs.length - 1, p = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (V.segs[m].s <= t) { p = m; lo = m + 1; } else hi = m - 1; }
      if (p >= 0 && t - V.segs[p].e <= 4) seg = V.segs[p];
    }
    let waiting = '', idle = '';
    if (!seg && V.total) {
      const p = Math.min(V.total - 1, Math.floor(t / V.part));
      if (!V.done.has(p) && V.running) waiting = V.pausedUntil > Date.now()
        ? (V.pauseReason === 'busy' ? '⏳ Gemini is busy — retrying shortly…' : '⏳ Waiting for the free-tier limit…')
        : '⏳ Preparing subtitles for this part…';
      else if (!seg) idle = V.done.has(p) ? '· · ·' : 'This part isn\'t translated yet — tap “Continue translating”.';
    }
    const sig = waiting || (seg ? `${seg.s}|${seg.ar}|${seg.en}|${settings.showArabic}` : 'idle|' + idle);
    if (sig !== lastSig) {
      lastSig = sig;
      const now = $('now'), ov = $('ovBox');
      now.innerHTML = ''; ov.innerHTML = '';
      now.classList.toggle('idle', !seg && !waiting);
      if (waiting || (!seg && idle)) {
        now.append(Object.assign(document.createElement('div'), { className: 'w', textContent: waiting || idle }));
      } else if (seg) {
        for (const box of [now, ov]) {
          const ar = arFor(seg);
          if (ar) box.append(Object.assign(document.createElement('div'), { className: 'a', textContent: ar }));
          if (seg.en) box.append(Object.assign(document.createElement('div'), { className: 'e', textContent: seg.en }));
        }
      }
    }
    if (idx !== lastCur) {
      const old = $('lines').querySelector('.ln.cur'); if (old) old.classList.remove('cur');
      const el = idx >= 0 ? $('lines').querySelector(`[data-i="${idx}"]`) : null;
      if (el) {
        el.classList.add('cur');
        const box = $('lines'), b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (autoFollow && (r.top < b.top + 2 || r.bottom > b.bottom - 2)) {
          box.scrollBy({ top: r.top - b.top - 8, behavior: 'smooth' });
        }
      }
      lastCur = idx;
    }
  }
  let autoFollow = true, followT = null;
  ['touchstart', 'wheel'].forEach(ev => $('lines').addEventListener(ev, () => {
    autoFollow = false; clearTimeout(followT); followT = setTimeout(() => { autoFollow = true; }, 8000);
  }, { passive: true }));
  // ---------------- playback controls (built for listening practice) ----------------
  const isPlaying = () => { try { return playerReady && player.getPlayerState() === 1; } catch (e) { return false; } };
  function togglePlay() {
    if (!playerReady) return;
    if (isPlaying()) player.pauseVideo();
    else {
      // after a learning-mode pause, ▶ continues into the next line; otherwise the current line still pauses at its end
      const i = findSeg(playerTime());
      learnStopAt = null; learnLastIdx = (i >= 0 && i === autoPausedIdx) ? i : -1; autoPausedIdx = -1;
      player.playVideo();
    }
  }
  // the line being heard now, or the last one before this moment
  function currentIndex() {
    if (!V || !V.segs.length) return -1;
    const t = playerTime();
    const i = findSeg(t);
    if (i >= 0) return i;
    let lo = 0, hi = V.segs.length - 1, p = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (V.segs[m].s <= t) { p = m; lo = m + 1; } else hi = m - 1; }
    return p;
  }
  function playLine(i) {
    if (!playerReady || !V || i < 0 || i >= V.segs.length) return;
    player.seekTo(Math.max(0, V.segs[i].s - 0.15), true);
    learnStopAt = null; learnLastIdx = -1;     // stop again at the end of the line being replayed
    player.playVideo();
  }
  $('pcPlay').addEventListener('click', togglePlay);
  $('now').addEventListener('click', togglePlay);
  $('pcRepeat').addEventListener('click', () => playLine(Math.max(0, currentIndex())));
  $('pcPrev').addEventListener('click', () => {
    const i = currentIndex(), t = playerTime();
    // if we're well into a line, "previous" first goes back to its start (like a music player)
    playLine(i >= 0 && t - V.segs[i].s > 2 ? i : i - 1);
  });
  $('pcNext').addEventListener('click', () => {
    const i = currentIndex();
    if (V && V.segs.length) playLine(i + 1 < V.segs.length ? i + 1 : i);
  });
  const SPEEDS = [1, 0.75, 0.5, 1.25];
  function showSpeed() { $('pcSpeed').textContent = (settings.speed || 1) + '×'; }
  $('pcSpeed').addEventListener('click', () => {
    const next = SPEEDS[(SPEEDS.indexOf(settings.speed || 1) + 1) % SPEEDS.length];
    settings.speed = next; saveSettings(); showSpeed();
    try { player.setPlaybackRate(next); } catch (e) {}
    toast(`Speed ${next}×`);
  });
  $('pcLearn').checked = !!settings.learnMode;
  $('pcLearn').addEventListener('change', e => {
    settings.learnMode = e.target.checked; saveSettings(); learnStopAt = null;
    toast(settings.learnMode ? 'Learning mode: pauses after each line — tap ▶ or the card to continue' : 'Learning mode off');
  });
  showSpeed();

  // learning mode: pause at the end of each line
  let learnStopAt = null, learnLastIdx = -1, autoPausedIdx = -1;
  function learnTick() {
    if (!settings.learnMode || !V || !isPlaying()) return;
    const t = playerTime(), i = findSeg(t);
    if (i >= 0 && i !== learnLastIdx) { learnLastIdx = i; learnStopAt = V.segs[i].e; }
    if (learnStopAt != null && t >= learnStopAt - 0.08) { learnStopAt = null; autoPausedIdx = learnLastIdx; player.pauseVideo(); }
  }

  // keyboard / Bluetooth keyboard: Space play-pause, ←/→ lines, R repeat
  document.addEventListener('keydown', e => {
    if ($('watch').hidden || e.target.closest('input, textarea, select, dialog')) return;
    if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') $('pcPrev').click();
    else if (e.key === 'ArrowRight') $('pcNext').click();
    else if (e.key === 'r' || e.key === 'R') $('pcRepeat').click();
  });

  setInterval(() => {
    learnTick();
    $('pcPlay').classList.toggle('playing', isPlaying());
    $('pcPlay').setAttribute('aria-label', isPlaying() ? 'Pause' : 'Play');
  }, 100);
  setInterval(() => { renderNow(); progressStatus(); }, 250);

  function renderTranscript() {
    const box = $('lines');
    box.innerHTML = '';
    lastCur = -1; lastSig = '';
    if (!V || !V.segs.length) {
      box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'The transcript appears here as each part is translated. Tap a line to jump to it.' }));
      $('cacheHint').textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    V.segs.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'ln'; b.type = 'button'; b.dataset.i = i;
      const ts = Object.assign(document.createElement('span'), { className: 'ts', textContent: fmt(s.s) });
      const tx = Object.assign(document.createElement('span'), { className: 'tx' });
      const ar = arFor(s);
      if (ar) tx.append(Object.assign(document.createElement('span'), { className: 'a', textContent: ar }));
      if (s.en) tx.append(Object.assign(document.createElement('span'), { className: 'e', textContent: s.en }));
      b.append(ts, tx);
      b.addEventListener('click', () => { if (playerReady) { player.seekTo(s.s, true); player.playVideo(); } });
      frag.append(b);
    });
    box.append(frag);
    $('cacheHint').textContent = `${V.segs.length} lines saved on this phone.`;
  }

  function transcriptText() {
    if (!V) return '';
    const d = V.dialect && YTDS_DIALECTS[V.dialect.dialect];
    const head = [`${V.title || 'YouTube video'}`, `https://youtu.be/${V.id}`, d ? `Dialect: ${d.label} (${d.ar})` : '', ''].filter((x, i) => x || i === 3);
    return head.join('\n') + V.segs.map(s => `[${fmt(s.s)}]\n${s.ar}\n${s.en}\n`).join('\n');
  }
  $('copyBtn').addEventListener('click', async () => {
    if (!V || !V.segs.length) return toast('Nothing to copy yet');
    try { await navigator.clipboard.writeText(transcriptText()); toast('Transcript copied'); }
    catch (e) { toast('Copy not allowed here — use Save .txt'); }
  });
  $('saveBtn').addEventListener('click', () => {
    if (!V || !V.segs.length) return toast('Nothing to save yet');
    const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(V.title || V.id).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)} - Arabic English.txt`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  // full screen: video + subtitles together, landscape on phones
  $('fsBtn').addEventListener('click', async () => {
    const st = $('stage');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await (st.requestFullscreen ? st.requestFullscreen() : st.webkitRequestFullscreen());
        try { await screen.orientation.lock('landscape'); } catch (e) {}
      }
    } catch (e) { toast('Full screen is not available here'); }
  });

  // ---------------- home ----------------
  async function renderRecent() {
    const list = (await dbAll()).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const box = $('recent'); box.innerHTML = '';
    if (!list.length) {
      box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Videos you translate appear here, with their subtitles saved on this phone.' }));
      return;
    }
    for (const r of list) {
      const b = document.createElement('button'); b.className = 'item'; b.type = 'button';
      const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
      img.src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
      const info = document.createElement('div'); info.style.minWidth = '0';
      info.append(Object.assign(document.createElement('div'), { className: 't', textContent: r.title || r.id }));
      const m = document.createElement('div'); m.className = 'm';
      const d = r.dialect && YTDS_DIALECTS[r.dialect.dialect];
      if (d) m.append(Object.assign(document.createElement('span'), { textContent: d.label }));
      if (r.total) m.append(Object.assign(document.createElement('span'), { textContent: `${(r.done || []).length}/${r.total} parts` }));
      if (r.duration) m.append(Object.assign(document.createElement('span'), { textContent: fmt(r.duration) }));
      info.append(m);
      b.append(img, info);
      b.addEventListener('click', () => openVideo(r.id));
      box.append(b);
    }
  }

  function goHome() {
    gen++;
    if (V && V.running) V.stopped = true;
    V = null;
    try { player && player.pauseVideo(); } catch (e) {}
    $('watch').hidden = true; $('home').hidden = false; $('backBtn').hidden = true;
    document.body.classList.remove('watching');
    history.replaceState(null, '', location.pathname);
    $('keyWarn').hidden = !!settings.key;
    renderRecent();
  }
  $('backBtn').addEventListener('click', goHome);
  $('openForm').addEventListener('submit', e => {
    e.preventDefault();
    const id = videoIdFrom($('urlInput').value);
    if (!id) return toast('That doesn\'t look like a YouTube link');
    $('urlInput').value = '';
    openVideo(id);
  });

  // ---------------- settings ----------------
  function partHint() {
    const m = Number($('sPart').value), h = 20 * m / 60;
    $('sPartHint').textContent = `Free tier (about 20 requests/day on 3.6 Flash) ≈ ${h % 1 ? h.toFixed(1) : h} h of video per day.`;
  }
  async function openSettings() {
    $('sKey').value = settings.key; $('sModel').value = settings.model; $('sCustom').value = settings.custom;
    $('sPart').value = String(settings.partMinutes); $('sFallback').checked = settings.busyFallback;
    $('sGloss').value = settings.glossary; $('sFont').value = settings.fontScale; $('sShowAr').checked = settings.showArabic;
    partHint();
    try {
      const est = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      $('storeHint').textContent = `App version ${APP_VERSION} · Saved on this phone: ${((est.usage || 0) / 1048576).toFixed(1)} MB${persisted ? ' · protected from automatic cleanup' : ''}`;
    } catch (e) { $('storeHint').textContent = `App version ${APP_VERSION}`; }
    $('settings').showModal();
  }
  $('sPart').addEventListener('change', partHint);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsForm').addEventListener('submit', () => {
    const oldPart = settings.partMinutes;
    settings = Object.assign(settings, {
      key: $('sKey').value.trim(), model: $('sModel').value, custom: $('sCustom').value.trim(),
      partMinutes: Number($('sPart').value), busyFallback: $('sFallback').checked,
      glossary: $('sGloss').value, fontScale: Number($('sFont').value), showArabic: $('sShowAr').checked
    });
    saveSettings(); applyFont();
    $('keyWarn').hidden = !!settings.key;
    toast('Settings saved');
    if (V) {
      renderTranscript();
      if (oldPart !== settings.partMinutes && !V.running) openVideo(V.id);
      else if (!V.running && V.total && V.done.size < V.total) {
        setGo(V.done.size ? 'continue' : 'translate');
        setStatus(settings.key ? 'Tap Translate to start.' : 'Add your Gemini API key in Settings, then tap Translate.', settings.key ? '' : 'warn');
      }
    }
  });
  $('clearAll').addEventListener('click', async () => {
    const b = $('clearAll');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete everything'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Delete all saved subtitles'; }, 4000); return; }
    await dbDel(null);
    b.dataset.armed = ''; b.textContent = 'Delete all saved subtitles';
    $('settings').close(); toast('All saved subtitles deleted');
    if (V) openVideo(V.id); else renderRecent();
  });
  function applyFont() { document.documentElement.style.setProperty('--fs', settings.fontScale); }
  function bumpFont(d) {
    const v = Math.round(Math.min(1.8, Math.max(0.8, (Number(settings.fontScale) || 1) + d)) * 10) / 10;
    settings.fontScale = v; saveSettings(); applyFont();
    toast(`Text size ${Math.round(v * 100)}%`);
  }
  $('fsDown').addEventListener('click', () => bumpFont(-0.1));
  $('fsUp').addEventListener('click', () => bumpFont(0.1));

  // ---------------- no zoom: block pinch and double-tap zoom (iOS ignores user-scalable=no) ----------------
  ['gesturestart', 'gesturechange'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let lastTap = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    // buttons/controls already ignore double-tap zoom (touch-action: manipulation) — never swallow their taps
    if (now - lastTap < 300 && !e.target.closest('button, a, input, textarea, select, label, .now, .ln, iframe')) e.preventDefault();
    lastTap = now;
  }, { passive: false });

  // ---------------- start ----------------
  applyFont();
  $('keyWarn').hidden = !!settings.key;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // opened from "Share → Lahja" (Web Share Target) or a link with #v=ID
  const qs = new URLSearchParams(location.search);
  const shared = videoIdFrom([qs.get('url'), qs.get('text'), qs.get('title')].filter(Boolean).join(' '));
  const fromHash = (location.hash.match(/v=([A-Za-z0-9_-]{11})/) || [])[1];
  window.addEventListener('hashchange', () => {
    const id = (location.hash.match(/v=([A-Za-z0-9_-]{11})/) || [])[1];
    if (id && (!V || V.id !== id)) openVideo(id);
  });
  if (shared) { history.replaceState(null, '', location.pathname); openVideo(shared); }
  else if (fromHash) openVideo(fromHash);
  else renderRecent();
})();
