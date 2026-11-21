// AddisAdBot — Delal Ad Marketplace Mini App — server.js (Vercel + Neon Postgres, webhook mode)
// Also runs on a VPS: `node server.js` uses long polling when not on Vercel.
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number

const E = process.env;
const BOT_TOKEN = E.BOT_TOKEN, WEBAPP_URL = (E.WEBAPP_URL || '').replace(/\/$/, ''), SECRET = E.SECRET;
const ADMINS = (E.ADMIN_IDS || '').split(',').map(s => +s.trim()).filter(Boolean);
const OWNER_SHARE = +E.OWNER_SHARE || 70, REF_PERCENT = +E.REF_PERCENT || 5, PRICE_PER_1K = +E.PRICE_PER_1K || 5;
const MIN_PRICE = +E.MIN_PRICE || 20, PIN_PRICE = +E.PIN_PRICE || 30, MIN_WITHDRAW = +E.MIN_WITHDRAW || 100;
const PAY_INFO = E.PAY_INFO || 'Telebirr: 09XXXXXXXX (Name)\nCBE: 1000XXXXXXXXX (Name)';
const ON_VERCEL = !!E.VERCEL;
if (!BOT_TOKEN || !WEBAPP_URL || !E.DATABASE_URL || !SECRET) { console.log('Set BOT_TOKEN, WEBAPP_URL, DATABASE_URL, SECRET'); if (!ON_VERCEL) process.exit(1); }

// ---------- Database (Neon Postgres) ----------
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
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, balance DOUBLE PRECISION DEFAULT 0, ref BIGINT, code TEXT);
ALTER TABLE users ADD COLUMN IF NOT EXISTS code TEXT;
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
const say = (id, text, extra = {}) => safe('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const sendAd = (chat, o, extra = {}) => o.photo
  ? tg('sendPhoto', { chat_id: chat, photo: o.photo, caption: o.html, parse_mode: 'HTML', ...extra })
  : tg('sendMessage', { chat_id: chat, text: o.html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const toAdmins = fn => Promise.all(ADMINS.map(a => Promise.resolve(fn(a)).catch(e => console.log('admin', e.message))));
const kb = (...rows) => ({ inline_keyboard: rows });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const birr = n => (Math.round(n * 100) / 100) + ' ETB';
const nm = c => c.username ? '@' + c.username : c.title;
let BOT_ID = 0;
const botId = async () => BOT_ID || (BOT_ID = (await tg('getMe')).id);
const menuKb = () => kb(
  [{ text: 'Advertiser', web_app: { url: WEBAPP_URL + '/?mode=advertiser' } }],
  [{ text: 'Publisher / Owner Mode', web_app: { url: WEBAPP_URL + '/?mode=publisher' } }]);

// ---------- Data helpers ----------
const userCode = uid => 'AD' + crypto.createHmac('sha256', SECRET || 'x').update(String(uid)).digest('hex').slice(0, 8).toUpperCase();
const upsertUser = (u, ref) => q('INSERT INTO users(id,name,ref,code) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, code=COALESCE(users.code,EXCLUDED.code)',
  [u.id, u.first_name || u.username || '', ref && ref !== u.id ? ref : null, userCode(u.id)]);
const credit = (uid, amt) => q('UPDATE users SET balance=balance+$1 WHERE id=$2', [amt, uid]);
const chPrice = c => c.custom_price || Math.max(MIN_PRICE, Math.round(c.subs / 1000 * PRICE_PER_1K));

// Register a channel or group (used by the Mini App and by /connect)
async function registerChat(chat, ownerId, price) {
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) return { error: 'This chat is not a channel or group.' };
  const m = await tg('getChatMember', { chat_id: chat.id, user_id: ownerId }).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return { error: 'You are not an administrator of this chat.' };
  const b = await tg('getChatMember', { chat_id: chat.id, user_id: await botId() }).catch(() => null);
  if (!b || b.status !== 'administrator') return { error: 'Add the bot as an administrator first (Post Messages for channels, Send Messages & Photos for groups).' };
  if (await one('SELECT 1 FROM channels WHERE chat_id=$1', [String(chat.id)])) return { error: 'This chat is already registered.' };
  const subs = await tg('getChatMemberCount', { chat_id: chat.id });
  if (price && price < MIN_PRICE) price = MIN_PRICE;
  const { id } = await one('INSERT INTO channels(chat_id,username,title,owner_id,subs,custom_price) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [String(chat.id), chat.username || null, chat.title, ownerId, subs, price || null]);
  await toAdmins(a => say(a, `<b>New ${chat.type === 'channel' ? 'channel' : 'group'} request</b>\n${esc(nm({ username: chat.username, title: chat.title }))} — ${esc(chat.title)}\n${subs} members\nOwner: <a href="tg://user?id=${ownerId}">${ownerId}</a>\nPrice: ${birr(chPrice({ subs, custom_price: price }))}/hour`,
    { reply_markup: kb([{ text: 'Approve', callback_data: 'ca:' + id }, { text: 'Reject', callback_data: 'cr:' + id }]) }));
  return { ok: true };
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(async (req, res, next) => {
  try {
    if (!DB_URL) return res.status(500).json({ error: 'DATABASE_URL is missing. Add it in Vercel > Settings > Environment Variables, then redeploy.' });
    await init(); next();
  } catch (e) { console.log('db', e.message); res.status(500).json({ error: 'Database connection failed: ' + e.message }); }
});
const h = fn => (req, res) => fn(req, res).catch(e => { console.log(e); res.status(500).json({ error: 'Server error' }); });

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
  } catch (e) { res.status(401).json({ error: 'Open this app inside Telegram.' }); }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/me', auth, h(async (req, res) => {
  await maybeTick();
  res.json({
    me: await one('SELECT id,name,balance,code FROM users WHERE id=$1', [req.uid]),
    isAdmin: ADMINS.includes(req.uid), payInfo: PAY_INFO, pinPrice: PIN_PRICE, minWithdraw: MIN_WITHDRAW, ownerShare: OWNER_SHARE,
    withdrawals: await q('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.uid])
  });
}));

app.get('/api/channels', auth, h(async (req, res) => {
  const rows = await q("SELECT * FROM channels WHERE status='approved' ORDER BY subs DESC");
  res.json(rows.map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, price: chPrice(c) })));
}));

