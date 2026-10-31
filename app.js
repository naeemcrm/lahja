// Lahja — Arabic dialect → English subtitles for YouTube (phone web app).
// Gemini listens to the video in parts, detects the dialect, transcribes the Arabic as spoken
// and translates it. Everything is saved on this phone (IndexedDB) so rewatching is free.
(() => {
  'use strict';
  const APP_VERSION = '2.4';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------------- settings (this phone only) ----------------
  const DEFAULTS = {
    key: '', backupKey: '', freeOutUntil: 0, model: 'gemini-3.6-flash', custom: '', partMinutes: 10,
    busyFallback: true, glossary: '', fontScale: 1, showArabic: true, learnMode: false, speed: 1, lefty: false, smallVideo: false, thinking: 'minimal'
  };
  const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  const WORKERS = 2, MAX_TRIES = 3;
  const GAP_MIN = 45, GAP_CHUNK = 360;   // a stretch of 45 s+ with no subtitles inside a translated part is re-asked in ≤6-min pieces
  let settings = loadSettings();
  function loadSettings() {
    try {
      const s = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('lahja.settings') || '{}'));
      if (!s.thinkV2) { s.thinking = 'minimal'; s.thinkV2 = true; }   // one-time move from the old 'low' default
      return s;
    }
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
  // Two keys: the free key is used first; the paid backup key only while the free daily quota is used up.
  const usingBackup = () => !!settings.backupKey && (!settings.key || settings.freeOutUntil > Date.now());
  const activeKey = () => usingBackup() ? settings.backupKey : settings.key;

  function loadUsage() { try { return JSON.parse(localStorage.getItem('lahja.usage') || 'null'); } catch (e) { return null; } }
  function renderUsage() {
    const box = $('sUsage'); box.innerHTML = '';
    const rep = usageReport(loadUsage(), { hasFree: !!settings.key, hasPaid: !!settings.backupKey, freeOutUntil: settings.freeOutUntil });
    if (!rep.length) return;
    const u = usageFresh(loadUsage());
    for (const r of rep) {
      const d = document.createElement('div'); d.className = 'u';
      d.append(Object.assign(document.createElement('b'), { textContent: r.title }));
      if (r.title.includes('Free')) {
        const pct = settings.freeOutUntil > Date.now() ? 100 : Math.min(100, Math.round(u.today.free.req / USAGE_FREE_PER_DAY * 100));
        const m = document.createElement('div'); m.className = 'meter'; m.innerHTML = `<i style="width:${pct}%"></i>`; d.append(m);
      }
      for (const l of r.lines) d.append(Object.assign(document.createElement('div'), { textContent: l }));
      box.append(d);
    }
    box.append(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Counted on this phone only (the Chrome extension counts separately). Cost is an estimate at Gemini 3.6 Flash prices — exact bill: AI Studio → Billing.' }));
  }

  async function geminiVideo({ model, videoId, start, end, system, user, maxTokens }) {
    const apiKey = activeKey();
    if (!apiKey) throw new Error('API key missing');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    // lean: drop the cost-saving video options; noThink: drop the thinking level (for models that reject it)
    const body = (lean, noThink) => {
      const gc = Object.assign({ maxOutputTokens: maxTokens, temperature: 0.2, responseMimeType: 'application/json' },
        lean ? {} : { mediaResolution: 'MEDIA_RESOLUTION_LOW' });
      if (!noThink && settings.thinking && settings.thinking !== 'default') gc.thinkingConfig = { thinkingLevel: settings.thinking };
      return JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [
          { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
            videoMetadata: Object.assign({ startOffset: `${start}s`, endOffset: `${end}s` }, lean ? {} : { fps: 0.2 }) },
          { text: user }
        ] }],
        generationConfig: gc
      });
    };
    const send = async (lean, noThink) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: body(lean, noThink) });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) {
        const e = j && j.error;
        const err = new Error(`HTTP ${r.status}${e && e.message ? ': ' + e.message : ''}`);
        err.freeKey = apiKey === settings.key && apiKey !== settings.backupKey;
        throw err;
      }
      return j || {};
    };
    let j, lean = false, noThink = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { j = await send(lean, noThink); break; }
      catch (e) {
        if (!/HTTP 400/.test(e.message)) throw e;
        if (!noThink && /think/i.test(e.message)) { noThink = true; continue; }
        if (!lean && /fps|media.?resolution|video.?metadata|unknown name/i.test(e.message)) { lean = true; continue; }
        throw e;
      }
    }
    // count this request on this phone (free vs paid key) for the usage panel in Settings
    try {
      const kind = (apiKey === settings.backupKey && apiKey !== settings.key) ? 'paid' : 'free';
      localStorage.setItem('lahja.usage', JSON.stringify(usageAdd(loadUsage(), kind, j.usageMetadata)));
    } catch (e) {}
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
  let ytState = -1, ytStateAt = 0, lastT = 0, movingUntil = 0;   // play-state tracking

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
      done: [...V.done], segs: V.segs, dialect: V.dialect, sync: V.sync, gapChecked: V.gapChecked || [], savedAt: Date.now()
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

  // ---- missing stretches ("gaps"): Gemini sometimes skips minutes inside a part; find and re-ask just those ----
  function holes(A, B) {
    const out = []; let prev = A;
    for (const s of V.segs) {
      if (s.e <= A) continue;
      if (s.s >= B) break;
      if (s.s - prev > GAP_MIN) out.push([prev, s.s]);
      prev = Math.max(prev, s.e);
    }
    if (B - prev > GAP_MIN) out.push([prev, B]);
    return out;
  }
  function computeGaps() {
    if (!V || !V.total || !V.duration) return [];
    const raw = [];
    for (let i = 0; i < V.total; i++) {
      if (!V.done.has(i)) continue;
      let j = i; while (j + 1 < V.total && V.done.has(j + 1)) j++;
      raw.push(...holes(i * V.part, Math.min(V.duration, (j + 1) * V.part)));
      i = j;
    }
    const res = [];
    for (const [a, b] of raw) {
      // leave out stretches already re-checked (silence, music) so they're never asked twice
      let pieces = [[a, b]];
      for (const [ca, cb] of V.gapChecked || []) {
        pieces = pieces.flatMap(([x, y]) => (cb <= x || ca >= y) ? [[x, y]] : [[x, Math.max(x, ca)], [Math.min(y, cb), y]].filter(([p, q]) => q - p > 1));
      }
      for (const [x, y] of pieces) {
        if (y - x <= GAP_MIN) continue;
        const n = Math.ceil((y - x) / GAP_CHUNK), size = (y - x) / n;
        for (let k = 0; k < n; k++) res.push([x + k * size, x + (k + 1) * size]);
      }
    }
    return res;
  }
  const gapJobs = () => computeGaps().map(([a, b]) => ({ kind: 'gap', a, b, key: 'g' + Math.round(a) }))
    .filter(j => (V.tries.get(j.key) || 0) < MAX_TRIES);
  function nextJob() {
    const t = subTime();
    const gaps = gapJobs().filter(j => !V.inFlight.has(j.key));
    const here = gaps.find(j => j.a <= t + 30 && j.b > t);        // the stretch you're watching right now comes first
    if (here) return here;
    const i = nextPart();
    if (i !== null) return { kind: 'part', i, key: i };
    return gaps.find(j => j.a > t) || gaps[0] || null;            // then the ones ahead, then earlier ones
  }
  const jobLabel = k => { const j = V.jobs.get(k); return j && j.kind === 'gap' ? `missing ${fmt(j.a)}–${fmt(j.b)}` : range(k); };

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
      const list = [...V.inFlight];
      const secs = Math.round((Date.now() - (V.startedAt.get(list[0]) || Date.now())) / 1000);
      const el = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const expect = V.part <= 330 ? '30–60 s' : V.part <= 630 ? '1–2 min' : '2–3 min';
      const fu = (usageFresh(loadUsage()).today.free.req);
      const k = settings.backupKey ? (usingBackup() ? ' · 💳 paid key' : ` · 🆓 free key ${fu}/${USAGE_FREE_PER_DAY}`) : '';
      if (!V.done.size) setStatus(`${secs < 3 ? 'Step 1/2 · Sending video to Gemini' : 'Step 2/2 · Gemini is listening & translating'} ${jobLabel(list[0])} · ${el} (usually ${expect})${k}`);
      else setStatus(`Preparing ${list.map(jobLabel).join(', ')} · ${el} · ${V.done.size}/${V.total} parts ready${k}`);
    } else if (V.done.size === V.total) {
      const n = gapJobs().length;
      setStatus(n ? `Filling ${n} missing stretch${n > 1 ? 'es' : ''} in the background…` : '✓ All subtitles ready');
    } else {
      setStatus(`Ready ahead ✓ · ${V.done.size}/${V.total} parts · keeps preparing as you watch`);
    }
  }

  async function processJob(g, job) {
    const isGap = job.kind === 'gap', i = job.key;
    const start = isGap ? Math.max(0, Math.floor(job.a - 2)) : Math.floor(job.i * V.part);
    const end = isGap ? Math.ceil(Math.min(V.duration, job.b + 2)) : Math.ceil(Math.min(V.duration, (job.i + 1) * V.part));
    const prev = V.segs.filter(s => s.e <= start).slice(-5).map(s => ({ ar: s.ar, en: s.en }));
    const user = ytdsBuildAudioUser({ meta: { title: V.title }, glossary: settings.glossary, start, end, dialectInfo: V.dialect, prev });
    const model = V.fallbackUntil > Date.now() ? FALLBACK_MODEL : modelId();
    try {
      const text = await geminiVideo({ model, videoId: V.id, start, end, system: ytdsBuildAudioPrompt(), user, maxTokens: end - start > 330 ? 32000 : 16000 });
      if (g !== gen) return;
      const data = parseJson(text);
      if (data.dialect && YTDS_DIALECTS[data.dialect]) updateDialect(data);
      if (isGap) {
        // only add lines inside the empty stretch; anything still empty there afterwards is silence/music
        mergeLines(normalizeLines(data.lines, start, end).filter(l => l.s >= job.a - 1 && l.s < job.b), job.a, job.b);
        V.gapChecked = (V.gapChecked || []).concat(holes(job.a, job.b));
        renderTranscript();
        await saveVideo();
        return;
      }
      mergeLines(normalizeLines(data.lines, start, end), start, end);
      const first = V.done.size === 0;
      V.done.add(job.i);
      V.lastError = null;
      renderTranscript();
      if (first) toast(`Subtitles ready for ${range(job.i)}`);
      await saveVideo();
    } catch (e) {
      if (g !== gen) return;
      const msg = String(e && e.message || e);
      const rl = rateLimitInfo(msg);
      if (rl && rl.daily && settings.backupKey && e.freeKey) {
        // free quota for today is used up → switch to the paid key until Google resets it
        if (!usingBackup()) {   // the other worker may have switched already
          settings.freeOutUntil = Date.now() + Math.min(rl.waitMs, 24 * 3600 * 1000);
          saveSettings();
          toast('Free daily limit used up — switching to your paid key');
        }
        return;   // not a failure: the part is retried right away with the paid key
      }
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
        if (w > 0 && V.single) return;
        if (V.pausedUntil > Date.now()) { await sleep(1000); continue; }
        const job = nextJob();
        if (!job) {
          if (V.done.size === V.total && !V.inFlight.size) return;   // everything translated, no gaps left
          await sleep(2000); continue;
        }
        V.inFlight.add(job.key); V.startedAt.set(job.key, Date.now()); V.jobs.set(job.key, job);
        await processJob(g, job);
        if (g !== gen || !V) return;
        V.inFlight.delete(job.key);
      }
    } finally {
      if (g === gen && V && --V.running <= 0) onIdle();
    }
  }

  function onIdle() {
    V.running = 0;
    showDialect();
    if (V.done.size === V.total && !gapJobs().length) { setGo('hidden'); setStatus('✓ All subtitles ready — saved on this phone'); return; }
    if (V.fatal) { setGo('retry'); return; }
    if (V.stopped) { setStatus(`Stopped — ${V.done.size}/${V.total} parts saved`); setGo('continue'); return; }
    setGo('retry');
  }

  function startRun() {
    if (!settings.key && !settings.backupKey) { openSettings(); toast('Add your Gemini API key first'); return; }
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
  // Gemini's timestamps tend to run a little early: subtitles are shown "sync" seconds later than their timestamp.
  // Adjustable per video with the ⏱ button; the last value you chose becomes the default for new videos.
  const syncDelay = () => (V && typeof V.sync === 'number') ? V.sync : (typeof settings.syncDefault === 'number' ? settings.syncDefault : 0.6);
  const subTime = () => playerTime() - syncDelay();

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
      dialect: saved ? saved.dialect : null, sync: saved && typeof saved.sync === 'number' ? saved.sync : undefined, running: 0, inFlight: new Set(), tries: new Map(), busy: new Map(),
      startedAt: new Map(), jobs: new Map(), gapChecked: saved ? saved.gapChecked || [] : [], pausedUntil: 0, savedPart: saved ? saved.part : 0, savedDone: saved ? saved.done || [] : []
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
        onStateChange: ev => { ytState = ev.data; ytStateAt = Date.now(); },
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
    const gapsNow = computeGaps().length;
    if (V.done.size === V.total && gapsNow && (settings.key || settings.backupKey)) {
      setStatus(`Found ${gapsNow} missing stretch${gapsNow > 1 ? 'es' : ''} — filling them in the background…`);
      startRun();
    }
    else if (V.done.size === V.total) { setGo('hidden'); setStatus('✓ Saved subtitles loaded — no internet needed for them'); }
    else if (V.done.size) { setGo('continue'); setStatus(`${V.done.size}/${V.total} parts saved on this phone`); }
    else { setGo('translate'); setStatus((settings.key || settings.backupKey) ? 'Tap Translate to start. Nothing is sent until you do.' : 'Add your Gemini API key in Settings, then tap Translate.', (settings.key || settings.backupKey) ? '' : 'warn'); }
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
    const t = subTime();
    const idx = findSeg(t);
    let seg = idx >= 0 ? V.segs[idx] : null;
    // between two lines (pause in speech / just after a jump): keep showing the last line for up to 10 s
    if (!seg && V.segs.length) {
      let lo = 0, hi = V.segs.length - 1, p = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (V.segs[m].s <= t) { p = m; lo = m + 1; } else hi = m - 1; }
      if (p >= 0 && t - V.segs[p].e <= 10) seg = V.segs[p];
    }
    let waiting = '', idle = '';
    if (!seg && V.total) {
      const p = Math.min(V.total - 1, Math.floor(t / V.part));
      if (!V.done.has(p) && V.running) waiting = V.pausedUntil > Date.now()
        ? (V.pauseReason === 'busy' ? '⏳ Gemini is busy — retrying shortly…' : '⏳ Waiting for the free-tier limit…')
        : '⏳ Preparing subtitles for this part…';
      else if (!seg) idle = V.done.has(p) ? '· · ·' : 'This part isn\'t translated yet — tap “Continue translating”.';
      if (!seg && V.running && [...V.inFlight].some(k => { const j = V.jobs.get(k); return j && j.kind === 'gap' && j.a - 2 <= t && t < j.b; })) waiting = '⏳ Filling in this missing stretch…';
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
      fitCard();
    }
    if (idx !== lastCur) {
      const old = $('lines').querySelector('.ln.cur'); if (old) old.classList.remove('cur');
      const el = idx >= 0 ? $('lines').querySelector(`[data-i="${idx}"]`) : null;
      if (el) { el.classList.add('cur'); if (autoFollow) followLine(el, lastCur < 0 || Math.abs(idx - lastCur) > 3); }
      lastCur = idx;
    }
    // "Now playing" button when you've scrolled the transcript away from the current line
    const cur = $('lines').querySelector('.ln.cur');
    $('jumpNow').hidden = !cur || autoFollow || lineInView(cur);
  }
  // keep the current line about a third of the way down the transcript box (scrolls the box, not the page)
  function followLine(el, jump) {
    const box = $('lines');
    // start the view at a whole earlier line, so the lines just heard stay readable above the current one
    let first = el, room = Math.min(box.clientHeight * 0.62, box.clientHeight - 20 - el.offsetHeight);
    while (first.previousElementSibling && room - first.previousElementSibling.offsetHeight >= 0) {
      first = first.previousElementSibling; room -= first.offsetHeight;
    }
    const top = first.offsetTop - box.offsetTop;
    box.scrollTo({ top: Math.max(0, top), behavior: jump ? 'auto' : 'smooth' });
  }
  function lineInView(el) {
    const b = $('lines').getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.bottom > b.top && r.top < b.bottom;
  }
  let autoFollow = true, followT = null;
  // you're reading/scrolling the transcript yourself → stop following for 10 s
  ['touchstart', 'wheel'].forEach(ev => $('lines').addEventListener(ev, () => {
    autoFollow = false; clearTimeout(followT);
    followT = setTimeout(() => { autoFollow = true; const c = $('lines').querySelector('.ln.cur'); if (c) followLine(c, true); }, 8000);
  }, { passive: true }));
  $('jumpNow').addEventListener('click', () => {
    autoFollow = true; clearTimeout(followT);
    const cur = $('lines').querySelector('.ln.cur'); if (cur) followLine(cur, true);
    $('jumpNow').hidden = true;
  });
  // ---------------- playback controls (built for listening practice) ----------------
  // Some phones report YouTube's state late or not at all, so "playing" also means "the time is moving".
  function isPlaying() {
    if (!playerReady) return false;
    if (Date.now() - ytStateAt < 600) return ytState === 1 || ytState === 3;   // just tapped / fresh YouTube event
    return Date.now() < movingUntil;                                         // otherwise: is the time moving?
  }
  function trackMotion() {
    const t = playerTime();
    if (t > lastT + 0.03 && t - lastT < 2) movingUntil = Date.now() + 450;   // advanced normally since last check
    lastT = t;
  }
  function togglePlay() {
    if (!playerReady) return;
    if (isPlaying()) { player.pauseVideo(); ytState = 2; ytStateAt = Date.now(); movingUntil = 0; }
    else {
      // after a learning-mode pause, ▶ continues into the next line; otherwise the current line still pauses at its end
      const i = findSeg(subTime());
      learnStopAt = null; learnLastIdx = (i >= 0 && i === autoPausedIdx) ? i : -1; autoPausedIdx = -1;
      player.playVideo(); ytState = 1; ytStateAt = Date.now();
    }
  }
  // the line being heard now, or the last one before this moment
  function currentIndex() {
    if (!V || !V.segs.length) return -1;
    const t = subTime();
    const i = findSeg(t);
    if (i >= 0) return i;
    let lo = 0, hi = V.segs.length - 1, p = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (V.segs[m].s <= t) { p = m; lo = m + 1; } else hi = m - 1; }
    return p;
  }
  function playLine(i) {
    if (!playerReady || !V || i < 0 || i >= V.segs.length) return;
    player.seekTo(Math.max(0, V.segs[i].s + syncDelay() - 0.15), true);
    learnStopAt = null; learnLastIdx = -1;     // stop again at the end of the line being replayed
    player.playVideo(); ytState = 1; ytStateAt = Date.now();
  }
  $('pcPlay').addEventListener('click', togglePlay);
  $('now').addEventListener('click', togglePlay);
  $('pcRepeat').addEventListener('click', () => playLine(Math.max(0, currentIndex())));
  $('pcPrev').addEventListener('click', () => {
    const i = currentIndex(), t = subTime();
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
    const t = subTime(), i = findSeg(t);
    if (i >= 0 && i !== learnLastIdx) { learnLastIdx = i; learnStopAt = V.segs[i].e; }
    if (learnStopAt != null && t >= learnStopAt - 0.08) { learnStopAt = null; autoPausedIdx = learnLastIdx; player.pauseVideo(); ytState = 2; ytStateAt = Date.now(); movingUntil = 0; }
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
    trackMotion();
    learnTick();
    const on = isPlaying();
    for (const id of ['pcPlay']) {
      $(id).classList.toggle('playing', on);
      $(id).setAttribute('aria-label', on ? 'Pause' : 'Play');
    }
  }, 100);

  // transcript auto-follow only while the live subtitle card is scrolled out of view (you're reading the list)
  let cardVisible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => { cardVisible = es[0].isIntersecting; }).observe($('now'));
  }
  setInterval(() => { renderNow(); progressStatus(); }, 250);

  // the transcript fills the space above the playback bar: tell the layout how tall that bar is
  if ('ResizeObserver' in window) new ResizeObserver(() => document.body.style.setProperty('--pcH', document.querySelector('.pc').offsetHeight + 'px')).observe(document.querySelector('.pc'));

  // keep the video on screen: shrink it to a corner player when its spot scrolls away
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(es => {
      const off = es[0].intersectionRatio < 0.4 && !document.fullscreenElement;
      $('stage').classList.toggle('pip', off && !$('watch').hidden);
    }, { threshold: [0, 0.2, 0.4, 0.6, 1] }).observe($('stageSlot'));
  }
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) $('stage').classList.remove('pip'); });

  function fitCard() {
    const now = $('now');
    let k = 1;
    now.style.setProperty('--fit', 1);
    while (k > 0.55 && now.scrollHeight > now.clientHeight + 1) { k -= 0.05; now.style.setProperty('--fit', k.toFixed(2)); }
  }
  window.addEventListener('resize', () => { lastSig = ''; });

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
      b.addEventListener('click', () => { if (playerReady) { player.seekTo(Math.max(0, s.s + syncDelay() - 0.1), true); player.playVideo(); } autoFollow = true; clearTimeout(followT); });
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
  // subtitle timing (⏱): shift subtitles later/earlier to match the voice
  function showSync() {
    const d = syncDelay();
    const txt = d === 0 ? 'on time' : `${Math.abs(d).toFixed(2).replace(/0$/, '')} s ${d > 0 ? 'later' : 'earlier'}`;
    $('syncBtn').textContent = '⏱ ' + (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1) + 's';
    $('syncVal').textContent = 'Subtitles ' + txt;
  }
  function setSync(d) {
    if (!V) return;
    V.sync = Math.round(Math.max(-3, Math.min(5, d)) * 100) / 100;
    settings.syncDefault = V.sync; saveSettings(); saveVideo().catch(() => {});
    lastSig = ''; lastCur = -2; showSync();
  }
  $('syncBtn').addEventListener('click', () => { $('syncRow').hidden = !$('syncRow').hidden; showSync(); });
  $('syncLess').addEventListener('click', () => setSync(syncDelay() - 0.25));
  $('syncMore').addEventListener('click', () => setSync(syncDelay() + 0.25));
  $('syncDone').addEventListener('click', () => { $('syncRow').hidden = true; });
  setInterval(() => { if (V && !$('watch').hidden) showSync(); }, 1000);

  // small video: more room for transcript lines
  const applyVid = () => { document.body.classList.toggle('smallvid', !!settings.smallVideo); $('vidBtn').setAttribute('aria-pressed', settings.smallVideo ? 'true' : 'false'); };
  applyVid();
  $('vidBtn').addEventListener('click', () => {
    settings.smallVideo = !settings.smallVideo; saveSettings(); applyVid();
    toast(settings.smallVideo ? 'Small video — more transcript lines' : 'Normal video size');
    setTimeout(() => { const c = $('lines').querySelector('.ln.cur'); if (c) followLine(c, true); }, 60);
  });

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
    $('keyWarn').hidden = !!(settings.key || settings.backupKey);
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
    $('sKey').value = settings.key; $('sBackupKey').value = settings.backupKey || '';
    $('sKeyState').textContent = settings.backupKey && settings.key && !usingBackup()
      ? 'The free key is used first; the paid key takes over only if today\'s free quota runs out.' : ''; renderUsage(); $('sModel').value = settings.model; $('sCustom').value = settings.custom;
    $('sPart').value = String(settings.partMinutes); $('sFallback').checked = settings.busyFallback;
    $('sGloss').value = settings.glossary; $('sFont').value = settings.fontScale; $('sShowAr').checked = settings.showArabic; $('sLefty').checked = !!settings.lefty; $('sThink').value = settings.thinking || 'minimal';
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
      key: $('sKey').value.trim(), backupKey: $('sBackupKey').value.trim(), model: $('sModel').value, custom: $('sCustom').value.trim(),
      partMinutes: Number($('sPart').value), busyFallback: $('sFallback').checked,
      glossary: $('sGloss').value, fontScale: Number($('sFont').value), showArabic: $('sShowAr').checked, lefty: $('sLefty').checked, thinking: $('sThink').value
    });
    saveSettings(); applyFont();
    $('keyWarn').hidden = !!(settings.key || settings.backupKey);
    toast('Settings saved');
    if (V) {
      renderTranscript();
      if (oldPart !== settings.partMinutes && !V.running) openVideo(V.id);
      else if (!V.running && V.total && V.done.size < V.total) {
        setGo(V.done.size ? 'continue' : 'translate');
        setStatus((settings.key || settings.backupKey) ? 'Tap Translate to start.' : 'Add your Gemini API key in Settings, then tap Translate.', (settings.key || settings.backupKey) ? '' : 'warn');
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
  function applyFont() {
    document.documentElement.style.setProperty('--fs', settings.fontScale);
    document.body.classList.toggle('lefty', !!settings.lefty);
    lastSig = '';   // redraw + refit the live card
  }
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
  $('keyWarn').hidden = !!(settings.key || settings.backupKey);
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
