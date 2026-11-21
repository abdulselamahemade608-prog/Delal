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
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_earned DOUBLE PRECISION DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS subs_at BIGINT DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_at BIGINT DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btn_text TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btn_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tx_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount DOUBLE PRECISION DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reminded INTEGER DEFAULT 0;
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, percent INTEGER, uses INTEGER);
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
const CHAPA = E.CHAPA_SECRET;
const CATS = ['news', 'sports', 'business', 'tech', 'music', 'education', 'other'];
const RL = new Map();
const limited = (key, n) => { const k = key + ':' + Math.floor(Date.now() / 60000); const c = (RL.get(k) || 0) + 1; RL.set(k, c); if (RL.size > 5000) RL.clear(); return c > n; };
const LANG = new Map();
const getLang = async uid => { if (LANG.has(uid)) return LANG.get(uid); const r = await one('SELECT lang FROM users WHERE id=$1', [uid]); const l = r && r.lang === 'am' ? 'am' : 'en'; LANG.set(uid, l); return l; };
const M = {
  live: { en: (n, h) => `Your ad is live on ${n} for ${h} hour(s).`, am: (n, h) => `ማስታወቂያዎ በ${n} ላይ ለ${h} ሰዓት ተለጥፏል።` },
  fin_adv: { en: (c, n, k) => `Your ad ${c} finished on ${n}.${k ? ' Button clicks: ' + k + '.' : ''}`, am: (c, n, k) => `ማስታወቂያዎ ${c} በ${n} ላይ ተጠናቋል።${k ? ' የቁልፍ ጠቅታዎች: ' + k + '።' : ''}` },
  fin_own: { en: (c, n, a) => `Ad ${c} finished on ${n}. ${a} was added to your balance.`, am: (c, n, a) => `ማስታወቂያ ${c} በ${n} ላይ ተጠናቋል። ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  approved: { en: c => `Payment approved for ${c}.`, am: c => `የ${c} ክፍያ ጸድቋል።` },
  sched: { en: (c, w) => `${c} is scheduled and will be posted at ${w}.`, am: (c, w) => `${c} በ${w} ይለጠፋል።` },
  rejected: { en: c => `Order ${c} was rejected. If you think this is a mistake, contact the administrator.`, am: c => `ትዕዛዝ ${c} ተቀባይነት አላገኘም። ስህተት ነው ብለው ካሰቡ አድሚኑን ያነጋግሩ።` },
  refund_fail: { en: (n, e, a) => `Could not post on ${n} (${e}). ${a} was refunded to your balance.`, am: (n, e, a) => `በ${n} ላይ መለጠፍ አልተቻለም (${e})። ${a} ወደ ሒሳብዎ ተመልሷል።` },
  removed_own: { en: n => `The ad was deleted from ${n} before its time ended, so no payment was made.`, am: n => `ማስታወቂያው ጊዜው ሳያልቅ ከ${n} ስለተሰረዘ ክፍያ አልተፈጸመም።` },
  removed_adv: { en: (n, a) => `Your ad was removed early from ${n}. ${a} was refunded to your balance.`, am: (n, a) => `ማስታወቂያዎ ከ${n} ቀድሞ ስለተሰረዘ ${a} ወደ ሒሳብዎ ተመልሷል።` },
  remind: { en: (c, n) => `Your ad ${c} on ${n} ends in about 1 hour. You can repeat it from the Orders tab.`, am: (c, n) => `ማስታወቂያ ${c} በ${n} ላይ በ1 ሰዓት ውስጥ ያልቃል። ከ"Orders" ገጽ መድገም ይችላሉ።` },
  ref: { en: a => `Referral commission of ${a} was added to your balance.`, am: a => `የሪፈራል ኮሚሽን ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  expired: { en: c => `Order ${c} expired because it was not paid within 24 hours.`, am: c => `ትዕዛዝ ${c} በ24 ሰዓት ውስጥ ስላልተከፈለ ጊዜው አልፏል።` },
  chan_ok: { en: n => `Your chat ${n} was approved. You can now receive ads.`, am: n => `${n} ጸድቋል። አሁን ማስታወቂያ መቀበል ይችላሉ።` },
  chan_no: { en: n => `Your chat ${n} was not approved.`, am: n => `${n} አልጸደቀም።` },
  wd_paid: { en: (a, m) => `${a} was sent to your ${m} account.`, am: (a, m) => `${a} ወደ ${m} ሒሳብዎ ተልኳል።` },
  wd_rej: { en: a => `Your withdrawal was rejected. ${a} was returned to your balance.`, am: a => `የገንዘብ ማውጫ ጥያቄዎ ተቀባይነት አላገኘም። ${a} ወደ ሒሳብዎ ተመልሷል።` }
};
const say2 = async (uid, key, ...a) => say(uid, M[key][await getLang(uid)](...a));
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
async function registerChat(chat, ownerId, price, category) {
  const cat = CATS.includes(category) ? category : 'other';
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) return { error: 'This chat is not a channel or group.' };
  const m = await tg('getChatMember', { chat_id: chat.id, user_id: ownerId }).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return { error: 'You are not an administrator of this chat.' };
  const b = await tg('getChatMember', { chat_id: chat.id, user_id: await botId() }).catch(() => null);
  if (!b || b.status !== 'administrator') return { error: 'Add the bot as an administrator first (Post Messages for channels, Send Messages & Photos for groups).' };
  if (await one('SELECT 1 FROM channels WHERE chat_id=$1', [String(chat.id)])) return { error: 'This chat is already registered.' };
  const subs = await tg('getChatMemberCount', { chat_id: chat.id });
  if (price && price < MIN_PRICE) price = MIN_PRICE;
  const { id } = await one('INSERT INTO channels(chat_id,username,title,owner_id,subs,custom_price,category) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [String(chat.id), chat.username || null, chat.title, ownerId, subs, price || null, cat]);
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
    await upsertUser(u);
    const bu = await one('SELECT banned FROM users WHERE id=$1', [u.id]);
    if (bu && bu.banned) return res.status(403).json({ error: 'Your account is blocked.' });
    if (limited('u' + u.id, 90)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    req.uid = u.id; next();
  } catch (e) { res.status(401).json({ error: 'Open this app inside Telegram.' }); }
}

const adm = (req, res, next) => ADMINS.includes(req.uid) ? next() : res.status(403).json({ error: 'Admins only.' });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/me', auth, h(async (req, res) => {
  await maybeTick();
  res.json({
    me: await one('SELECT id,name,balance,code,lang,ref_earned FROM users WHERE id=$1', [req.uid]),
    refCount: (await one('SELECT COUNT(*) n FROM users WHERE ref=$1', [req.uid])).n, botUsername: E.BOT_USERNAME || '', chapa: !!CHAPA, cats: CATS, refPercent: REF_PERCENT,
    isAdmin: ADMINS.includes(req.uid), payInfo: PAY_INFO, pinPrice: PIN_PRICE, minWithdraw: MIN_WITHDRAW, ownerShare: OWNER_SHARE,
    withdrawals: await q('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.uid])
  });
}));

