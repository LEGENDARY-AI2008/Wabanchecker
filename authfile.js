const fs = require('fs');
const path = require('path');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// Whole WhatsApp session lives in ONE file
const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'wa-session.json');
let store = null;
let timer;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8'), BufferJSON.reviver); } catch (_) { return null; }
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, BufferJSON.replacer));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('session save failed:', e.message); }
  }, 300);
}

async function useFileAuthState() {
  store = load() || { creds: initAuthCreds(), keys: {} };
  return {
    state: {
      creds: store.creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let v = store.keys[`${type}-${id}`];
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v || null;
          }
          return out;
        },
        set: async (data) => {
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id];
            if (v) store.keys[`${type}-${id}`] = v; else delete store.keys[`${type}-${id}`];
          }
          persist();
        },
      },
    },
    saveCreds: async () => persist(),
    clear: async () => { store = { creds: initAuthCreds(), keys: {} }; try { fs.unlinkSync(FILE); } catch (_) {} },
  };
}

module.exports = { useFileAuthState };