app.get('/api/mine', auth, h(async (req, res) => {
  const channels = (await q('SELECT * FROM channels WHERE owner_id=$1 ORDER BY id DESC', [req.uid]))
    .map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, status: c.status, price: chPrice(c) }));
  const os = await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.uid]);
  const items = os.length ? await q('SELECT i.order_id,i.status,i.ends_at,c.username,c.title FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=ANY($1::bigint[])', [os.map(o => o.id)]) : [];
  res.json({ channels, orders: os.map(o => ({ id: o.id, code: 'AD' + o.id, total: o.total, hours: o.hours, status: o.status, items: items.filter(i => i.order_id === o.id).map(i => ({ status: i.status, ends_at: i.ends_at, name: nm(i) })) })) });
}));

// Register by public username (private chats: use /connect CODE inside the chat)
app.post('/api/channel', auth, h(async (req, res) => {
  try {
    const un = String(req.body.username || '').trim().replace(/^https?:\/\/t\.me\//, '').replace('@', '');
    if (!/^[A-Za-z0-9_]{4,}$/.test(un)) return res.json({ error: 'Invalid username.' });
    const chat = await tg('getChat', { chat_id: '@' + un });
    res.json(await registerChat(chat, req.uid, +req.body.price || null));
  } catch (e) { res.json({ error: 'Chat not found or error: ' + e.message }); }
}));

// Create an order
app.post('/api/order', auth, h(async (req, res) => {
  const { html, photo, channels, pin } = req.body; const hours = Math.floor(+req.body.hours);
  const text = String(html || '').trim();
  if (!text) return res.json({ error: 'Write your ad text.' });
  if (text.length > (photo ? 1000 : 3500)) return res.json({ error: photo ? 'With a photo, the text must be 1000 characters or less.' : 'The text is too long.' });
  if (photo && !/^https?:\/\//i.test(photo)) return res.json({ error: 'The photo link must start with http(s).' });
  if (!(hours >= 1 && hours <= 168)) return res.json({ error: 'Duration must be between 1 and 168 hours.' });
  if (!Array.isArray(channels) || !channels.length || channels.length > 20) return res.json({ error: 'Select at least one channel or group.' });
  const chs = await q("SELECT * FROM channels WHERE id=ANY($1::bigint[]) AND status='approved'", [channels.map(Number).filter(Number.isFinite)]);
  if (!chs.length) return res.json({ error: 'Selected channels were not found.' });
  const prices = chs.map(c => chPrice(c) * hours + (pin ? PIN_PRICE : 0));
  const total = prices.reduce((a, b) => a + b, 0);
  const { id } = await one('INSERT INTO orders(user_id,html,photo,hours,pin,total,created) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.uid, text, photo || null, hours, pin ? 1 : 0, total, Date.now()]);
  for (let i = 0; i < chs.length; i++) await q('INSERT INTO items(order_id,channel_id,price) VALUES($1,$2,$3)', [id, chs[i].id, prices[i]]);
  res.json({ ok: true, code: 'AD' + id, total });
}));

app.post('/api/withdraw', auth, h(async (req, res) => {
  const amount = +req.body.amount, method = req.body.method === 'CBE' ? 'CBE' : 'Telebirr', account = String(req.body.account || '').trim().slice(0, 60);
  if (!(amount >= MIN_WITHDRAW)) return res.json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} ETB.` });
  if (!account) return res.json({ error: 'Enter your account or phone number.' });
  const held = await one('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING id', [amount, req.uid]); // hold funds atomically
  if (!held) return res.json({ error: 'Insufficient balance.' });
  const { id } = await one('INSERT INTO withdrawals(user_id,amount,method,account,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.uid, amount, method, account, Date.now()]);
  await toAdmins(a => say(a, `<b>Withdrawal request #${id}</b>\n<a href="tg://user?id=${req.uid}">${req.uid}</a>\n${birr(amount)} to ${method}: <code>${esc(account)}</code>`,
    { reply_markup: kb([{ text: 'Mark as paid', callback_data: 'wa:' + id }, { text: 'Reject', callback_data: 'wr:' + id }]) }));
  res.json({ ok: true });
}));

