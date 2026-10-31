// Dialect list + prompts. Edit the "hints" to teach Claude more dialect words.
var YTDS_DIALECTS = {
  emirati: {
    label: 'Emirati', ar: 'إماراتي',
    hints: 'شو = what; الحين = now; وايد = very / a lot; تبا / تبي / ابا = want / I want; عسب = so that / because; لا تحاتي = don\'t worry; ما عليه = it\'s okay; يالله = come on / let\'s go; سير = go; بـ + verb = will (بسوي = I\'ll do)'
  },
  najdi: {
    label: 'Saudi – Najdi (Riyadh)', ar: 'نجدي',
    hints: 'وش = what; الحين = now; مره = very; يبي / ابي = wants / I want; ابشر = sure, you got it; وشلونك = how are you; زين = good; ودي = I\'d like; بـ + verb = will'
  },
  hijazi: {
    label: 'Saudi – Hijazi (Jeddah / Makkah)', ar: 'حجازي',
    hints: 'ايش = what; دحين = now; كدا = like this; يبغى / ابغى = wants / I want; مرة = very; برضو = also; فين = where; حـ / راح + verb = will'
  },
  gulf_other: {
    label: 'Other Gulf (Kuwaiti / Qatari / Bahraini / Omani)', ar: 'خليجي',
    hints: 'شنو / شو = what; الحين = now; وايد = a lot; أبي = I want; شلونك = how are you; زين = good; جذي / كذي = like this'
  },
  egyptian: {
    label: 'Egyptian', ar: 'مصري',
    hints: 'إزاي = how; دلوقتي = now; عايز = want; أوي = very; مش = not; بتاع = belonging to; فين = where; حـ / هـ + verb = will; يعني = I mean'
  },
  levantine: {
    label: 'Levantine (Syrian / Lebanese / Jordanian / Palestinian)', ar: 'شامي',
    hints: 'شو = what; هلق / هلأ = now; كتير = very; بدي = I want; ليش = why; منيح = good; هيك = like this; رح + verb = will'
  },
  iraqi: {
    label: 'Iraqi', ar: 'عراقي',
    hints: 'شنو = what; هسه = now; كلش = very; أريد = I want; شلونك = how are you; زين = good; ليش = why; راح + verb = will'
  },
  maghrebi: {
    label: 'Maghrebi (Moroccan / Algerian / Tunisian)', ar: 'مغاربي',
    hints: 'واش = question particle / what; دابا / دروك = now; بزاف = a lot; بغيت = I want; علاش = why; مزيان = good; غادي + verb = will'
  },
  yemeni: { label: 'Yemeni', ar: 'يمني', hints: 'ايش = what; ذلحين = now; شي = something; با / بـ + verb = will' },
  sudanese: { label: 'Sudanese', ar: 'سوداني', hints: 'شنو = what; هسي = now; داير = want; شديد = very' },
  msa: { label: 'Modern Standard Arabic (فصحى)', ar: 'فصحى', hints: 'Formal Arabic: news, lectures, official speech.' }
};

function ytdsDialectLabel(key) {
  const d = YTDS_DIALECTS[key];
  return d ? `${d.label} · ${d.ar}` : 'Unknown';
}

// ---------- Step 1: dialect detection ----------
function ytdsBuildDetectPrompt() {
  const keys = Object.keys(YTDS_DIALECTS).map(k => `${k} = ${YTDS_DIALECTS[k].label}`).join('\n');
  return `You are an expert Arabic dialectologist. Identify the spoken Arabic dialect of a YouTube video from its caption transcript (auto-captions may contain recognition errors).

Use vocabulary, grammar, negation, future markers and pronunciation spelled in the text. Title, channel and description are supporting hints only.

Choose ONE primary dialect key from:
${keys}

Return ONLY JSON, no prose, no code fences:
{"dialect":"<key>","confidence":"high|medium|low","mixed":["<other keys clearly present>"],"evidence":["<Arabic word> = <English meaning> (<dialect>)", "... max 5"]}`;
}

