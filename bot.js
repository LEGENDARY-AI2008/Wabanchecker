require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const LOGO_PATH = path.join(__dirname, 'logo.jpg');
let ME = null;       // bot info (id, username)
let LOGO_ID = null;  // cached Telegram file_id of the logo after first upload
const SHIFT_MIN = Number(process.env.TIME_SHIFT_MIN ?? -60); // shift Ghost's "Banned at" time (minutes)

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
const WELCOME = '👻 *WhatsApp Ban Checker*\n\nCheck if a WhatsApp number is banned.\nSend: `? 2348012345678`\n\nPick an option:';

bot.start((ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('menu', (ctx) => { state.delete(ctx.from.id); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.command('cancel', (ctx) => { state.delete(ctx.from.id); adminReply.delete(ctx.from.id); addAdminMode.delete(ctx.from.id); return ctx.reply('Cancelled.', menu(isAdmin(ctx))); });

bot.action('joined', async (ctx) => { await ctx.answerCbQuery('✅ Verified'); return ctx.reply(WELCOME, { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) }); });
bot.action('check', async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.from.id, 'check');
  return ctx.reply('Send the number with a question mark and the country code:\n`? 2348012345678`', { parse_mode: 'Markdown' });
});
bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    'Send `? 2348012345678` (question mark + number with country code) and I check the ban status.\n\n' +
    'In a group: add me, make me *admin*, then use the same `? 234...` command.\n\n' +
    '• *unbanned* – number is fine\n• *banned* – WhatsApp banned it\n• Modban / Reason / Perma show when the checker returns them\n\n' +
    'Need a review? Use Support.',
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
  .toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Lagos' })
  .replace(',', '');

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const uid = ctx.from.id;
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') return handleGroup(ctx, text);

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

  // number check: private chat needs the "?" prefix too
  const number = parseQuery(text);
  if (!number) return ctx.reply('Send it like this:\n`? 2348012345678`', { parse_mode: 'Markdown', ...menu(isAdmin(ctx)) });
  state.delete(uid);
  return startCheck(ctx, number, false);
});

/* ---------- "? number" parsing, time shift ---------- */
const QRE = /^\?\s*\+?\s*(\d[\d\s\-().]{6,})/;
function parseQuery(text) {
  const m = text.match(QRE);
  if (!m) return null;
  const n = cleanNumber(m[1]);
  return n.length >= 8 && n.length <= 15 ? n : null;
}

const p2 = (n) => String(n).padStart(2, '0');
function shiftTime(str) {
  if (!SHIFT_MIN) return str;
  let y, mo, d, h, mi, sec, out;
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; sec = m[6] ? +m[6] : null;
    out = (t, s2) => `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}${s2 ? ':' + p2(t.getUTCSeconds()) : ''}`;
  } else if ((m = str.match(/(\d{1,2})([./-])(\d{1,2})[./-](\d{4})([,\s]+)(\d{1,2})([.:])(\d{2})(?:[.:](\d{2}))?/))) {
    // e.g. 27.09.2026 23.10  or  28/09/2026, 12:29  (keeps Ghost's own separators)
    d = +m[1]; mo = +m[3]; y = +m[4]; h = +m[6]; mi = +m[8]; sec = m[9] ? +m[9] : null;
    const ds = m[2], gap = m[5], ts = ':'; // time always uses ':'
    out = (t, s2) => `${p2(t.getUTCDate())}${ds}${p2(t.getUTCMonth() + 1)}${ds}${t.getUTCFullYear()}${gap}${p2(t.getUTCHours())}${ts}${p2(t.getUTCMinutes())}${s2 ? ts + p2(t.getUTCSeconds()) : ''}`;
  } else return str; // unknown format: show as Ghost gave it
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, sec || 0) + SHIFT_MIN * 60000);
  return out(t, sec !== null);
}

/* ---------- groups ---------- */
const replyTo = (ctx, inGroup) =>
  inGroup && ctx.message ? { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } } : {};

async function handleGroup(ctx, text) {
  const tagged = ME?.username && new RegExp('@' + ME.username + '\\b', 'i').test(text);
  const clean = tagged ? text.replace(new RegExp('@' + ME.username + '\\b', 'ig'), '').trim() : text;
  const number = parseQuery(clean);
  if (!number) {
    if (tagged) return ctx.reply('👻 Send `? 2348012345678` to check a number.', { parse_mode: 'Markdown', ...replyTo(ctx, true) });
    return; // ignore normal group chat
  }
  try {
    const me = await ctx.telegram.getChatMember(ctx.chat.id, ME.id);
    if (me.status !== 'administrator') {
      return ctx.reply('⚠️ Make me an admin in this group first, then send `? 234...` again.', { parse_mode: 'Markdown', ...replyTo(ctx, true) });
    }
  } catch (_) { /* cannot verify: carry on */ }
  return startCheck(ctx, number, true);
}

