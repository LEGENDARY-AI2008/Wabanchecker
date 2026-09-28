require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { checkNumber, cleanNumber } = require('./waCheck');
const db = require('./db');

const { BOT_TOKEN, RENDER_EXTERNAL_URL, PORT = 3000 } = process.env;
const ADMIN_IDS = (process.env.ADMIN_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const OWNER_ID = ADMIN_IDS[0];
const SUPPORT_USERNAME = (process.env.SUPPORT_USERNAME || '').replace('@', '');
if (!BOT_TOKEN || !ADMIN_IDS.length) {
  console.error('Missing BOT_TOKEN or ADMIN_ID in env');
  process.exit(1);
}

// FORCE_JOIN: comma separated. "@channel"  OR  "-1001234567890|https://t.me/+invite|Label"
const FORCE = (process.env.FORCE_JOIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => {
    if (s.includes('|')) {
      const [id, link, label] = s.split('|');
      return { id, link, label: label || 'Join' };
    }
    return { id: s, link: `https://t.me/${s.replace('@', '')}`, label: `Join ${s}` };
  });

const bot = new Telegraf(BOT_TOKEN);
const isAdminId = (id) => ADMIN_IDS.includes(String(id)) || db.isAdmin(id);
const isAdmin = (ctx) => isAdminId(ctx.from?.id);
const isOwner = (ctx) => String(ctx.from?.id) === String(OWNER_ID);
const allAdmins = () => [...new Set([...ADMIN_IDS, ...db.adminIds()])];
const addAdminMode = new Set();
const state = new Map();      // userId -> 'check' | 'support'
const adminReply = new Map(); // adminId -> ticketId
const inflight = new Set();

/* ---------- force join ---------- */
async function notJoined(userId) {
  const missing = [];
  for (const c of FORCE) {
    try {
      const m = await bot.telegram.getChatMember(c.id, userId);
      if (!['member', 'administrator', 'creator', 'restricted'].includes(m.status)) missing.push(c);
    } catch (e) {
      console.warn(`Force-join check failed for ${c.id} (is the bot admin there?):`, e.message);
    }
  }
  return missing;
}

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return next();
  db.addUser(ctx.from);
  if (isAdmin(ctx) || !FORCE.length) return next();
  const missing = await notJoined(ctx.from.id);
  if (!missing.length) return next();
  if (ctx.callbackQuery) await ctx.answerCbQuery('Join all channels first', { show_alert: true }).catch(() => {});
  return ctx.reply(
    '🔒 Join these to use the bot, then tap the button below:',
    Markup.inlineKeyboard([
      ...missing.map((c) => [Markup.button.url(c.label, c.link)]),
      [Markup.button.callback('✅ I have joined', 'joined')],
    ])
  );
});

/* ---------- menu ---------- */
const menu = (adm = false) => {
  const rows = [
    [Markup.button.callback('🔎 Check Number', 'check')],
    [Markup.button.callback('🎫 Support Ticket', 'support')],
  ];
  if (SUPPORT_USERNAME) rows[1].push(Markup.button.url('💬 Contact Support', `https://t.me/${SUPPORT_USERNAME}`));
  rows.push([Markup.button.callback('ℹ️ Help', 'help')]);
  if (adm) rows.push([Markup.button.callback('🛠 Admin Panel', 'adminpanel')]);
  return Markup.inlineKeyboard(rows);
};
const WELCOME = '👻 *WhatsApp Ban Checker*\n\nCheck if a WhatsApp number is banned. Pick an option:';

bot.start((ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('menu', (ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('cancel', (ctx) => { state.delete(ctx.from.id); adminReply.delete(ctx.from.id); addAdminMode.delete(ctx.from.id); return ctx.reply('Cancelled.', menu(isAdmin(ctx))); });

bot.action('joined', async (ctx) => { await ctx.answerCbQuery('✅ Verified'); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu() }); });
bot.action('check', async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, 'check');
  return ctx.reply('Send the number with country code, e.g. `2348012345678`', { parse_mode: 'Markdown' });
});
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    'Send a number with country code and I check if WhatsApp accepts it.\n\n' +
    '• *active* – number can register normally\n• *banned* – WhatsApp rejected it\n• *unknown* – could not confirm\n\n' +
    'Ban type (temporary/permanent) and ban reason cannot be read from outside — use Support if you need help with a review.',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Menu', 'menu')]]) }
  );
});
bot.action('menu', async (ctx) => { await ctx.answerCbQuery(); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });

