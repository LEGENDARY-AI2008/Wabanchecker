// Run ONCE:  node login.js   -> logs in and writes TG_SESSION straight into .env
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const askHidden = (q) => new Promise((r) => {
  process.stdout.write(q);
  const orig = rl._writeToOutput;
  rl._writeToOutput = () => {};
  rl.question('', (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); r(a); });
});

(async () => {
  const apiId = Number(process.env.API_ID || (await ask('API_ID: ')));
  const apiHash = (process.env.API_HASH || (await ask('API_HASH: '))).trim();
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: () => ask('Phone (+234...): '),
    password: () => askHidden('2FA password (Enter if none, hidden): '),
    phoneCode: () => ask('Code from Telegram: '),
    onError: (e) => console.log(e.message),
  });
  const session = client.session.save();

  const file = path.join(__dirname, '.env');
  let env = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^TG_SESSION=.*$/m.test(env)) env = env.replace(/^TG_SESSION=.*$/m, 'TG_SESSION=' + session);
  else env += (env.endsWith('\n') || !env ? '' : '\n') + 'TG_SESSION=' + session + '\n';
  fs.writeFileSync(file, env);
  console.log('\n✅ TG_SESSION saved into .env. Nothing to copy or paste.');
  process.exit(0);
})();