bot.on('my_chat_member', (ctx) => {
  const u = ctx.update.my_chat_member;
  if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return;
  const was = u.old_chat_member.status, now = u.new_chat_member.status;
  if (now === 'member' && (was === 'left' || was === 'kicked')) {
    ctx.telegram.sendMessage(u.chat.id, '👻 Thanks for adding me!\n\n⚠️ Make me an *admin* so I can work, then send `? 2348012345678` to check a number.', { parse_mode: 'Markdown' }).catch(() => {});
  } else if (now === 'administrator' && was !== 'administrator') {
    ctx.telegram.sendMessage(u.chat.id, '✅ I am admin now. Send `? 2348012345678` to check a number.', { parse_mode: 'Markdown' }).catch(() => {});
  }
});

/* ---------- check flow (logo first, then caption is edited) ---------- */
async function sendCard(ctx, caption, inGroup) {
  const extra = { parse_mode: 'HTML', ...replyTo(ctx, inGroup) };
  if (LOGO_ID || fs.existsSync(LOGO_PATH)) {
    try {
      const m = await ctx.replyWithPhoto(LOGO_ID || { source: LOGO_PATH }, { ...extra, caption });
      if (!LOGO_ID && m.photo) LOGO_ID = m.photo[m.photo.length - 1].file_id;
      return { m, photo: true };
    } catch (e) { console.error('logo send failed:', e.message); }
  }
  return { m: await ctx.reply(caption, extra), photo: false };
}

async function startCheck(ctx, number, inGroup) {
  const uid = ctx.from.id;
  const now = Date.now();
  if (now - (cool.get(uid) || 0) < 4000) return ctx.reply('⏳ Slow down, wait a few seconds.', replyTo(ctx, inGroup));
  cool.set(uid, now);
  if (inflight.has(number)) return ctx.reply('Already checking that number, hold on...', replyTo(ctx, inGroup));
  inflight.add(number);
  const card = await sendCard(ctx, `🔎 Checking +${number}...`, inGroup).catch((e) => { inflight.delete(number); throw e; });
  runCheck(ctx, number, card, inGroup); // NOT awaited: handler returns now, so Telegram never re-sends the update
}

async function runCheck(ctx, number, card, inGroup) {
  const edit = (t, extra = {}) => (card.photo
    ? ctx.telegram.editMessageCaption(ctx.chat.id, card.m.message_id, undefined, t, extra)
    : ctx.telegram.editMessageText(ctx.chat.id, card.m.message_id, undefined, t, extra)
  ).catch((e) => console.error('edit failed:', e.message));
  try {
    const r = await ghost.check(number);
    const st = (r.status || '').toLowerCase();
    const banned = /\bbanned\b/.test(st) && !/\bnot\s+banned\b/.test(st); // "unbanned" is NOT banned
    const icon = banned ? '🚫' : /unban|active/.test(st) ? '✅' : '❔';
    const rows = [`☎️: +${number}`];
    if (r.status) rows.push(`Status: ${esc(r.status)} ${icon}`);
    if (r.modban) rows.push(`Modban: ${esc(r.modban)}`);
    if (r.reason) rows.push(`Reason: ${esc(r.reason)}`);
    if (r.perma) rows.push(`Perma: ${esc(r.perma)}`);
    if (r.bannedAt) rows.push(`Banned at: ${esc(shiftTime(r.bannedAt))}`);
    const body = r.status ? `<blockquote>${rows.join('\n')}</blockquote>` : `<pre>${esc(r.raw.slice(0, 700))}</pre>`;
    const review = banned ? [[cb('📨 Request review', `review_${number}`, 'primary')]] : [];
    const kb = inGroup
      ? (review.length ? kbd(review) : {})
      : kbd([...review, [cb('🔎 Check another', 'check', 'success'), cb('⬅️ Menu', 'menu')]]);
    await edit(`${body}\n\n🕐 ${stamp()}`, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    const msg = err.message === 'NOT_READY' ? '⚠️ Checker is offline right now. Try again later.'
      : err.message === 'BUSY' ? '⚠️ Too many checks running. Try again in a minute.'
      : `⚠️ Check failed: ${err.message || 'unknown error'}`;
    await edit(msg);
  } finally {
    inflight.delete(number);
  }
}

bot.catch((err) => console.error('Bot error:', err));

/* ---------- start (webhook on Render, polling locally) ---------- */
(async () => {
  await db.init();
  ME = await bot.telegram.getMe();
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