/* ---------- support tickets ---------- */
bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, 'support');
  return ctx.reply('🎫 Type your message and I will send it to support. /cancel to stop.');
});

async function openTicket(ctx, text) {
  const u = ctx.from;
  const id = db.newTicket(u.id, text);
  const body = `🎫 *Ticket #${id}*\n👤 ${u.first_name || ''} ${u.username ? '@' + u.username : ''}\n🆔 \`${u.id}\`\n\n${text}`;
  const kb = Markup.inlineKeyboard([[
    Markup.button.callback('↩️ Reply', `reply_${id}`),
    Markup.button.callback('✅ Close', `close_${id}`),
  ]]);
  for (const a of allAdmins()) {
    await bot.telegram.sendMessage(a, body, { parse_mode: 'Markdown', ...kb }).catch(() => {});
  }
  return id;
}

bot.action(/^reply_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  adminReply.set(ctx.from.id, Number(ctx.match[1]));
  return ctx.reply(`Send your reply for ticket #${ctx.match[1]} (or /cancel).`);
});
bot.action(/^close_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  db.closeTicket(Number(ctx.match[1]));
  await ctx.answerCbQuery('Closed');
  return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

/* ---------- review request (after a banned result) ---------- */
bot.action(/^review_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = await openTicket(ctx, `Ban review request for +${ctx.match[1]}`);
  return ctx.reply(`✅ Review request sent. Ticket #${id}. You will get a reply here.`);
});

/* ---------- admin panel ---------- */
const panel = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add Admin', 'addadmin'), Markup.button.callback('👥 List Admins', 'listadmins')],
  [Markup.button.callback('📊 Stats', 'stats'), Markup.button.callback('📣 Broadcast', 'bchelp')],
  [Markup.button.callback('⬅️ Menu', 'menu')],
]);
const PANEL_TXT = '🛠 *Admin Panel*';
bot.command('admin', (ctx) => isAdmin(ctx) && ctx.reply(PANEL_TXT, { parse_mode: 'Markdown', ...panel() }));
bot.action('adminpanel', async (ctx) => { await ctx.answerCbQuery(); if (isAdmin(ctx)) return ctx.reply(PANEL_TXT, { parse_mode: 'Markdown', ...panel() }); });
bot.action('addadmin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  addAdminMode.add(ctx.from.id);
  return ctx.reply('Send the Telegram numeric ID of the new admin (they must have started the bot). /cancel to stop.');
});
bot.action('listadmins', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return ctx.reply('👥 Admins:\n' + allAdmins().map((a) => `• ${a}${String(a) === String(OWNER_ID) ? ' (owner)' : ''}`).join('\n') + '\n\nOwner can remove with /removeadmin <id>');
});
bot.action('stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return ctx.reply(`👥 Users: ${db.count()}\n🎫 Open tickets: ${db.openTickets()}`);
});
bot.action('bchelp', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  return ctx.reply('Reply to any message (text, photo, video...) with /broadcast, or send /broadcast your text');
});
bot.command('removeadmin', (ctx) => {
  if (!isOwner(ctx)) return;
  const id = ctx.message.text.split(/\s+/)[1];
  if (!id) return ctx.reply('Usage: /removeadmin <id>');
  if (ADMIN_IDS.includes(String(id))) return ctx.reply('That admin is set in ADMIN_ID env, remove it there.');
  db.removeAdmin(id);
  return ctx.reply(`Removed ${id}.`);
});