function ytdsBuildDetectUser(meta, lines) {
  return [
    `VIDEO TITLE: ${meta && meta.title || '(unknown)'}`,
    meta && meta.channel ? `CHANNEL: ${meta.channel}` : '',
    meta && meta.description ? `DESCRIPTION (excerpt):\n${meta.description.slice(0, 600)}` : '',
    `TRANSCRIPT SAMPLE:\n${lines.join('\n')}`
  ].filter(Boolean).join('\n\n');
}

// ---------- Step 2: translation ----------
function ytdsBuildTranslatePrompt(dialectKey) {
  const d = YTDS_DIALECTS[dialectKey] || YTDS_DIALECTS.msa;
  return `You are an expert Arabic → English subtitle translator. The video is spoken in ${d.label} Arabic.

DIALECT NOTES (use them to read words correctly — never read dialect words as MSA):
${d.hints}

GOAL: translate MEANING in context into natural, fluent English that a native English speaker would say. Use the title, description, previous lines and upcoming lines to resolve ambiguity.

RULES
- Caption lines are often fragments split mid-sentence. Translate each id so it reads naturally and stays aligned with that line's timing. You may move a word or two between neighbouring lines when English word order needs it. Never leave a line empty unless it is pure filler.
- Auto-captions may mis-hear words. Infer the intended word from context and the dialect.
- Translate expressions by intent, not literally: والله → "honestly" / "I swear"; إن شاء الله → "hopefully" / "God willing"; ما شاء الله → "wow, amazing" / "mashallah"; يعني → "I mean" / "like" or drop it when it is filler.
- Keep people, place and brand names (transliterate: محمد → Mohammed, دبي → Dubai).
- Keep subtitles concise and quick to read. Use Western digits (0-9).
- Follow the glossary exactly when one is given.
- Bracketed sound tags like [موسيقى] → [Music], [تصفيق] → [Applause].
- Also return "ar": the same Arabic line with obvious recognition errors fixed and light punctuation added. Keep the dialect words — do NOT convert to MSA.

OUTPUT
Return ONLY a JSON array — no prose, no code fences:
[{"id": <number>, "ar": "<cleaned Arabic>", "en": "<English>"}]
Exactly one object per input id, same order.`;
}

function ytdsBuildTranslateUser({ meta, glossary, prev, next, lines }) {
  const parts = [];
  parts.push(`VIDEO TITLE: ${meta && meta.title || '(unknown)'}`);
  if (meta && meta.description) parts.push(`VIDEO DESCRIPTION (excerpt):\n${meta.description}`);
  if (glossary && glossary.trim()) parts.push(`GLOSSARY (always use these):\n${glossary.trim()}`);
  if (prev && prev.length) parts.push(`PREVIOUS LINES (context only — do NOT output):\n${JSON.stringify(prev)}`);
  if (next && next.length) parts.push(`UPCOMING LINES (context only — do NOT output):\n${JSON.stringify(next)}`);
  parts.push(`TRANSLATE THESE LINES:\n${JSON.stringify(lines)}`);
  return parts.join('\n\n');
}

