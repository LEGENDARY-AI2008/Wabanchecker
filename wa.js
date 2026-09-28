const {
  default: makeWASocket, DisconnectReason, Browsers,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { useFileAuthState } = require('./authfile');

const logger = pino({ level: 'silent' });
let sock = null, auth = null, ready = false, running = false, pairWaiter = null, notify = () => {};

async function start() {
  if (running) return;
  running = true;
  try {
    auth = await useFileAuthState();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    sock = makeWASocket({
      version,
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    const me = sock;
    me.ev.on('creds.update', auth.saveCreds);
    me.ev.on('connection.update', async (u) => {
      if (me !== sock) return;
      const { connection, lastDisconnect, qr } = u;

      if (qr && pairWaiter && !auth.state.creds.registered) {
        const w = pairWaiter; pairWaiter = null;
        try { w.resolve(await me.requestPairingCode(w.phone)); } catch (e) { w.reject(e); }
      }
      if (connection === 'open') { ready = true; notify('open'); }
      if (connection === 'close') {
        ready = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        running = false;
        if (code === DisconnectReason.loggedOut) {
          await auth.clear().catch(() => {});
          sock = null;
          return notify('loggedout');
        }
        if (!auth.state.creds.registered && !pairWaiter) return; // unpaired: do not loop
        setTimeout(start, 3000);
      }
    });
  } catch (e) {
    console.error('wa start error:', e.message);
    running = false;
    setTimeout(start, 10000);
  }
}

async function init(cb) {
  notify = cb || notify;
  try {
    const a = await useFileAuthState();
    if (a.state.creds.registered) start();
    else console.log('No WhatsApp linked yet. Use /pair in Telegram.');
  } catch (e) { console.warn('WhatsApp checker disabled:', e.message); }
}

async function pair(phone) {
  const a = await useFileAuthState();
  if (a.state.creds.registered) throw new Error('A number is already linked. Use /unpair first.');
  try { sock?.end?.(); } catch (_) {}
  sock = null; running = false; ready = false;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pairWaiter = null; reject(new Error('Timed out getting a code, try again')); }, 45000);
    pairWaiter = { phone, resolve: (c) => { clearTimeout(t); resolve(c); }, reject: (e) => { clearTimeout(t); reject(e); } };
    start();
  });
}

async function unpair() {
  try { await sock?.logout(); } catch (_) {}
  try { sock?.end?.(); } catch (_) {}
  sock = null; ready = false; running = false;
  const a = await useFileAuthState();
  await a.clear();
}

async function check(number) {
  if (!ready || !sock) throw new Error('NOT_LINKED');
  const r = await sock.onWhatsApp(number);
  const hit = r && r[0];
  return { exists: !!(hit && hit.exists) };
}

async function probe(number) {
  if (!ready || !sock) throw new Error('NOT_LINKED');
  const jid = `${number}@s.whatsapp.net`;
  const out = {};
  const t = async (name, fn) => {
    try { out[name] = (await fn()) ?? null; }
    catch (e) { out[name] = { error: e.message, code: e?.output?.statusCode || e?.data || null }; }
  };
  await t('onWhatsApp', () => sock.onWhatsApp(number));
  await t('profilePic', () => sock.profilePictureUrl(jid, 'image'));
  await t('about', () => sock.fetchStatus(jid));
  await t('business', () => sock.getBusinessProfile(jid));
  return out;
}

const status = () => ({ ready, linked: !!auth?.state?.creds?.registered });

module.exports = { init, pair, unpair, check, probe, status };