/* ---------- admin tools ---------- */
bot.command('stats', (ctx) => isAdmin(ctx) && ctx.reply(`👥 Users: ${db.count()}\n🎫 Open tickets: ${db.openTickets()}`));

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const reply = ctx.message.reply_to_message;
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/, '');
  if (!reply && !text) return ctx.reply('Usage: reply to any message with /broadcast, or /broadcast your text');
  const ids = db.allUserIds();
  await ctx.reply(`📣 Sending to ${ids.length} users...`);
  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      if (reply) await bot.telegram.copyMessage(id, ctx.chat.id, reply.message_id);
      else await bot.telegram.sendMessage(id, text);
      ok++;
    } catch (_) { fail++; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return ctx.reply(`Done. ✅ ${ok} sent, ❌ ${fail} failed (blocked/left).`);
});

/* ---------- text router ---------- */
const stamp = () => new Date()
  .toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  .replace(',', '');

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const uid = ctx.from.id;

  // admin adding another admin
  if (isAdmin(ctx) && addAdminMode.has(uid)) {
    addAdminMode.delete(uid);
    if (!/^\d{5,15}$/.test(text)) return ctx.reply('Invalid ID. Numbers only. Tap Add Admin to try again.');
    db.addAdmin(text);
    bot.telegram.sendMessage(text, '✅ You are now an admin. Send /admin to open the panel.').catch(() => {});
    return ctx.reply(`✅ ${text} added as admin.`);
  }

  // admin replying to a ticket
  if (isAdmin(ctx) && adminReply.has(uid)) {
    const tid = adminReply.get(uid);
    const t = db.getTicket(tid);
    adminReply.delete(uid);
    if (!t) return ctx.reply('Ticket not found.');
    try {
      await bot.telegram.sendMessage(t.userId, `📩 *Support reply (Ticket #${tid})*\n\n${text}`, { parse_mode: 'Markdown' });
      return ctx.reply(`✅ Sent to user (ticket #${tid}).`);
    } catch (_) { return ctx.reply('❌ Could not deliver (user blocked the bot).'); }
  }

  // user writing a support ticket
  if (state.get(uid) === 'support') {
    state.delete(uid);
    const id = await openTicket(ctx, text);
    return ctx.reply(`✅ Ticket #${id} created. Support will reply here.`, menu());
  }

  // number check
  const number = cleanNumber(text);
  if (number.length < 8) return ctx.reply('Send a valid number with country code, e.g. 2348012345678', menu());
  state.delete(uid);
  if (inflight.has(number)) return ctx.reply('Already checking that number, hold on...');
  inflight.add(number);
  const msg = await ctx.reply(`🔎 Checking +${number}...`);
  try {
    const r = await checkNumber(number);
    const head = `📞 \`+${number}\`\nStatus: *${r.status}*\n`;
    const tail = `Checked at: ${stamp()}\n\n_${r.detail}_`;
    const kb = r.status === 'banned'
      ? Markup.inlineKeyboard([[Markup.button.callback('📨 Request review', `review_${number}`)], [Markup.button.callback('⬅️ Menu', 'menu')]])
      : Markup.inlineKeyboard([[Markup.button.callback('🔎 Check another', 'check'), Markup.button.callback('⬅️ Menu', 'menu')]]);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, head + tail, { parse_mode: 'Markdown', ...kb });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `⚠️ Check failed: ${err.message || 'unknown error'}`);
  } finally {
    inflight.delete(number);
  }
});

bot.catch((err) => console.error('Bot error:', err));

/* ---------- start (webhook on Render, polling locally) ---------- */
(async () => {
  if (RENDER_EXTERNAL_URL) {
    const hookPath = `/tg/${BOT_TOKEN.replace(/[^A-Za-z0-9]/g, '').slice(-32)}`;
    const handler = bot.webhookCallback(hookPath);
    http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === hookPath) return handler(req, res);
      res.writeHead(200); res.end('ok');
    }).listen(PORT);
    await bot.telegram.setWebhook(`${RENDER_EXTERNAL_URL}${hookPath}`);
    console.log('Webhook set, listening on', PORT);
  } else {
    http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(PORT);
    await bot.launch();
    console.log('Polling...');
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