// ---------- Audio mode (Gemini listens to the video) ----------
function ytdsBuildAudioPrompt() {
  const keys = Object.keys(YTDS_DIALECTS).map(k => `${k} = ${YTDS_DIALECTS[k].label}`).join('\n');
  const notes = Object.keys(YTDS_DIALECTS).filter(k => k !== 'msa')
    .map(k => `- ${YTDS_DIALECTS[k].label}: ${YTDS_DIALECTS[k].hints}`).join('\n');
  return `You are an expert Arabic dialectologist, transcriber and Arabic → English subtitle translator.

You receive a clip of a YouTube video. LISTEN to the speech and:
1. Identify the spoken Arabic dialect from vocabulary AND accent / pronunciation.
2. Transcribe the Arabic exactly as spoken, in the speaker's own dialect. Do NOT convert to Modern Standard Arabic. Use common dialect spelling.
3. Translate each line into natural, fluent English by MEANING, using the video context.

DIALECT KEYS
${keys}

DIALECT NOTES (to hear and read words correctly)
${notes}

SUBTITLE LINES
- One line per short phrase or sentence: at most ~12 Arabic words and 1–7 seconds long.
- Keep going until the END of the clip — long clips must still be fully covered.
TIMING — the subtitles are played against the audio, so timing must be exact:
- "start" and "end" are numbers in SECONDS FROM THE START OF THIS CLIP (0 = the first moment of the clip), with one decimal, e.g. 12.4.
- "start" = the instant the FIRST word of the line is heard; "end" = the instant the LAST word finishes. Never start a line before its first word is spoken.
- Follow the real audio: do not round to whole seconds, do not space lines evenly, do not guess. Pauses between lines stay as gaps.
- Cover all speech in the clip, in order, to the very end. Skip silence. No overlapping lines.
- Speech in English: put it in "ar" as spoken and repeat it in "en".
- Non-speech: [موسيقى] / [Music], [ضحك] / [Laughter].
- Translate expressions by intent: والله → "honestly" / "I swear"; إن شاء الله → "hopefully" / "God willing"; ما شاء الله → "wow" / "mashallah"; filler يعني → "I mean" or drop it.
- Keep names (محمد → Mohammed, دبي → Dubai). Use Western digits. Follow the glossary exactly.

OUTPUT — ONLY this JSON, no prose:
{"dialect":"<key>","confidence":"high|medium|low","mixed":["<other keys clearly present>"],"evidence":["<word> = <meaning>", "<accent clue>", "max 5"],"lines":[{"start":12.4,"end":15.2,"ar":"<Arabic as spoken>","en":"<English>"}]}`;
}

function ytdsFmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ytdsBuildAudioUser({ meta, glossary, start, end, dialectInfo, prev }) {
  const parts = [];
  parts.push(`VIDEO TITLE: ${meta && meta.title || '(unknown)'}`);
  if (meta && meta.channel) parts.push(`CHANNEL: ${meta.channel}`);
  if (meta && meta.description) parts.push(`DESCRIPTION (excerpt):\n${meta.description.slice(0, 800)}`);
  if (glossary && glossary.trim()) parts.push(`GLOSSARY (always use these):\n${glossary.trim()}`);
  parts.push(`THIS CLIP: ${Math.round(end - start)} seconds long (it is ${ytdsFmtTime(start)}–${ytdsFmtTime(end)} of the full video). Give timestamps in seconds from the START OF THIS CLIP: 0 to ${Math.round(end - start)}.`);
  if (dialectInfo && dialectInfo.dialect) parts.push(`Dialect identified so far: ${YTDS_DIALECTS[dialectInfo.dialect] ? YTDS_DIALECTS[dialectInfo.dialect].label : dialectInfo.dialect} (${dialectInfo.confidence || '?'}). Re-check from this clip.`);
  if (prev && prev.length) parts.push(`LAST LINES BEFORE THIS CLIP (context only — do NOT output):\n${JSON.stringify(prev)}`);
  return parts.join('\n\n');
}

// Second pass: timing only. The lines are already transcribed; Gemini only has to find WHEN each one is spoken.
function ytdsBuildAlignPrompt() {
  return `You are a precise subtitle timing aligner for Arabic speech.

You receive a short clip of a video and the numbered subtitle lines that are spoken in it, in order.
LISTEN to the audio and, for every line, find exactly when it is spoken:
- start = the instant the FIRST word of the line begins.
- end = the instant the LAST word of the line finishes.
- Seconds from the START OF THIS CLIP (0 = first moment of the clip), one decimal, e.g. 41.3.
- Lines are in speaking order: each start must be ≥ the previous line's end. Pauses between lines stay as gaps.
- Use the real sound only. Do not space lines evenly, do not guess, do not round to whole seconds.
- If a line is not heard in this clip, use null for it.

OUTPUT — ONLY this JSON, one pair per line, same count and order as the lines given:
{"t":[[start,end],[start,end],null,...]}`;
}

function ytdsBuildAlignUser({ start, end, lines }) {
  const len = Math.round(end - start);
  return `THIS CLIP: ${len} seconds long. Times must be 0 to ${len}.\n\nLINES (${lines.length}):\n` +
    lines.map((l, i) => `${i + 1}. ${l.ar || l.en}`).join('\n');
}
