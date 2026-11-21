// Ad Marketplace Mini App — server.js (Vercel + Neon Postgres, webhook mode)
// Also runs on a VPS: `node server.js` uses long polling when not on Vercel.
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number

const E = process.env;
const BOT_TOKEN = E.BOT_TOKEN, WEBAPP_URL = (E.WEBAPP_URL || '').replace(/\/$/, ''), SECRET = E.SECRET;
const ADMINS = (E.ADMIN_IDS || '').split(',').map(s => +s.trim()).filter(Boolean);
const OWNER_SHARE = +E.OWNER_SHARE || 70, REF_PERCENT = +E.REF_PERCENT || 5, PRICE_PER_1K = +E.PRICE_PER_1K || 5;
const MIN_PRICE = +E.MIN_PRICE || 20, PIN_PRICE = +E.PIN_PRICE || 30, MIN_WITHDRAW = +E.MIN_WITHDRAW || 100;
const PAY_INFO = E.PAY_INFO || 'Telebirr: 09XXXXXXXX (ስም)\nCBE: 1000XXXXXXXXX (ስም)';
const ON_VERCEL = !!E.VERCEL;
if (!BOT_TOKEN || !WEBAPP_URL || !E.DATABASE_URL || !SECRET) { console.log('Set BOT_TOKEN, WEBAPP_URL, DATABASE_URL, SECRET'); if (!ON_VERCEL) process.exit(1); }

// ---------- Database (Postgres) ----------
// Neon Postgres: paste Neon's *pooled* connection string into DATABASE_URL.
// Clean common paste mistakes: psql '...' wrapper, quotes, channel_binding (not supported by node-pg)
const DB_URL = (E.DATABASE_URL || '').trim().replace(/^psql\s+/, '').replace(/^['"]|['"]$/g, '').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },      // Neon requires SSL
  max: ON_VERCEL ? 1 : 5,                  // one connection per serverless instance
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000           // allows Neon to wake from idle
});
const q = (t, p = []) => pool.query(t, p).then(r => r.rows);
const one = async (t, p) => (await q(t, p))[0];
let ready;
const init = () => ready || (ready = q(`
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, balance DOUBLE PRECISION DEFAULT 0, ref BIGINT);
CREATE TABLE IF NOT EXISTS channels(id BIGSERIAL PRIMARY KEY, chat_id TEXT UNIQUE, username TEXT, title TEXT, owner_id BIGINT, subs INTEGER, custom_price DOUBLE PRECISION, status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY, user_id BIGINT, html TEXT, photo TEXT, hours INTEGER, pin INTEGER, total DOUBLE PRECISION, status TEXT DEFAULT 'awaiting_pay', created BIGINT);
CREATE TABLE IF NOT EXISTS items(id BIGSERIAL PRIMARY KEY, order_id BIGINT, channel_id BIGINT, price DOUBLE PRECISION, msg_id BIGINT, ends_at BIGINT, status TEXT DEFAULT 'queued');
CREATE TABLE IF NOT EXISTS withdrawals(id BIGSERIAL PRIMARY KEY, user_id BIGINT, amount DOUBLE PRECISION, method TEXT, account TEXT, status TEXT DEFAULT 'pending', created BIGINT);
CREATE TABLE IF NOT EXISTS shots(uid TEXT PRIMARY KEY);
`).catch(e => { ready = null; throw e; }));

