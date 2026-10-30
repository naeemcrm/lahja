// Gemini usage counted on this device. Google has no API that reports remaining free quota,
// so we count each successful request and its tokens here. Shared by the phone app and the Chrome extension.
const USAGE_RATES = { in: 0.75, out: 3.75 };   // USD per 1M tokens — Gemini 3.6 Flash (thinking is billed as output)
const USAGE_FREE_PER_DAY = 20;                  // free tier, Gemini 3.6 Flash (approx.)
const USAGE_INR = 88;                           // rough ₹ per $ for display only

// Google's daily quota resets at midnight Pacific time
function usagePtDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function usageResetAt() {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date())) p[x.type] = +x.value;
  const since = ((p.hour % 24) * 3600) + p.minute * 60 + p.second;
  return Date.now() + (86400 - since) * 1000;
}
const usageBlank = () => ({ req: 0, in: 0, out: 0 });
function usageFresh(u) {
  u = u && typeof u === 'object' ? u : {};
  const day = usagePtDay(), mon = day.slice(0, 7);
  if (u.day !== day) { u.day = day; u.today = { free: usageBlank(), paid: usageBlank() }; }
  if (u.mon !== mon) { u.mon = mon; u.month = { free: usageBlank(), paid: usageBlank() }; }
  return u;
}
// kind: 'free' | 'paid'; meta: Gemini's usageMetadata
function usageAdd(u, kind, meta) {
  u = usageFresh(u);
  meta = meta || {};
  const tin = meta.promptTokenCount || 0, tout = (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  for (const b of [u.today[kind], u.month[kind]]) { b.req++; b.in += tin; b.out += tout; }
  return u;
}
const usageCost = b => (b.in * USAGE_RATES.in + b.out * USAGE_RATES.out) / 1e6;
function usageMoney(usd) {
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)} (≈ ₹${Math.round(usd * USAGE_INR)})`;
}
const usageK = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

// returns [{ title, lines[] }] for display
function usageReport(u, { hasFree, hasPaid, freeOutUntil }) {
  u = usageFresh(u);
  const reset = new Date(usageResetAt()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const out = [];
  if (hasFree) {
    const f = u.today.free, left = Math.max(0, USAGE_FREE_PER_DAY - f.req);
    const used = (freeOutUntil || 0) > Date.now();
    out.push({ title: '🆓 Free key', lines: [
      used ? `Used up for today — paid key in use until ${new Date(freeOutUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `Today: ${f.req} of ~${USAGE_FREE_PER_DAY} requests · ~${left} left`,
      `Resets at ${reset} your time · this month: ${u.month.free.req} requests (free)`
    ] });
  }
  if (hasPaid) {
    const p = u.today.paid, m = u.month.paid;
    out.push({ title: '💳 Paid key', lines: [
      `Today: ${p.req} requests · ${usageK(p.in)} in / ${usageK(p.out)} out tokens · ≈ ${usageMoney(usageCost(p))}`,
      `This month: ${m.req} requests · ≈ ${usageMoney(usageCost(m))}`
    ] });
  }
  return out;
}