// ---------- Posting + escrow ----------
async function launch(oid) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [oid]);
  const items = await q("SELECT i.*,c.chat_id,c.username,c.title FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1 AND i.status='queued'", [oid]);
  for (const i of items) {
    try {
      const m = await sendAd(i.chat_id, o);
      if (o.pin) await safe('pinChatMessage', { chat_id: i.chat_id, message_id: m.message_id, disable_notification: true });
      await q("UPDATE items SET status='live',msg_id=$1,ends_at=$2 WHERE id=$3", [m.message_id, Date.now() + o.hours * 3600e3, i.id]);
      await say(o.user_id, `Your ad is live on ${esc(nm(i))} for ${o.hours} hour(s).`);
    } catch (e) {
      await q("UPDATE items SET status='failed' WHERE id=$1", [i.id]);
      await credit(o.user_id, i.price); // refund to balance
      await say(o.user_id, `Could not post on ${esc(nm(i))} (${esc(e.message)}). ${birr(i.price)} was refunded to your balance.`);
      await toAdmins(a => say(a, `AD${oid} ${esc(nm(i))} post failed: ${esc(e.message)}`));
    }
  }
  await closeIfDone(oid);
}
const closeIfDone = async oid => {
  if (!(await one("SELECT 1 FROM items WHERE order_id=$1 AND status IN('queued','live','closing')", [oid])))
    await q("UPDATE orders SET status='done' WHERE id=$1 AND status='active'", [oid]);
};
async function tick() {
  const rows = await q("SELECT i.*,c.chat_id,c.owner_id,c.username,c.title,o.user_id uid FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id WHERE i.status='live' AND i.ends_at<=$1", [Date.now()]);
  for (const i of rows) {
    if (!(await one("UPDATE items SET status='closing' WHERE id=$1 AND status='live' RETURNING id", [i.id]))) continue; // claimed by another run
    let removedEarly = false;
    try { await tg('deleteMessage', { chat_id: i.chat_id, message_id: i.msg_id }); }
    catch (e) { removedEarly = /message to delete not found/i.test(e.message); }
    if (removedEarly) {
      await q("UPDATE items SET status='removed' WHERE id=$1", [i.id]);
      await say(i.owner_id, `The ad was deleted from ${esc(nm(i))} before its time ended, so no payment was made.`);
      await toAdmins(a => say(a, `AD${i.order_id}: ad removed early from ${esc(nm(i))} (owner ${i.owner_id}).`));
    } else {
      const pay = i.price * OWNER_SHARE / 100;
      await q("UPDATE items SET status='done' WHERE id=$1", [i.id]);
      await credit(i.owner_id, pay);
      await say(i.owner_id, `Ad AD${i.order_id} finished on ${esc(nm(i))}. ${birr(pay)} was added to your balance.`);
      await say(i.uid, `Your ad AD${i.order_id} finished on ${esc(nm(i))}.`);
    }
    await closeIfDone(i.order_id);
  }
}
let lastTick = 0;
const maybeTick = async () => { if (Date.now() - lastTick < 20000) return; lastTick = Date.now(); await tick().catch(e => console.log('tick', e.message)); };