// ---------- Telegram helpers ----------
async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description);
  return j.result;
}
const safe = (m, b) => tg(m, b).catch(e => { console.log(m, e.message); return null; });
const say = (id, text, extra = {}) => safe('sendMessage', { chat_id: id, text, parse_mode: 'HTML', ...extra });
const sendAd = (chat, o, extra = {}) => o.photo
  ? tg('sendPhoto', { chat_id: chat, photo: o.photo, caption: o.html, parse_mode: 'HTML', ...extra })
  : tg('sendMessage', { chat_id: chat, text: o.html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const toAdmins = fn => Promise.all(ADMINS.map(a => Promise.resolve(fn(a)).catch(e => console.log('admin', e.message))));
const kb = (...rows) => ({ inline_keyboard: rows });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const birr = n => (Math.round(n * 100) / 100) + ' ብር';
let BOT_ID = 0;
const botId = async () => BOT_ID || (BOT_ID = (await tg('getMe')).id);

// ---------- Data helpers ----------
const upsertUser = (u, ref) => q('INSERT INTO users(id,name,ref) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name',
  [u.id, u.first_name || u.username || '', ref && ref !== u.id ? ref : null]);
const credit = (uid, amt) => q('UPDATE users SET balance=balance+$1 WHERE id=$2', [amt, uid]);
const chPrice = c => c.custom_price || Math.max(MIN_PRICE, Math.round(c.subs / 1000 * PRICE_PER_1K));

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(async (req, res, next) => { try { await init(); next(); } catch (e) { console.log('db', e.message); res.status(500).json({ error: 'የዳታቤዝ ግንኙነት አልተሳካም: ' + e.message }); } });
const h = fn => (req, res) => fn(req, res).catch(e => { console.log(e); res.status(500).json({ error: 'የሰርቨር ስህተት' }); });

async function auth(req, res, next) {
  try {
    const p = new URLSearchParams(req.get('x-init-data') || '');
    const hash = p.get('hash'); p.delete('hash');
    const check = [...p].map(([k, v]) => k + '=' + v).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (crypto.createHmac('sha256', key).update(check).digest('hex') !== hash) throw 0;
    if (Date.now() / 1000 - +p.get('auth_date') > 86400) throw 0;
    const u = JSON.parse(p.get('user'));
    await upsertUser(u); req.uid = u.id; next();
  } catch (e) { res.status(401).json({ error: 'ይህን መተግበሪያ በTelegram ውስጥ ክፈት' }); }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/me', auth, h(async (req, res) => {
  await maybeTick();
  res.json({
    me: await one('SELECT id,name,balance FROM users WHERE id=$1', [req.uid]),
    isAdmin: ADMINS.includes(req.uid), payInfo: PAY_INFO, pinPrice: PIN_PRICE, minWithdraw: MIN_WITHDRAW, ownerShare: OWNER_SHARE,
    withdrawals: await q('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.uid])
  });
}));

app.get('/api/channels', auth, h(async (req, res) => {
  const rows = await q("SELECT * FROM channels WHERE status='approved' ORDER BY subs DESC");
  res.json(rows.map(c => ({ id: c.id, title: c.title, username: c.username, subs: c.subs, price: chPrice(c) })));
}));

app.get('/api/mine', auth, h(async (req, res) => {
  const channels = (await q('SELECT * FROM channels WHERE owner_id=$1 ORDER BY id DESC', [req.uid]))
    .map(c => ({ id: c.id, title: c.title, username: c.username, subs: c.subs, status: c.status, price: chPrice(c) }));
  const os = await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.uid]);
  const items = os.length ? await q('SELECT i.order_id,i.status,i.ends_at,c.username FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=ANY($1::bigint[])', [os.map(o => o.id)]) : [];
  res.json({ channels, orders: os.map(o => ({ id: o.id, code: 'AD' + o.id, total: o.total, hours: o.hours, status: o.status, items: items.filter(i => i.order_id === o.id) })) });
}));