app.get('/api/channels', auth, h(async (req, res) => {
  const rows = await q("SELECT * FROM channels WHERE status='approved' ORDER BY subs DESC");
  res.json(rows.map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, price: chPrice(c), category: c.category || 'other' })));
}));

app.get('/api/mine', auth, h(async (req, res) => {
  const channels = (await q('SELECT * FROM channels WHERE owner_id=$1 ORDER BY id DESC', [req.uid]))
    .map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, status: c.status, price: chPrice(c), category: c.category || 'other' }));
  const os = await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.uid]);
  const items = os.length ? await q('SELECT i.id,i.clicks,i.order_id,i.status,i.ends_at,c.username,c.title FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=ANY($1::bigint[])', [os.map(o => o.id)]) : [];
  res.json({ channels, orders: os.map(o => ({ id: o.id, code: 'AD' + o.id, total: o.total, hours: o.hours, status: o.status, start_at: o.start_at, btn: !!o.btn_url, discount: o.discount, items: items.filter(i => i.order_id === o.id).map(i => ({ status: i.status, ends_at: i.ends_at, name: nm(i), clicks: i.clicks })) })) });
}));

// Register by public username (private chats: use /connect CODE inside the chat)
app.post('/api/channel', auth, h(async (req, res) => {
  try {
    const un = String(req.body.username || '').trim().replace(/^https?:\/\/t\.me\//, '').replace('@', '');
    if (!/^[A-Za-z0-9_]{4,}$/.test(un)) return res.json({ error: 'Invalid username.' });
    const chat = await tg('getChat', { chat_id: '@' + un });
    res.json(await registerChat(chat, req.uid, +req.body.price || null, req.body.category));
  } catch (e) { res.json({ error: 'Chat not found or error: ' + e.message }); }
}));

// Create an order
app.post('/api/order', auth, h(async (req, res) => {
  const { html, photo, channels, pin, coupon } = req.body; const hours = Math.floor(+req.body.hours);
  if (limited('o' + req.uid, 6)) return res.json({ error: 'Too many orders. Try again in a minute.' });
  const btnText = String(req.body.btn_text || '').trim().slice(0, 30), btnUrl = String(req.body.btn_url || '').trim().slice(0, 300), startAt = Math.floor(+req.body.start_at) || 0;
  if (btnUrl && (!/^https?:\/\//i.test(btnUrl) || !btnText)) return res.json({ error: 'Button needs a text and a link starting with http(s).' });
  if (startAt && (startAt < Date.now() + 5 * 60e3 || startAt > Date.now() + 30 * 864e5)) return res.json({ error: 'Start time must be between 5 minutes and 30 days from now.' });
  const text = String(html || '').trim();
  if (!text) return res.json({ error: 'Write your ad text.' });
  if (text.length > (photo ? 1000 : 3500)) return res.json({ error: photo ? 'With a photo, the text must be 1000 characters or less.' : 'The text is too long.' });
  if (photo && !/^https?:\/\//i.test(photo)) return res.json({ error: 'The photo link must start with http(s).' });
  if (!(hours >= 1 && hours <= 168)) return res.json({ error: 'Duration must be between 1 and 168 hours.' });
  if (!Array.isArray(channels) || !channels.length || channels.length > 20) return res.json({ error: 'Select at least one channel or group.' });
  const chs = await q("SELECT * FROM channels WHERE id=ANY($1::bigint[]) AND status='approved'", [channels.map(Number).filter(Number.isFinite)]);
  if (!chs.length) return res.json({ error: 'Selected channels were not found.' });
  const prices = chs.map(c => chPrice(c) * hours + (pin ? PIN_PRICE : 0));
  let total = prices.reduce((a, b) => a + b, 0), disc = 0;
  if (coupon) {
    const cp = await one('UPDATE coupons SET uses=uses-1 WHERE code=$1 AND uses>0 RETURNING percent', [String(coupon).trim().toUpperCase()]);
    if (!cp) return res.json({ error: 'Invalid or used-up coupon.' });
    disc = Math.round(total * cp.percent) / 100; total -= disc; // owners still get their full share
  }
  const { id } = await one('INSERT INTO orders(user_id,html,photo,hours,pin,total,created,start_at,btn_text,btn_url,discount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [req.uid, text, photo || null, hours, pin ? 1 : 0, total, Date.now(), startAt, btnUrl ? btnText : null, btnUrl || null, disc]);
  for (let i = 0; i < chs.length; i++) await q('INSERT INTO items(order_id,channel_id,price) VALUES($1,$2,$3)', [id, chs[i].id, prices[i]]);
  res.json({ ok: true, id, code: 'AD' + id, total, discount: disc, chapa: !!CHAPA });
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

app.post('/api/lang', auth, h(async (req, res) => {
  const l = req.body.lang === 'am' ? 'am' : 'en'; await q('UPDATE users SET lang=$1 WHERE id=$2', [l, req.uid]); LANG.set(req.uid, l); res.json({ ok: true });
}));
app.post('/api/order/cancel', auth, h(async (req, res) => {
  const o = await one("UPDATE orders SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='awaiting_pay' RETURNING id", [+req.body.id, req.uid]);
  if (!o) return res.json({ error: 'This order cannot be cancelled.' });
  await q("UPDATE items SET status='cancelled' WHERE order_id=$1", [o.id]); res.json({ ok: true });
}));
app.post('/api/order/repeat', auth, h(async (req, res) => {
  if (limited('o' + req.uid, 6)) return res.json({ error: 'Too many orders. Try again in a minute.' });
  const o = await one('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [+req.body.id, req.uid]);
  if (!o) return res.json({ error: 'Order not found.' });
  const its = await q("SELECT i.channel_id,c.* FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1 AND c.status='approved'", [o.id]);
  if (!its.length) return res.json({ error: 'Those channels are no longer available.' });
  const prices = its.map(c => chPrice(c) * o.hours + (o.pin ? PIN_PRICE : 0)), total = prices.reduce((a, b) => a + b, 0);
  const n = await one('INSERT INTO orders(user_id,html,photo,hours,pin,total,created,btn_text,btn_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [req.uid, o.html, o.photo, o.hours, o.pin, total, Date.now(), o.btn_text, o.btn_url]);
  for (let i = 0; i < its.length; i++) await q('INSERT INTO items(order_id,channel_id,price) VALUES($1,$2,$3)', [n.id, its[i].channel_id, prices[i]]);
  res.json({ ok: true, id: n.id, code: 'AD' + n.id, total, chapa: !!CHAPA });
}));

// Online payment (Chapa). Set CHAPA_SECRET to enable.
async function chapaVerify(txRef) {
  const r = await fetch('https://api.chapa.co/v1/transaction/verify/' + encodeURIComponent(txRef), { headers: { Authorization: 'Bearer ' + CHAPA } });
  const j = await r.json().catch(() => null);
  if (!j || j.status !== 'success' || !j.data || String(j.data.status).toLowerCase() !== 'success') return null;
  const o = await one('SELECT * FROM orders WHERE tx_ref=$1', [txRef]);
  if (!o || Math.round(+j.data.amount * 100) < Math.round(o.total * 100)) return null;
  const up = await one("UPDATE orders SET status='active' WHERE id=$1 AND status IN('awaiting_pay','pending') RETURNING *", [o.id]);
  if (up) await approveOrder(up);
  return o.id;
}
app.post('/api/order/pay', auth, h(async (req, res) => {
  if (!CHAPA) return res.json({ error: 'Online payment is not enabled.' });
  const o = await one("SELECT * FROM orders WHERE id=$1 AND user_id=$2 AND status='awaiting_pay'", [+req.body.id, req.uid]);
  if (!o) return res.json({ error: 'Order not found.' });
  const ref = 'AD' + o.id + '-' + crypto.randomBytes(4).toString('hex');
  await q('UPDATE orders SET tx_ref=$1 WHERE id=$2', [ref, o.id]);
  const r = await fetch('https://api.chapa.co/v1/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + CHAPA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: String(o.total), currency: 'ETB', email: `u${o.user_id}@delal.app`, tx_ref: ref, callback_url: `${WEBAPP_URL}/api/chapa/callback`, return_url: `${WEBAPP_URL}/api/chapa/callback?tx_ref=${ref}`, customization: { title: 'Delal Ads', description: 'Order AD' + o.id } }) });
  const j = await r.json().catch(() => null);
  if (!j || !j.data || !j.data.checkout_url) return res.json({ error: 'Payment provider error: ' + ((j && j.message) || 'try again') });
  res.json({ ok: true, url: j.data.checkout_url });
}));
app.get('/api/chapa/callback', h(async (req, res) => {
  const ref = String(req.query.trx_ref || req.query.tx_ref || '').slice(0, 80);
  const id = ref && CHAPA ? await chapaVerify(ref) : null;
  res.send(`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:48px 20px"><h2>${id ? '✅ Payment received / ክፍያ ተቀብሏል' : '⏳ Not confirmed yet / ገና አልተረጋገጠም'}</h2><p>Return to Telegram. / ወደ Telegram ይመለሱ።</p></body>`);
}));

// Click tracking for the ad button
app.get('/r/:id', h(async (req, res) => {
  const r = await one('UPDATE items SET clicks=clicks+1 WHERE id=$1 RETURNING order_id', [+req.params.id || 0]);
  const o = r && await one('SELECT btn_url FROM orders WHERE id=$1', [r.order_id]);
  if (!o || !o.btn_url) return res.sendStatus(404);
  res.redirect(302, o.btn_url);
}));

// Admin dashboard
app.get('/api/admin/stats', auth, adm, h(async (req, res) => {
  const stats = await one("SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM channels WHERE status='approved') channels, (SELECT COUNT(*) FROM orders WHERE status IN('active','done')) paid_orders, (SELECT COALESCE(SUM(total),0) FROM orders WHERE status IN('active','done')) revenue, (SELECT COUNT(*) FROM items WHERE status='live') live");
  res.json({ stats,
    pendingOrders: await q("SELECT id,user_id,total FROM orders WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    pendingChannels: await q("SELECT id,title,username,subs FROM channels WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    pendingWd: await q("SELECT id,user_id,amount,method FROM withdrawals WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    coupons: await q('SELECT * FROM coupons ORDER BY code') });
}));
app.post('/api/admin/ban', auth, adm, h(async (req, res) => {
  const id = +req.body.user_id; if (!id) return res.json({ error: 'Enter a user ID.' });
  await q('UPDATE users SET banned=$1 WHERE id=$2', [req.body.ban ? 1 : 0, id]); res.json({ ok: true });
}));
app.post('/api/admin/coupon', auth, adm, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 20), pct = Math.floor(+req.body.percent), uses = Math.floor(+req.body.uses);
  if (!/^[A-Z0-9]{3,20}$/.test(code) || !(pct >= 1 && pct <= 90) || !(uses >= 1)) return res.json({ error: 'Code 3-20 letters/digits, percent 1-90, uses 1+.' });
  await q('INSERT INTO coupons(code,percent,uses) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET percent=$2, uses=$3', [code, pct, uses]); res.json({ ok: true });
}));

// ---------- Posting + escrow ----------
async function launch(oid) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [oid]);
  const items = await q("SELECT i.*,c.chat_id,c.username,c.title FROM items i JOIN channels c ON c.id=i.channel_id WHERE i.order_id=$1 AND i.status='queued'", [oid]);
  for (const i of items) {
    try {
      if (!(await one("UPDATE items SET status='posting' WHERE id=$1 AND status='queued' RETURNING id", [i.id]))) continue; // claimed by another run
      const bm = await tg('getChatMember', { chat_id: i.chat_id, user_id: await botId() }).catch(() => null);
      if (!bm || !['administrator', 'creator'].includes(bm.status)) throw new Error('bot is no longer an administrator there');
      const m = await sendAd(i.chat_id, o, o.btn_url && o.btn_text ? { reply_markup: kb([{ text: o.btn_text, url: `${WEBAPP_URL}/r/${i.id}` }]) } : {});
      if (o.pin) await safe('pinChatMessage', { chat_id: i.chat_id, message_id: m.message_id, disable_notification: true });
      await q("UPDATE items SET status='live',msg_id=$1,ends_at=$2 WHERE id=$3", [m.message_id, Date.now() + o.hours * 3600e3, i.id]);
      await say2(o.user_id, 'live', esc(nm(i)), o.hours);
    } catch (e) {
      await q("UPDATE items SET status='failed' WHERE id=$1", [i.id]);
      await credit(o.user_id, i.price); // refund to balance
      await say2(o.user_id, 'refund_fail', esc(nm(i)), esc(e.message), birr(i.price));
      await toAdmins(a => say(a, `AD${oid} ${esc(nm(i))} post failed: ${esc(e.message)}`));
    }
  }
  await closeIfDone(oid);
}
const closeIfDone = async oid => {
  if (!(await one("SELECT 1 FROM items WHERE order_id=$1 AND status IN('queued','posting','live','closing')", [oid])))
    await q("UPDATE orders SET status='done' WHERE id=$1 AND status='active'", [oid]);
};
async function tick() {
  await tickExtras().catch(e => console.log('extras', e.message));
  const rows = await q("SELECT i.*,c.chat_id,c.owner_id,c.username,c.title,o.user_id uid FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id WHERE i.status='live' AND i.ends_at<=$1", [Date.now()]);
  for (const i of rows) {
    if (!(await one("UPDATE items SET status='closing' WHERE id=$1 AND status='live' RETURNING id", [i.id]))) continue; // claimed by another run
    let removedEarly = false;
    try { await tg('deleteMessage', { chat_id: i.chat_id, message_id: i.msg_id }); }
    catch (e) { removedEarly = /message to delete not found/i.test(e.message); }
    if (removedEarly) {
      await q("UPDATE items SET status='removed' WHERE id=$1", [i.id]);
      await credit(i.uid, i.price); await say2(i.uid, 'removed_adv', esc(nm(i)), birr(i.price)); // advertiser is refunded
      await say2(i.owner_id, 'removed_own', esc(nm(i)));
      await toAdmins(a => say(a, `AD${i.order_id}: ad removed early from ${esc(nm(i))} (owner ${i.owner_id}).`));
    } else {
      const pay = i.price * OWNER_SHARE / 100;
      await q("UPDATE items SET status='done' WHERE id=$1", [i.id]);
      await credit(i.owner_id, pay);
      await say2(i.owner_id, 'fin_own', 'AD' + i.order_id, esc(nm(i)), birr(pay));
      await say2(i.uid, 'fin_adv', 'AD' + i.order_id, esc(nm(i)), i.clicks);
    }
    await closeIfDone(i.order_id);
  }
}
async function approveOrder(o) {
  const ref = (await one('SELECT ref FROM users WHERE id=$1', [o.user_id]))?.ref;
  if (ref) { const c = o.total * REF_PERCENT / 100; await q('UPDATE users SET balance=balance+$1, ref_earned=ref_earned+$1 WHERE id=$2', [c, ref]); await say2(ref, 'ref', birr(c)); }
  await say2(o.user_id, 'approved', 'AD' + o.id);
  if ((o.start_at || 0) > Date.now()) await say2(o.user_id, 'sched', 'AD' + o.id, new Date(o.start_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  else await launch(o.id);
}
async function tickExtras() {
  const now = Date.now();
  // 1) unpaid orders expire after 24h
  for (const o of await q("UPDATE orders SET status='expired' WHERE status='awaiting_pay' AND created<$1 RETURNING id,user_id", [now - 24 * 3600e3])) {
    await q("UPDATE items SET status='cancelled' WHERE order_id=$1", [o.id]); await say2(o.user_id, 'expired', 'AD' + o.id);
  }
  // 2) scheduled ads
  for (const o of await q("SELECT id FROM orders WHERE status='active' AND start_at>0 AND start_at<=$1 AND EXISTS(SELECT 1 FROM items WHERE order_id=orders.id AND status='queued')", [now])) await launch(o.id);
  // 3) one-hour reminders
  for (const i of await q("SELECT i.id,i.order_id,c.username,c.title,o.user_id uid FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id WHERE i.status='live' AND i.reminded=0 AND o.hours>1 AND i.ends_at<=$1 AND i.ends_at>$2", [now + 3600e3, now])) {
    await q('UPDATE items SET reminded=1 WHERE id=$1', [i.id]); await say2(i.uid, 'remind', 'AD' + i.order_id, esc(nm(i)));
  }
  // 4) refresh member counts (5 channels per run, each once a day)
  for (const c of await q("SELECT id,chat_id FROM channels WHERE status='approved' AND COALESCE(subs_at,0)<$1 ORDER BY subs_at LIMIT 5", [now - 24 * 3600e3])) {
    const n = await tg('getChatMemberCount', { chat_id: c.chat_id }).catch(() => null);
    await q('UPDATE channels SET subs=COALESCE($1,subs), subs_at=$2 WHERE id=$3', [n, now, c.id]);
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
• /id — View your User ID and this Chat ID

<b>አማርኛ:</b> እንኳን ደህና መጡ! ማስታወቂያ ለመለጠፍ "Advertiser"፣ ከቻናልዎ ገቢ ለማግኘት "Publisher / Owner Mode" ይጫኑ። ቋንቋ በመተግበሪያው ውስጥ ይቀይሩ።`;

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
      await approveOrder(o); note = 'Approved';
    } else { await say2(o.user_id, 'rejected', 'AD' + id); note = 'Rejected'; }
  } else if (a === 'ca' || a === 'cr') {
    const c = await one("UPDATE channels SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'ca' ? 'approved' : 'rejected']);
    if (!c) return done('Already handled.');
    await say2(c.owner_id, a === 'ca' ? 'chan_ok' : 'chan_no', esc(nm(c)));
    note = a === 'ca' ? 'Approved' : 'Rejected';
  } else if (a === 'wa' || a === 'wr') {
    const w = await one("UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'wa' ? 'paid' : 'rejected']);
    if (!w) return done('Already handled.');
    if (a === 'wa') { await say2(w.user_id, 'wd_paid', birr(w.amount), w.method); note = 'Paid'; }
    else { await credit(w.user_id, w.amount); await say2(w.user_id, 'wd_rej', birr(w.amount)); note = 'Rejected'; }
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