// ---------- Bot handlers ----------
const WELCOME = `Welcome to <b>AddisAdBot Automation Marketplace</b>!

Launch the <b>Delal</b> Mini App right inside Telegram to book channel/group ad slots or monetize your own channels &amp; groups.

<b>For Channel &amp; Group Owners:</b>
1. Tap <b>Publisher / Owner Mode</b> below.
2. Add this bot as an Administrator in your channel (with Post Messages) or group (with Send Messages &amp; Photos).
3. Verify your channel/group inside the Mini App (or run /connect CODE inside your group).

<b>Useful commands:</b>
• /app — Launch AddisAdBot Mini App
• /connect CODE — Link this group/channel using your verification token
• /id — View your User ID and this Chat ID`;

async function connectCmd(m, code) {
  const chat = m.chat;
  if (chat.type === 'private') return say(chat.id, 'Run /connect CODE inside the group or channel you want to link. Your code is shown in the Mini App under Publisher / Owner Mode.');
  if (!code) return say(chat.id, 'Usage: /connect CODE');
  const u = await one('SELECT id FROM users WHERE code=$1', [code.toUpperCase()]);
  if (!u) return say(chat.id, 'Invalid code. Copy it from the Mini App under Publisher / Owner Mode.');
  const r = await registerChat(chat, u.id, null);
  if (r.error) return say(chat.id, r.error);
  await say(chat.id, 'Connected. Your chat was sent to the administrators for approval.');
  await say(u.id, `Your chat <b>${esc(chat.title)}</b> was submitted for approval. You will be notified when it is approved.`);
}

async function onMessage(m) {
  const raw = m.text || m.caption || '';
  const parts = raw.startsWith('/') ? raw.trim().split(/\s+/) : [];
  const cmd = (parts[0] || '').replace(/@.*$/, '').toLowerCase();
  const uid = m.from && m.from.id, priv = m.chat.type === 'private';
  if (cmd === '/id') return say(m.chat.id, `${uid ? 'Your User ID: <code>' + uid + '</code>\n' : ''}Chat ID: <code>${m.chat.id}</code>`);
  if (cmd === '/connect') return connectCmd(m, parts[1]);
  if (!priv || !uid) return;
  if (cmd === '/start') {
    const ref = +(parts[1] || '').replace('ref_', '') || null;
    await upsertUser(m.from, ref);
    return say(uid, `${WELCOME}\n\nYour referral link: https://t.me/${E.BOT_USERNAME || 'YOUR_BOT'}?start=ref_${uid}`, { reply_markup: menuKb() });
  }
  if (cmd === '/app') return say(uid, 'Open the Delal Mini App:', { reply_markup: menuKb() });
  if (m.photo) { // payment screenshot
    const o = await one("SELECT * FROM orders WHERE user_id=$1 AND status='awaiting_pay' ORDER BY id DESC LIMIT 1", [uid]);
    if (!o) return say(uid, 'You have no order waiting for payment. Create an order in the Mini App first.');
    const p = m.photo[m.photo.length - 1];
    if (!(await one('INSERT INTO shots(uid) VALUES($1) ON CONFLICT DO NOTHING RETURNING uid', [p.file_unique_id]))) return say(uid, 'This screenshot was already used.');
    await q("UPDATE orders SET status='pending' WHERE id=$1", [o.id]);
    await say(uid, `Screenshot received for AD${o.id}. You will be notified when an administrator approves it.`);
    const chs = (await q('SELECT c.username,c.title FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1', [o.id])).map(nm).join(', ');
    await toAdmins(async a => {
      await sendAd(a, o).catch(e => say(a, `The ad HTML has an error: ${esc(e.message)}`));
      await safe('sendPhoto', { chat_id: a, photo: p.file_id, parse_mode: 'HTML',
        caption: `<b>AD${o.id}</b> — ${birr(o.total)}\nUser: <a href="tg://user?id=${uid}">${uid}</a>\nTargets: ${esc(chs)}\n${o.hours} hour(s)${o.pin ? ' + pin' : ''}\nCheck that the code AD${o.id} appears on the payment.`,
        reply_markup: kb([{ text: 'Approve and post', callback_data: 'oa:' + o.id }, { text: 'Reject', callback_data: 'or:' + o.id }]) });
    });
  }
}

