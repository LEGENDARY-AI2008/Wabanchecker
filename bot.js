require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const ghost = require('./ghost');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cleanNumber = (s) => String(s).replace(/[^0-9]/g, '');
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

// coloured buttons (Bot API 9.4+): style = 'primary' (blue) | 'success' (green) | 'danger' (red)
const cb = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const link = (text, url, style) => ({ text, url, ...(style ? { style } : {}) });
const kbd = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const isAdminId = (id) => ADMIN_IDS.includes(String(id)) || db.isAdmin(id);
const isAdmin = (ctx) => isAdminId(ctx.from?.id);
const isOwner = (ctx) => String(ctx.from?.id) === String(OWNER_ID);
const allAdmins = () => [...new Set([...ADMIN_IDS, ...db.adminIds()])];
const addAdminMode = new Set();
const state = new Map();      // userId -> 'check' | 'support'
const adminReply = new Map(); // adminId -> ticketId
const inflight = new Set();
const cool = new Map();

/* ---------- dedupe redelivered updates ---------- */
const seenUpdates = new Set();
bot.use((ctx, next) => {
  const id = ctx.update.update_id;
  if (seenUpdates.has(id)) return;
  seenUpdates.add(id);
  if (seenUpdates.size > 1000) seenUpdates.delete(seenUpdates.values().next().value);
  return next();
});

/* ---------- force join ---------- */
const warned = new Map();
function warnOwner(c, msg) {
  if (Date.now() - (warned.get(c.id) || 0) < 3600e3) return; // once per hour per channel
  warned.set(c.id, Date.now());
  console.warn(`Force-join check failed for ${c.id}:`, msg);
  allAdmins().forEach((a) => bot.telegram.sendMessage(a,
    `⚠️ Force-join check FAILED for ${c.id}\n${msg}\n\nFix: add this bot as ADMIN in that channel/group. Until then nobody is being blocked by it.`).catch(() => {}));
}

async function isMember(c, userId) {
  const m = await bot.telegram.getChatMember(c.id, userId);
  if (['member', 'administrator', 'creator'].includes(m.status)) return true;
  if (m.status === 'restricted') return m.is_member !== false; // restricted users who already left are NOT members
  return false; // left / kicked
}

async function notJoined(userId) {
  const missing = [];
  for (const c of FORCE) {
    try {
      if (!(await isMember(c, userId))) missing.push(c);
    } catch (e) {
      const msg = e.description || e.message || String(e);
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(msg)) { missing.push(c); continue; }
      warnOwner(c, msg); // bot not admin / wrong id / chat not found -> tell the owner instead of failing silently
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
    kbd([
      ...missing.map((c) => [link(c.label, c.link, 'primary')]),
      [cb('✅ I have joined', 'joined', 'success')],
    ])
  );
});

/* ---------- menu ---------- */
const menu = (adm = false) => {
  const rows = [
    [cb('🔎 Check Number', 'check', 'success')],
    [cb('🎫 Support Ticket', 'support', 'primary')],
  ];
  if (SUPPORT_USERNAME) rows[1].push(link('💬 Contact Support', `https://t.me/${SUPPORT_USERNAME}`, 'primary'));
  rows.push([cb('ℹ️ Help', 'help')]);
  if (adm) rows.push([cb('🛠 Admin Panel', 'adminpanel', 'danger')]);
  return kbd(rows);
};
const WELCOME = '👻 *WhatsApp Ban Checker*\n\nCheck if a WhatsApp number is banned. Pick an option:';

bot.start((ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('menu', (ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('cancel', (ctx) => { state.delete(ctx.from.id); adminReply.delete(ctx.from.id); addAdminMode.delete(ctx.from.id); return ctx.reply('Cancelled.', menu(isAdmin(ctx))); });

bot.action('joined', async (ctx) => { await ctx.answerCbQuery('✅ Verified'); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
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
    { parse_mode: 'Markdown', ...kbd([[cb('⬅️ Menu', 'menu')]]) }
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
  const body = `🎫 <b>Ticket #${id}</b>\n👤 ${esc(u.first_name || '')} ${u.username ? '@' + esc(u.username) : ''}\n🆔 <code>${u.id}</code>\n\n${esc(text)}`;
  const kb = kbd([[cb('↩️ Reply', `reply_${id}`, 'primary'), cb('✅ Close', `close_${id}`, 'success')]]);
  for (const a of allAdmins()) {
    await bot.telegram.sendMessage(a, body, { parse_mode: 'HTML', ...kb }).catch(() => {});
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
const panel = () => kbd([
  [cb('➕ Add Admin', 'addadmin', 'success'), cb('👥 List Admins', 'listadmins', 'primary')],
  [cb('📊 Stats', 'stats', 'primary'), cb('📣 Broadcast', 'bchelp', 'danger')],
  [cb('⬅️ Menu', 'menu')],
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
      await bot.telegram.sendMessage(t.userId, `📩 <b>Support reply (Ticket #${tid})</b>\n\n${esc(text)}`, { parse_mode: 'HTML' });
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
  const now = Date.now();
  if (now - (cool.get(uid) || 0) < 4000) return ctx.reply('⏳ Slow down, wait a few seconds.');
  cool.set(uid, now);
  if (inflight.has(number)) return ctx.reply('Already checking that number, hold on...');
  inflight.add(number);
  const msg = await ctx.reply(`🔎 Checking +${number}...`);
  runCheck(ctx, number, msg); // NOT awaited: handler returns now, so Telegram never re-sends the update
});

async function runCheck(ctx, number, msg) {
  const edit = (t, extra = {}) => ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, t, extra).catch(() => {});
  try {
    const r = await ghost.check(number);
    const st = (r.status || '').toLowerCase();
    const banned = /\bbanned\b/.test(st) && !/\bnot\s+banned\b/.test(st); // "unbanned" is NOT banned
    const icon = banned ? '🚫' : /unban|active/.test(st) ? '✅' : '❔';
    const lines = [`📞 <code>+${number}</code>`];
    if (r.status) lines.push(`<b>Status:</b> ${icon} ${esc(r.status)}`);
    if (r.modban) lines.push(`<b>Modban:</b> ${esc(r.modban)}`);
    if (r.reason) lines.push(`<b>Reason:</b> ${esc(r.reason)}`);
    if (r.perma) lines.push(`<b>Perma:</b> ${esc(r.perma)}`);
    if (r.bannedAt) lines.push(`<b>Banned at:</b> ${esc(r.bannedAt)}`);
    if (!r.status) lines.push(`<pre>${esc(r.raw.slice(0, 700))}</pre>`);
    lines.push(`\nChecked at: ${stamp()}`);
    const kb = banned
      ? kbd([[cb('📨 Request review', `review_${number}`, 'primary')], [cb('⬅️ Menu', 'menu')]])
      : kbd([[cb('🔎 Check another', 'check', 'success'), cb('⬅️ Menu', 'menu')]]);
    await edit(lines.join('\n'), { parse_mode: 'HTML', ...kb });
  } catch (err) {
    await edit(err.message === 'NOT_READY' ? '⚠️ Checker is offline right now. Try again later.' : `⚠️ Check failed: ${err.message || 'unknown error'}`);
  } finally {
    inflight.delete(number);
  }
}

bot.catch((err) => console.error('Bot error:', err));

/* ---------- start (webhook on Render, polling locally) ---------- */
(async () => {
  await db.init();
  ghost.init((msg) => allAdmins().forEach((a) => bot.telegram.sendMessage(a, msg).catch(() => {}))).catch((e) => console.error(e));
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
