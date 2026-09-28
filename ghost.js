const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { EditedMessage } = require('telegram/events/EditedMessage');

const { API_ID, API_HASH, TG_SESSION } = process.env;
const GHOST = (process.env.GHOST_BOT || '').replace('@', '').trim();
const SETTLE_MS = Number(process.env.GHOST_DELAY_MS || 5000); // wait for Ghost to finish typing/editing
const TIMEOUT_MS = Number(process.env.GHOST_TIMEOUT_MS || 45000);

let client = null, ghostId = null, ready = false;
let waiter = null;             // { number, sentId, latest, settleTimer, resolve }
let chain = Promise.resolve(); // one request at a time

const pick = (t, re) => (t.match(re)?.[1] || '').trim();

function parse(text) {
  return {
    raw: text,
    status: pick(text, /status\s*:\s*([^\n]+)/i),
    modban: pick(text, /mod\s*ban\s*:\s*([^\n]+)/i),
    reason: pick(text, /reason\s*:\s*([^\n]+)/i),
    perma: pick(text, /perma\w*\s*:\s*([^\n]+)/i),
    bannedAt: pick(text, /banned\s*at\s*:\s*([^\n]+)/i),
  };
}

// Ghost masks the number (+23481********), so we can only compare the visible prefix.
function numberMatches(text, number) {
  const m = text.match(/\+?\s*([\d*•]{6,})/);
  if (!m) return true;
  const prefix = m[1].split(/[*•]/)[0].replace(/\D/g, '');
  return !prefix || number.startsWith(prefix);
}

function onMessage(event) {
  const m = event.message;
  if (!m || !waiter || !ghostId) return;
  if (String(m.senderId) !== String(ghostId)) return;
  if (waiter.sentId && m.id <= waiter.sentId) return; // old message being edited, not our answer
  const text = m.message || '';
  if (!/status\s*:/i.test(text)) return;               // "checking..." placeholder, wait for the result
  if (!numberMatches(text, waiter.number)) return;

  waiter.latest = text; // keep updating if Ghost edits again during the delay
  if (!waiter.settleTimer) {
    const w = waiter;
    w.settleTimer = setTimeout(() => {
      if (waiter !== w) return;
      waiter = null;
      w.resolve(parse(w.latest));
    }, SETTLE_MS);
  }
}

async function init(notify = () => {}) {
  if (!API_ID || !API_HASH || !TG_SESSION || !GHOST) {
    console.warn('Ghost relay disabled: set API_ID, API_HASH, TG_SESSION, GHOST_BOT');
    return;
  }
  try {
    client = new TelegramClient(new StringSession(TG_SESSION), Number(API_ID), API_HASH, { connectionRetries: 5 });
    await client.connect();
    const ent = await client.getEntity(GHOST);
    ghostId = ent.id;
    client.addEventHandler(onMessage, new NewMessage({}));
    client.addEventHandler(onMessage, new EditedMessage({}));
    ready = true;
    console.log('Ghost relay ready ->', GHOST);
    notify('🟢 Checker relay is online.');
  } catch (e) {
    console.error('Ghost relay failed:', e.message);
    notify('🔴 Checker relay failed to start: ' + e.message);
  }
}

// sends "? <number>" to the checker bot and waits for its result (no retries)
function check(number) {
  const job = chain.then(() => new Promise((resolve, reject) => {
    if (!ready) return reject(new Error('NOT_READY'));
    const w = { number, sentId: 0, latest: '', settleTimer: null, resolve: null };
    const t = setTimeout(() => {
      if (waiter === w) waiter = null;
      clearTimeout(w.settleTimer);
      reject(new Error('Checker did not reply in time'));
    }, TIMEOUT_MS);
    w.resolve = (r) => { clearTimeout(t); resolve(r); };
    waiter = w;
    client.sendMessage(GHOST, { message: '? ' + number })
      .then((sent) => { w.sentId = sent?.id || 0; })
      .catch((e) => {
        clearTimeout(t); clearTimeout(w.settleTimer);
        if (waiter === w) waiter = null;
        reject(e);
      });
  }));
  chain = job.catch(() => {});
  return job;
}

const status = () => ({ ready });
module.exports = { init, check, status };
