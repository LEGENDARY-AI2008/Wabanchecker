const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function cleanNumber(raw) {
  return String(raw).replace(/[^0-9]/g, '');
}

/**
 * Attempts to request a WhatsApp pairing code for `number`.
 * If WhatsApp issues a code -> number is active/reachable.
 * If WhatsApp rejects with a ban-type status code -> number is banned.
 * Anything else -> unknown (can't be confirmed from a client-side check).
 */
async function checkNumber(rawNumber) {
  const number = cleanNumber(rawNumber);
  if (number.length < 8) {
    return { ok: false, status: 'invalid', detail: 'Invalid number format' };
  }

  const sessionPath = path.join(SESSIONS_DIR, `check_${number}_${Date.now()}`);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'silent' });

  return new Promise((resolve) => {
    let settled = false;
    let sock;

    const cleanup = () => {
      try { sock?.end(); } catch (_) {}
      fs.rm(sessionPath, { recursive: true, force: true }, () => {});
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: true, status: 'unknown', detail: 'Timed out waiting for a WhatsApp response' });
    }, 25000);

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr && !settled) {
        try {
          const code = await sock.requestPairingCode(number);
          finish({ ok: true, status: 'active', detail: 'Pairing code was issued — number is reachable and not banned', pairingCode: code });
        } catch (err) {
          const statusCode = err?.output?.statusCode || err?.data?.statusCode;
          finish(classifyError(statusCode, err));
        }
      }

      if (connection === 'close' && !settled) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        finish(classifyError(statusCode, lastDisconnect?.error));
      }
    });
  });
}

function classifyError(statusCode, err) {
  switch (statusCode) {
    case 401:
      return { ok: true, status: 'banned', detail: 'Registration rejected (401) — commonly seen with banned numbers' };
    case 403:
      return { ok: true, status: 'banned', detail: 'Forbidden (403) — number likely banned or blocked from registering' };
    default:
      return {
        ok: true,
        status: 'unknown',
        detail: `Could not confirm ban status (code: ${statusCode ?? 'n/a'}). This can also happen from server IP flags or connection issues, not just bans.`,
        raw: err?.message,
      };
  }
}

module.exports = { checkNumber, cleanNumber };