async function onCallback(cb) {
  const done = t => safe('answerCallbackQuery', { callback_query_id: cb.id, text: t });
  if (!ADMINS.includes(cb.from.id)) return done('You are not an admin.');
  const [a, sid] = cb.data.split(':'), id = +sid;
  let note = '';
  if (a === 'oa' || a === 'or') {
    const o = await one("UPDATE orders SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'oa' ? 'active' : 'rejected']);
    if (!o) return done('Already handled.');
    if (a === 'oa') {
      const ref = (await one('SELECT ref FROM users WHERE id=$1', [o.user_id]))?.ref;
      if (ref) { await credit(ref, o.total * REF_PERCENT / 100); await say(ref, `Referral commission of ${birr(o.total * REF_PERCENT / 100)} was added to your balance.`); }
      await say(o.user_id, `Payment approved for AD${id}. Your ad is being posted now.`);
      await launch(id); note = 'Approved';
    } else { await say(o.user_id, `Order AD${id} was rejected. If you think this is a mistake, contact the administrator.`); note = 'Rejected'; }
  } else if (a === 'ca' || a === 'cr') {
    const c = await one("UPDATE channels SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'ca' ? 'approved' : 'rejected']);
    if (!c) return done('Already handled.');
    await say(c.owner_id, a === 'ca' ? `Your chat ${esc(nm(c))} was approved. You can now receive ads.` : `Your chat ${esc(nm(c))} was not approved.`);
    note = a === 'ca' ? 'Approved' : 'Rejected';
  } else if (a === 'wa' || a === 'wr') {
    const w = await one("UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'wa' ? 'paid' : 'rejected']);
    if (!w) return done('Already handled.');
    if (a === 'wa') { await say(w.user_id, `${birr(w.amount)} was sent to your ${w.method} account.`); note = 'Paid'; }
    else { await credit(w.user_id, w.amount); await say(w.user_id, `Your withdrawal was rejected. ${birr(w.amount)} was returned to your balance.`); note = 'Rejected'; }
  }
  await safe('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'x' }]] } });
  await done(note);
}
const handle = async u => {
  if (u.message) await onMessage(u.message);
  if (u.channel_post) await onMessage(u.channel_post);
  if (u.callback_query) await onCallback(u.callback_query);
};
const UPDATES = ['message', 'channel_post', 'callback_query'];
const MENU = () => ({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: WEBAPP_URL } } });
const COMMANDS = [{ command: 'start', description: 'Welcome and open the app' }, { command: 'app', description: 'Launch the Delal Mini App' }, { command: 'connect', description: 'Link this group/channel with your code' }, { command: 'id', description: 'Show your User ID and Chat ID' }];

// ---------- Webhook, setup and cron (Vercel) ----------
app.post('/webhook/:key', async (req, res) => {
  if (req.params.key !== SECRET) return res.sendStatus(403);
  try { await handle(req.body); await maybeTick(); } catch (e) { console.log('webhook', e.message); }
  res.sendStatus(200); // always 200 so Telegram doesn't retry
});
app.get('/api/setup', h(async (req, res) => { // open once after every deploy that changes updates/commands: /api/setup?key=SECRET
  if (req.query.key !== SECRET) return res.sendStatus(403);
  await tg('setWebhook', { url: `${WEBAPP_URL}/webhook/${SECRET}`, allowed_updates: UPDATES, drop_pending_updates: true });
  await safe('setChatMenuButton', MENU());
  await safe('setMyCommands', { commands: COMMANDS });
  res.send('OK: webhook, menu button and commands set');
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
    await safe('setChatMenuButton', MENU());
    await safe('setMyCommands', { commands: COMMANDS });
    let offset = 0;
    for (;;) {
      try {
        const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: UPDATES });
        for (const u of ups) { offset = u.update_id + 1; await handle(u).catch(e => console.log('upd', e.message)); }
      } catch (e) { console.log('poll', e.message); await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}