// Register a channel (auto-verifies admin rights + subscriber count)
app.post('/api/channel', auth, h(async (req, res) => {
  try {
    const un = String(req.body.username || '').trim().replace(/^https?:\/\/t\.me\//, '').replace('@', '');
    if (!/^[A-Za-z0-9_]{4,}$/.test(un)) return res.json({ error: 'የቻናል username ትክክል አይደለም' });
    const chat = await tg('getChat', { chat_id: '@' + un });
    if (chat.type !== 'channel') return res.json({ error: 'ይህ ቻናል አይደለም' });
    const m = await tg('getChatMember', { chat_id: chat.id, user_id: req.uid }).catch(() => null);
    if (!m || !['creator', 'administrator'].includes(m.status)) return res.json({ error: 'አንተ የዚህ ቻናል አድሚን አይደለህም' });
    const b = await tg('getChatMember', { chat_id: chat.id, user_id: await botId() }).catch(() => null);
    if (!b || b.status !== 'administrator') return res.json({ error: 'መጀመሪያ ቦቱን የቻናሉ አድሚን አድርገው (መለጠፍ እና መሰረዝ ፍቃድ ጋር)' });
    const subs = await tg('getChatMemberCount', { chat_id: chat.id });
    if (await one('SELECT 1 FROM channels WHERE chat_id=$1', [String(chat.id)])) return res.json({ error: 'ይህ ቻናል ቀድሞ ተመዝግቧል' });
    let price = +req.body.price || null; if (price && price < MIN_PRICE) price = MIN_PRICE;
    const { id } = await one('INSERT INTO channels(chat_id,username,title,owner_id,subs,custom_price) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [String(chat.id), un, chat.title, req.uid, subs, price]);
    await toAdmins(a => say(a, `<b>አዲስ ቻናል</b>\n@${esc(un)} — ${esc(chat.title)}\n${subs} subscribers\nባለቤት: <a href="tg://user?id=${req.uid}">${req.uid}</a>\nዋጋ: ${birr(chPrice({ subs, custom_price: price }))}/ሰዓት`,
      { reply_markup: kb([{ text: 'ፍቀድ', callback_data: 'ca:' + id }, { text: 'ውድቅ', callback_data: 'cr:' + id }]) }));
    res.json({ ok: true });
  } catch (e) { res.json({ error: 'ቻናሉ አልተገኘም ወይም ስህተት ተፈጠረ: ' + e.message }); }
}));

// Create an order
app.post('/api/order', auth, h(async (req, res) => {
  const { html, photo, channels, pin } = req.body; const hours = Math.floor(+req.body.hours);
  const text = String(html || '').trim();
  if (!text) return res.json({ error: 'የማስታወቂያ ጽሑፍ ጻፍ' });
  if (text.length > (photo ? 1000 : 3500)) return res.json({ error: photo ? 'ከፎቶ ጋር ጽሑፉ ከ1000 ፊደል መብለጥ የለበትም' : 'ጽሑፉ በጣም ረጅም ነው' });
  if (photo && !/^https?:\/\//i.test(photo)) return res.json({ error: 'የፎቶ link በ http(s) መጀመር አለበት' });
  if (!(hours >= 1 && hours <= 168)) return res.json({ error: 'ሰዓት ከ1 እስከ 168 መሆን አለበት' });
  if (!Array.isArray(channels) || !channels.length || channels.length > 20) return res.json({ error: 'ቢያንስ አንድ ቻናል ምረጥ' });
  const chs = await q("SELECT * FROM channels WHERE id=ANY($1::bigint[]) AND status='approved'", [channels.map(Number).filter(Number.isFinite)]);
  if (!chs.length) return res.json({ error: 'የተመረጡ ቻናሎች አልተገኙም' });
  const prices = chs.map(c => chPrice(c) * hours + (pin ? PIN_PRICE : 0));
  const total = prices.reduce((a, b) => a + b, 0);
  const { id } = await one('INSERT INTO orders(user_id,html,photo,hours,pin,total,created) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.uid, text, photo || null, hours, pin ? 1 : 0, total, Date.now()]);
  for (let i = 0; i < chs.length; i++) await q('INSERT INTO items(order_id,channel_id,price) VALUES($1,$2,$3)', [id, chs[i].id, prices[i]]);
  res.json({ ok: true, code: 'AD' + id, total });
}));

app.post('/api/withdraw', auth, h(async (req, res) => {
  const amount = +req.body.amount, method = req.body.method === 'CBE' ? 'CBE' : 'Telebirr', account = String(req.body.account || '').trim().slice(0, 60);
  if (!(amount >= MIN_WITHDRAW)) return res.json({ error: `ዝቅተኛው ወጪ ${MIN_WITHDRAW} ብር ነው` });
  if (!account) return res.json({ error: 'የአካውንት ቁጥር ጻፍ' });
  const held = await one('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING id', [amount, req.uid]); // hold funds atomically
  if (!held) return res.json({ error: 'ባላንስህ አይበቃም' });
  const { id } = await one('INSERT INTO withdrawals(user_id,amount,method,account,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.uid, amount, method, account, Date.now()]);
  await toAdmins(a => say(a, `<b>ወጪ ጥያቄ #${id}</b>\n<a href="tg://user?id=${req.uid}">${req.uid}</a>\n${birr(amount)} → ${method}: <code>${esc(account)}</code>`,
    { reply_markup: kb([{ text: 'ተከፍሏል', callback_data: 'wa:' + id }, { text: 'ውድቅ', callback_data: 'wr:' + id }]) }));
  res.json({ ok: true });
}));

// ---------- Posting + escrow ----------
async function launch(oid) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [oid]);
  const items = await q("SELECT i.*,c.chat_id,c.username FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1 AND i.status='queued'", [oid]);
  for (const i of items) {
    try {
      const m = await sendAd(i.chat_id, o);
      if (o.pin) await safe('pinChatMessage', { chat_id: i.chat_id, message_id: m.message_id, disable_notification: true });
      await q("UPDATE items SET status='live',msg_id=$1,ends_at=$2 WHERE id=$3", [m.message_id, Date.now() + o.hours * 3600e3, i.id]);
      await say(o.user_id, `ማስታወቂያህ @${i.username} ላይ ተለጥፏል። ለ${o.hours} ሰዓት ይቆያል።`);
    } catch (e) {
      await q("UPDATE items SET status='failed' WHERE id=$1", [i.id]);
      await credit(o.user_id, i.price); // refund to balance
      await say(o.user_id, `@${i.username} ላይ መለጠፍ አልተቻለም (${esc(e.message)}). ${birr(i.price)} ወደ ባላንስህ ተመልሷል።`);
      await toAdmins(a => say(a, `AD${oid} @${i.username} post failed: ${esc(e.message)}`));
    }
  }
  await closeIfDone(oid);
}
const closeIfDone = async oid => {
  if (!(await one("SELECT 1 FROM items WHERE order_id=$1 AND status IN('queued','live','closing')", [oid])))
    await q("UPDATE orders SET status='done' WHERE id=$1 AND status='active'", [oid]);
};
async function tick() {
  const rows = await q("SELECT i.*,c.chat_id,c.owner_id,c.username,o.user_id uid FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id WHERE i.status='live' AND i.ends_at<=$1", [Date.now()]);
  for (const i of rows) {
    if (!(await one("UPDATE items SET status='closing' WHERE id=$1 AND status='live' RETURNING id", [i.id]))) continue; // claimed by another run
    let removedEarly = false;
    try { await tg('deleteMessage', { chat_id: i.chat_id, message_id: i.msg_id }); }
    catch (e) { removedEarly = /message to delete not found/i.test(e.message); }
    if (removedEarly) {
      await q("UPDATE items SET status='removed' WHERE id=$1", [i.id]);
      await say(i.owner_id, `ማስታወቂያው ሰዓቱ ሳያልቅ ከ@${i.username} ተሰርዟል፤ ክፍያ አልተሰጠም።`);
      await toAdmins(a => say(a, `AD${i.order_id}: ad removed early from @${i.username} (owner ${i.owner_id}).`));
    } else {
      const pay = i.price * OWNER_SHARE / 100;
      await q("UPDATE items SET status='done' WHERE id=$1", [i.id]);
      await credit(i.owner_id, pay);
      await say(i.owner_id, `ማስታወቂያ AD${i.order_id} በ@${i.username} ተጠናቋል። ${birr(pay)} ባላንስህ ላይ ተጨምሯል።`);
      await say(i.uid, `ማስታወቂያህ AD${i.order_id} በ@${i.username} ተጠናቋል።`);
    }
    await closeIfDone(i.order_id);
  }
}
let lastTick = 0;
const maybeTick = async () => { if (Date.now() - lastTick < 20000) return; lastTick = Date.now(); await tick().catch(e => console.log('tick', e.message)); };

// ---------- Bot handlers ----------
async function onMessage(m) {
  const uid = m.from.id;
  if (m.text && m.text.startsWith('/start')) {
    const ref = +(m.text.split(' ')[1] || '').replace('ref_', '') || null;
    await upsertUser(m.from, ref);
    return say(uid, `ሰላም <b>${esc(m.from.first_name)}</b>\nማስታወቂያ ለማስነገር ወይም ቻናልህን አስመዝግበህ ገቢ ለማግኘት ከታች ያለውን ቁልፍ ተጫን።\n\nየሪፈራል link: https://t.me/${E.BOT_USERNAME || 'YOUR_BOT'}?start=ref_${uid}`,
      { reply_markup: kb([{ text: 'መተግበሪያውን ክፈት', web_app: { url: WEBAPP_URL } }]) });
  }
  if (m.photo) { // payment screenshot
    const o = await one("SELECT * FROM orders WHERE user_id=$1 AND status='awaiting_pay' ORDER BY id DESC LIMIT 1", [uid]);
    if (!o) return say(uid, 'የሚከፈልበት ትዕዛዝ የለም። መጀመሪያ በመተግበሪያው ትዕዛዝ ፍጠር።');
    const p = m.photo[m.photo.length - 1];
    if (!(await one('INSERT INTO shots(uid) VALUES($1) ON CONFLICT DO NOTHING RETURNING uid', [p.file_unique_id]))) return say(uid, 'ይህ ስክሪንሾት ቀድሞ ጥቅም ላይ ውሏል።');
    await q("UPDATE orders SET status='pending' WHERE id=$1", [o.id]);
    await say(uid, `ስክሪንሾቱ ደርሷል (AD${o.id})። አድሚን ሲያጸድቅ ይነገርሃል።`);
    const chs = (await q('SELECT c.username FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1', [o.id])).map(c => '@' + c.username).join(', ');
    await toAdmins(async a => {
      await sendAd(a, o).catch(e => say(a, `የማስታወቂያው HTML ስህተት አለው: ${esc(e.message)}`));
      await safe('sendPhoto', { chat_id: a, photo: p.file_id, parse_mode: 'HTML',
        caption: `<b>AD${o.id}</b> — ${birr(o.total)}\nተጠቃሚ: <a href="tg://user?id=${uid}">${uid}</a>\nቻናሎች: ${esc(chs)}\n${o.hours} ሰዓት${o.pin ? ' + pin' : ''}\nኮዱ (AD${o.id}) በክፍያው ላይ መኖሩን አረጋግጥ።`,
        reply_markup: kb([{ text: 'ፍቀድ እና ለጥፍ', callback_data: 'oa:' + o.id }, { text: 'ውድቅ', callback_data: 'or:' + o.id }]) });
    });
  }
}

async function onCallback(cb) {
  const done = t => safe('answerCallbackQuery', { callback_query_id: cb.id, text: t });
  if (!ADMINS.includes(cb.from.id)) return done('አድሚን አይደለህም');
  const [a, sid] = cb.data.split(':'), id = +sid;
  let note = '';
  if (a === 'oa' || a === 'or') {
    const o = await one("UPDATE orders SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'oa' ? 'active' : 'rejected']);
    if (!o) return done('ቀድሞ ተወስኗል');
    if (a === 'oa') {
      const ref = (await one('SELECT ref FROM users WHERE id=$1', [o.user_id]))?.ref;
      if (ref) { await credit(ref, o.total * REF_PERCENT / 100); await say(ref, `የሪፈራል ኮሚሽን ${birr(o.total * REF_PERCENT / 100)} ተጨምሯል።`); }
      await say(o.user_id, `ክፍያህ ጸድቋል (AD${id})። ማስታወቂያህ አሁን እየተለጠፈ ነው።`);
      await launch(id); note = 'ጸድቋል';
    } else { await say(o.user_id, `ትዕዛዝ AD${id} ውድቅ ሆኗል። ክፍያው ወይም ይዘቱ ችግር ካለው አድሚኑን አነጋግር።`); note = 'ውድቅ'; }
  } else if (a === 'ca' || a === 'cr') {
    const c = await one("UPDATE channels SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'ca' ? 'approved' : 'rejected']);
    if (!c) return done('ቀድሞ ተወስኗል');
    await say(c.owner_id, a === 'ca' ? `ቻናልህ @${c.username} ጸድቋል! አሁን ማስታወቂያ መቀበል ትችላለህ።` : `ቻናልህ @${c.username} አልጸደቀም።`);
    note = a === 'ca' ? 'ጸድቋል' : 'ውድቅ';
  } else if (a === 'wa' || a === 'wr') {
    const w = await one("UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'wa' ? 'paid' : 'rejected']);
    if (!w) return done('ቀድሞ ተወስኗል');
    if (a === 'wa') { await say(w.user_id, `${birr(w.amount)} ወደ ${w.method} ተልኳል።`); note = 'ተከፍሏል'; }
    else { await credit(w.user_id, w.amount); await say(w.user_id, `የወጪ ጥያቄህ ውድቅ ሆኗል፤ ${birr(w.amount)} ወደ ባላንስህ ተመልሷል።`); note = 'ውድቅ'; }
  }
  await safe('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'x' }]] } });
  await done(note);
}
const handle = async u => { if (u.message) await onMessage(u.message); if (u.callback_query) await onCallback(u.callback_query); };

// ---------- Webhook, setup and cron (Vercel) ----------
app.post('/webhook/:key', async (req, res) => {
  if (req.params.key !== SECRET) return res.sendStatus(403);
  try { await handle(req.body); await maybeTick(); } catch (e) { console.log('webhook', e.message); }
  res.sendStatus(200); // always 200 so Telegram doesn't retry
});
app.get('/api/setup', h(async (req, res) => { // open once in the browser after deploying: /api/setup?key=SECRET
  if (req.query.key !== SECRET) return res.sendStatus(403);
  await tg('setWebhook', { url: `${WEBAPP_URL}/webhook/${SECRET}`, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  await safe('setChatMenuButton', { menu_button: { type: 'web_app', text: 'ክፈት', web_app: { url: WEBAPP_URL } } });
  res.send('OK: webhook + menu button set');
}));
app.get('/api/cron', h(async (req, res) => { // ping every minute: /api/cron?key=SECRET
  if (req.query.key !== SECRET) return res.sendStatus(403);
  await tick(); res.send('ok');
}));

module.exports = app;

// ---------- VPS mode (long polling) ----------
if (!ON_VERCEL && require.main === module) {
  (async () => {
    await init(); await botId();
    app.listen(E.PORT || 3000, () => console.log('Server on', E.PORT || 3000));
    setInterval(() => tick().catch(e => console.log('tick', e.message)), 30000);
    await safe('deleteWebhook', {});
    await safe('setChatMenuButton', { menu_button: { type: 'web_app', text: 'ክፈት', web_app: { url: WEBAPP_URL } } });
    let offset = 0;
    for (;;) {
      try {
        const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        for (const u of ups) { offset = u.update_id + 1; await handle(u).catch(e => console.log('upd', e.message)); }
      } catch (e) { console.log('poll', e.message); await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}
