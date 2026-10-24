// bancheck.js — talks to your own BanCheck API (baron0.com). Replaces ghost.js.
// Same interface as ghost.js: init(notify), check(number), status()
const API_BASE = (process.env.BANCHECK_API_BASE || 'https://baron0.com').replace(/\/+$/, '');
const KEY = (process.env.BANCHECK_API_KEY || '').trim();
const TIMEOUT_MS = Number(process.env.BANCHECK_TIMEOUT_MS || 20000);
const MAX_QUEUE = Number(process.env.BANCHECK_MAX_QUEUE || 8);

let ready = false;
let pending = 0;

const lagos = (d) =>
  new Date(d)
    .toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Africa/Lagos',
    })
    .replace(',', '');

async function call(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function fail(r) {
  if (r.status === 429) return new Error('BUSY');
  if (r.status === 401 || r.status === 403) return new Error('API key rejected, check BANCHECK_API_KEY');
  return new Error(r.body.detail || r.body.error || r.body.title || `HTTP ${r.status}`);
}

async function init(notify = () => {}) {
  if (!KEY) {
    console.warn('BanCheck API disabled: set BANCHECK_API_KEY');
    return;
  }
  ready = true;
  console.log('BanCheck API ready ->', API_BASE);
  notify('🟢 Checker API is online.');
}

async function run(number) {
  const c = await call('/api/v2/check', { method: 'POST', body: JSON.stringify({ number: '+' + number }) });
  if (!c.ok) throw fail(c);
  const d = c.body;

  if (!d.banned) {
    return { raw: JSON.stringify(d), status: 'Unbanned', modban: '', reason: '', perma: '', bannedAt: '' };
  }

  // banned: pull ban time + perma flag from appeal-status (404 = nothing available, that's fine)
  let a = null;
  try {
    const r = await call('/api/v2/appeal-status?phone=' + encodeURIComponent('+' + number));
    if (r.ok) a = r.body;
  } catch (_) { /* optional extra info */ }

  return {
    raw: JSON.stringify(d),
    status: 'Banned',
    modban: d.mod_ban ? 'Yes' : 'No',
    reason: d.violation_label || d.violation_reason || d.ban_type || '',
    perma: a ? (a.is_perma ? 'Yes' : 'No') : '',
    bannedAt: a?.ban_time ? lagos(a.ban_time) : '', // UTC -> Africa/Lagos (already +1h)
  };
}

function check(number) {
  if (!ready) return Promise.reject(new Error('NOT_READY'));
  if (pending >= MAX_QUEUE) return Promise.reject(new Error('BUSY'));
  pending++;
  return run(number).finally(() => { pending--; });
}

const status = () => ({ ready });
module.exports = { init, check, status };
