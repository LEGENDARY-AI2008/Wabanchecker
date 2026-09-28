const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { EditedMessage } = require('telegram/events/EditedMessage');

const { API_ID, API_HASH, TG_SESSION } = process.env;
const GHOST = (process.env.GHOST_BOT || '').replace('@', '').trim();

let client = null, ghostId = null, ready = false;
let waiter = null;          // { number, resolve }
let chain = Promise.resolve(); // one request at a time

const pick = (t, re) => (t.match(re)?.[1] || '').trim();

function parse(text) {
  return {
    raw: text,
    status: pick(text, /status\s*:\s*([^\n]+)/i),
    reason: pick(text, /reason\s*:\s*([^\n]+)/i),
    perma: pick(text, /perma\w*\s*:\s*([^\n]+)/i),
    bannedAt: pick(text, /banned\s*at\s*:\s*([^\n]+)/i),
  };
}

function onMessage(event) {
  const m = event.message;
  if (!m || !waiter || !ghostId) return;
  if (String(m.senderId) !== String(ghostId)) return;
  const text = m.message || '';
  if (!/status\s*:/i.test(text)) return; // ignore "checking..." placeholders, wait for the edited result
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits.includes(waiter.number.slice(-7))) return; // must be the answer for this number
  const w = waiter; waiter = null;
  w.resolve(parse(text));
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

// sends "?<number>" to the checker bot and waits for its result
function check(number) {
  const job = chain.then(async () => {
    if (!ready) throw new Error('NOT_READY');
    return new Promise(async (resolve, reject) => {
      const t = setTimeout(() => { waiter = null; reject(new Error('Checker did not reply in time')); }, 60000);
      waiter = { number, resolve: (r) => { clearTimeout(t); resolve(r); } };
      try { await client.sendMessage(GHOST, { message: '?' + number }); }
      catch (e) { clearTimeout(t); waiter = null; reject(e); }
    });
  });
  chain = job.catch(() => {});
  return job;
}

const status = () => ({ ready });
module.exports = { init, check, status };
