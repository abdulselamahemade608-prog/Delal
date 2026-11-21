// Addis Ad — Telegram Mini App ad marketplace — server.js
// Vercel (webhook mode) + Neon Postgres. On a VPS `node server.js` uses long polling.
// Payments are manual only: wallet balance, or bank-transfer receipt approved by an admin (no Chapa).
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number

const E = process.env;
const BOT_TOKEN = E.BOT_TOKEN, WEBAPP_URL = (E.WEBAPP_URL || '').replace(/\/$/, ''), SECRET = E.SECRET;
const ADMINS = (E.ADMIN_IDS || '').split(',').map(s => +s.trim()).filter(Boolean);
const OWNER_SHARE = +E.OWNER_SHARE || 70, REF_PERCENT = +E.REF_PERCENT || 5;
const MIN_WITHDRAW = +E.MIN_WITHDRAW || 100, MIN_TOPUP = +E.MIN_TOPUP || 50, MIN_POST_PRICE = +E.MIN_PRICE || 50;
const POST_HOURS = +E.POST_HOURS || 1;            // how long each post stays in the channel
const ON_VERCEL = !!E.VERCEL;
const EAT = 3 * 3600e3, LEAD_MS = 10 * 60e3, LATE_MS = 30 * 60e3, SLOT_FIRST = 6, SLOT_LAST = 23;
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// Packages (flat price per channel). Override prices with PACKAGE_PRICES='{"single":300,"daily":500,"weekly":800,"monthly":2500}'
const PKGS = {
  single: { name: 'Single Sponsored Post', tag: 'One Post', price: 300, days: 1, max: 1 },
  daily: { name: 'Daily Package', tag: 'Daily Post', price: 500, days: 1, max: 3 },
  weekly: { name: 'Weekly Package', tag: 'Weekly Package', price: 800, days: 7, max: 2 },
  monthly: { name: 'Monthly Partner', tag: 'Monthly Package', price: 2500, days: 30, max: 2 }
};
const PR = json(E.PACKAGE_PRICES, {}) || {};
for (const k in PKGS) PKGS[k].price = +PR[k] || PKGS[k].price;
// Bank accounts shown to advertisers. BANKS='[{"bank":"Telebirr","name":"Name","number":"09..."}]'
let BANKS = json(E.BANKS, null);
if (!Array.isArray(BANKS) || !BANKS.length) BANKS = [{ bank: 'Telebirr', name: 'Account Name', number: '09XXXXXXXX' }, { bank: 'CBE', name: 'Account Name', number: '1000XXXXXXXXX' }];
if (!BOT_TOKEN || !WEBAPP_URL || !E.DATABASE_URL || !SECRET) { console.log('Set BOT_TOKEN, WEBAPP_URL, DATABASE_URL, SECRET'); if (!ON_VERCEL) process.exit(1); }

// ---------- Database (Neon Postgres) ----------
const DB_URL = (E.DATABASE_URL || '').trim().replace(/^psql\s+/, '').replace(/^['"]|['"]$/g, '').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: E.DB_SSL_INSECURE !== '1' }, // verified TLS (set DB_SSL_INSECURE=1 only if your provider needs it)
  max: ON_VERCEL ? 1 : 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000
});
const q = (t, p = []) => pool.query(t, p).then(r => r.rows);
const one = async (t, p) => (await q(t, p))[0];
async function tx(fn) { // transaction: inside fn use ONLY the `run` helper (the pool may have just one connection)
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn((t, p = []) => c.query(t, p).then(x => x.rows)); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => { }); throw e; }
  finally { c.release(); }
}
class UErr extends Error { }
const SCHEMA = '3';
let ready;
const init = () => ready || (ready = (async () => {
  await q('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)');
  const v = await one("SELECT v FROM meta WHERE k='schema'");
  if (v && v.v === SCHEMA) return;
  await q(`
CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, name TEXT, balance DOUBLE PRECISION DEFAULT 0, ref BIGINT, code TEXT);
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_earned DOUBLE PRECISION DEFAULT 0;
CREATE TABLE IF NOT EXISTS channels(id BIGSERIAL PRIMARY KEY, chat_id TEXT UNIQUE, username TEXT, title TEXT, owner_id BIGINT, subs INTEGER, custom_price DOUBLE PRECISION, status TEXT DEFAULT 'pending');
ALTER TABLE channels ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS subs_at BIGINT DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS photo TEXT;
CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY, user_id BIGINT, html TEXT, total DOUBLE PRECISION, status TEXT DEFAULT 'pending', created BIGINT);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel_id BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pkg TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parse_mode TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS photos TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS slots TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btn_text TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btn_url TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount DOUBLE PRECISION DEFAULT 0;
CREATE TABLE IF NOT EXISTS items(id BIGSERIAL PRIMARY KEY, order_id BIGINT, channel_id BIGINT, price DOUBLE PRECISION, ends_at BIGINT, status TEXT DEFAULT 'queued');
ALTER TABLE items ADD COLUMN IF NOT EXISTS msg_ids TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS post_at BIGINT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS paid DOUBLE PRECISION DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS tries INTEGER DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS busy_at BIGINT DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS items_slot ON items(channel_id, post_at) WHERE post_at IS NOT NULL AND status IN('queued','posting','live','closing');
CREATE INDEX IF NOT EXISTS items_status ON items(status, post_at);
CREATE TABLE IF NOT EXISTS withdrawals(id BIGSERIAL PRIMARY KEY, user_id BIGINT, amount DOUBLE PRECISION, method TEXT, account TEXT, status TEXT DEFAULT 'pending', created BIGINT);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY, percent INTEGER, uses INTEGER);
CREATE TABLE IF NOT EXISTS payments(id BIGSERIAL PRIMARY KEY, user_id BIGINT, kind TEXT, order_id BIGINT, amount DOUBLE PRECISION, tx_number TEXT, sender_name TEXT, sender_phone TEXT, receipt TEXT, rhash TEXT, status TEXT DEFAULT 'pending', created BIGINT);
CREATE UNIQUE INDEX IF NOT EXISTS pay_tx ON payments(lower(tx_number)) WHERE tx_number IS NOT NULL AND status<>'rejected';
CREATE UNIQUE INDEX IF NOT EXISTS pay_hash ON payments(rhash) WHERE rhash IS NOT NULL AND status<>'rejected';
CREATE TABLE IF NOT EXISTS ledger(id BIGSERIAL PRIMARY KEY, user_id BIGINT, amount DOUBLE PRECISION, type TEXT, note TEXT, created BIGINT);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, owner BIGINT, data BYTEA, hash TEXT, created BIGINT);
CREATE TABLE IF NOT EXISTS click_log(item_id BIGINT, h TEXT, PRIMARY KEY(item_id, h));
`);
  await q("INSERT INTO meta(k,v) VALUES('schema',$1) ON CONFLICT(k) DO UPDATE SET v=$1", [SCHEMA]);
})().catch(e => { ready = null; throw e; }));

// ---------- Money helpers (every balance change is written to the ledger) ----------
const credit = (uid, amt, type, note = '', run = q) => run(
  'WITH u AS(UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id) INSERT INTO ledger(user_id,amount,type,note,created) SELECT id,$1::float8,$3::text,$4::text,$5::bigint FROM u',
  [amt, uid, type, note, Date.now()]);
const debit = async (uid, amt, type, note = '', run = q) => {
  if (!(await run('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING id', [amt, uid])).length) return false;
  await run('INSERT INTO ledger(user_id,amount,type,note,created) VALUES($1,$2,$3,$4,$5)', [uid, -amt, type, note, Date.now()]);
  return true;
};
const round2 = n => Math.round(n * 100) / 100;
const split = (a, n) => { const s = Math.floor(a / n * 100) / 100; return Array.from({ length: n }, (_, i) => i < n - 1 ? s : round2(a - s * (n - 1))); };
const recent = (tbl, col, uid, ms, n) => one(`SELECT COUNT(*) n FROM ${tbl} WHERE ${col}=$1 AND created>$2`, [uid, Date.now() - ms]).then(r => r.n >= n);

// ---------- Telegram helpers ----------
async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description);
  return j.result;
}
const safe = (m, b) => tg(m, b).catch(e => { console.log(m, e.message); return null; });
const say = (id, text, extra = {}) => safe('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const toAdmins = fn => Promise.all(ADMINS.map(a => Promise.resolve().then(() => fn(a)).catch(e => console.log('admin', e.message))));
const kb = (...rows) => ({ inline_keyboard: rows });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const birr = n => round2(n) + ' ETB';
const nm = c => c.username ? '@' + c.username : c.title;
const pad = n => String(n).padStart(2, '0');
const fmtEAT = ms => new Date(ms + EAT).toISOString().slice(0, 16).replace('T', ' ') + ' EAT';
const mediaUrl = id => `${WEBAPP_URL}/media/${id}.jpg`;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const CATS = ['news', 'sports', 'business', 'tech', 'music', 'education', 'other'];
const RL = new Map();
const limited = (key, n) => { const k = key + ':' + Math.floor(Date.now() / 60000); const c = (RL.get(k) || 0) + 1; RL.set(k, c); if (RL.size > 5000) RL.clear(); return c > n; };
const LANG = new Map();
const getLang = async uid => { if (LANG.has(uid)) return LANG.get(uid); const r = await one('SELECT lang FROM users WHERE id=$1', [uid]); const l = r && r.lang === 'am' ? 'am' : 'en'; LANG.set(uid, l); return l; };
const M = {
  live: { en: (n, h) => `Your ad is live on ${n} for ${h} hour(s).`, am: (n, h) => `ማስታወቂያዎ በ${n} ላይ ለ${h} ሰዓት ተለጥፏል።` },
  fin_adv: { en: (c, n, k) => `Your ad ${c} finished on ${n}.${k ? ' Button clicks: ' + k + '.' : ''}`, am: (c, n, k) => `ማስታወቂያዎ ${c} በ${n} ላይ ተጠናቋል።${k ? ' የቁልፍ ጠቅታዎች: ' + k + '።' : ''}` },
  fin_own: { en: (c, n, a) => `Ad ${c} finished on ${n}. ${a} was added to your balance.`, am: (c, n, a) => `ማስታወቂያ ${c} በ${n} ላይ ተጠናቋል። ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  approved: { en: c => `Order ${c} was approved. Your post(s) will be published at the scheduled time(s).`, am: c => `ትዕዛዝ ${c} ጸድቋል። ማስታወቂያዎ በተመደበው ሰዓት ይለጠፋል።` },
  rejected: { en: (c, r) => `Order ${c} was rejected.${r ? ' The amount was returned to your wallet.' : ' If you think this is a mistake, contact the administrator.'}`, am: (c, r) => `ትዕዛዝ ${c} ተቀባይነት አላገኘም።${r ? ' ገንዘቡ ወደ ዋሌትዎ ተመልሷል።' : ' ስህተት ነው ብለው ካሰቡ አድሚኑን ያነጋግሩ።'}` },
  refund_fail: { en: (n, e, a) => `Could not post on ${n} (${e}). ${a} was refunded to your wallet.`, am: (n, e, a) => `በ${n} ላይ መለጠፍ አልተቻለም (${e})። ${a} ወደ ዋሌትዎ ተመልሷል።` },
  missed: { en: (c, n, a) => `A scheduled post of ${c} on ${n} could not be published in time. ${a} was refunded to your wallet.`, am: (c, n, a) => `የ${c} ማስታወቂያ በ${n} በሰዓቱ መለጠፍ አልተቻለም። ${a} ወደ ዋሌትዎ ተመልሷል።` },
  removed_own: { en: n => `The ad was deleted from ${n} before its time ended, so no payment was made.`, am: n => `ማስታወቂያው ጊዜው ሳያልቅ ከ${n} ስለተሰረዘ ክፍያ አልተፈጸመም።` },
  removed_adv: { en: (n, a) => `Your ad was removed early from ${n}. ${a} was refunded to your wallet.`, am: (n, a) => `ማስታወቂያዎ ከ${n} ቀድሞ ስለተሰረዘ ${a} ወደ ዋሌትዎ ተመልሷል።` },
  ref: { en: a => `Referral commission of ${a} was added to your balance.`, am: a => `የሪፈራል ኮሚሽን ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  chan_ok: { en: n => `Your chat ${n} was approved. You can now receive ads.`, am: n => `${n} ጸድቋል። አሁን ማስታወቂያ መቀበል ይችላሉ።` },
  chan_no: { en: n => `Your chat ${n} was not approved.`, am: n => `${n} አልጸደቀም።` },
  wd_paid: { en: (a, m) => `${a} was sent to your ${m} account.`, am: (a, m) => `${a} ወደ ${m} ሒሳብዎ ተልኳል።` },
  wd_rej: { en: a => `Your withdrawal was rejected. ${a} was returned to your balance.`, am: a => `የገንዘብ ማውጫ ጥያቄዎ ተቀባይነት አላገኘም። ${a} ወደ ሒሳብዎ ተመልሷል።` },
  topup_ok: { en: a => `Your top-up of ${a} was approved and added to your wallet.`, am: a => `የ${a} ሙሌትዎ ጸድቆ ወደ ዋሌትዎ ተጨምሯል።` },
  topup_no: { en: () => 'Your top-up receipt was rejected. If you think this is a mistake, contact the administrator.', am: () => 'የሙሌት ደረሰኝዎ ተቀባይነት አላገኘም። ስህተት ከሆነ አድሚኑን ያነጋግሩ።' }
};
const say2 = async (uid, key, ...a) => say(uid, M[key][await getLang(uid)](...a));
let BOT_ID = 0;
const botId = async () => BOT_ID || (BOT_ID = (await tg('getMe')).id);
const menuKb = () => kb(
  [{ text: 'Advertiser', web_app: { url: WEBAPP_URL + '/?mode=advertiser' } }],
  [{ text: 'Publisher / Owner Mode', web_app: { url: WEBAPP_URL + '/?mode=publisher' } }]);

// Telegram HTML check: only allowed tags, every other < > & must be escaped
const badHtml = s => {
  const t = s.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)>|<a href="https?:\/\/[^"<>\s]*">|<\/a>/gi, '');
  return /[<>]/.test(t) || /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(t);
};
const PM = { HTML: 'HTML', Markdown: 'Markdown' }; // 'Plain' = no parse mode
// Send one ad (text, one photo, or a 1-5 photo album). Returns the message ids. `url` = CTA link (tracked link for channels).
async function sendAd(chat, o, url) {
  const pm = PM[o.parse_mode], ph = json(o.photos, []), text = o.html || '';
  const markup = url && o.btn_text ? { reply_markup: kb([{ text: o.btn_text, url }]) } : {};
  if (!ph.length) return [(await tg('sendMessage', { chat_id: chat, text, parse_mode: pm, disable_web_page_preview: true, ...markup })).message_id];
  if (ph.length === 1) return [(await tg('sendPhoto', { chat_id: chat, photo: mediaUrl(ph[0]), caption: text || undefined, parse_mode: pm, ...markup })).message_id];
  const ms = await tg('sendMediaGroup', { chat_id: chat, media: ph.map((id, i) => ({ type: 'photo', media: mediaUrl(id), ...(i === 0 && text ? { caption: text, parse_mode: pm } : {}) })) });
  const ids = ms.map(m => m.message_id);
  if (markup.reply_markup) ids.push((await tg('sendMessage', { chat_id: chat, text: '👇', ...markup })).message_id); // albums cannot carry buttons
  return ids;
}
const idsOf = i => String(i.msg_ids || i.msg_id || '').split(',').filter(Boolean).map(Number);

// ---------- Data helpers ----------
const userCode = uid => 'AD' + crypto.createHmac('sha256', SECRET || 'x').update(String(uid)).digest('hex').slice(0, 8).toUpperCase();
const upsertUser = (u, ref) => q('INSERT INTO users(id,name,username,ref,code,lang) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username, code=COALESCE(users.code,EXCLUDED.code)',
  [u.id, u.first_name || u.username || '', u.username || null, ref && ref !== u.id ? ref : null, userCode(u.id), String(u.language_code || '').startsWith('am') ? 'am' : 'en']);
const chMult = c => c.custom_price ? c.custom_price / PKGS.single.price : 1;
const pkgPrice = (c, k) => Math.round(PKGS[k].price * chMult(c));
const prices = c => Object.fromEntries(Object.keys(PKGS).map(k => [k, pkgPrice(c, k)]));
const slotText = o => { const pk = PKGS[o.pkg] || { days: 1 }, hs = json(o.slots, []); return `${o.start_date} · ${hs.map(h => pad(h) + ':00').join(', ')} EAT${pk.days > 1 ? ' · ' + pk.days + ' days' : ''}`; };

// Register a channel or group (used by the Mini App and by /connect)
async function registerChat(chat, ownerId, price, category) {
  const cat = CATS.includes(category) ? category : 'other';
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) return { error: 'This chat is not a channel or group.' };
  const m = await tg('getChatMember', { chat_id: chat.id, user_id: ownerId }).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return { error: 'You are not an administrator of this chat.' };
  const b = await tg('getChatMember', { chat_id: chat.id, user_id: await botId() }).catch(() => null);
  if (!b || b.status !== 'administrator') return { error: 'Add the bot as an administrator first (Post Messages for channels, Send Messages & Photos for groups).' };
  const ex = await one('SELECT id,owner_id,status FROM channels WHERE chat_id=$1', [String(chat.id)]);
  if (ex && !(ex.status === 'rejected' && ex.owner_id === ownerId)) return { error: 'This chat is already registered.' }; // a rejected chat may re-apply
  const full = await tg('getChat', { chat_id: chat.id }).catch(() => chat);
  const subs = await tg('getChatMemberCount', { chat_id: chat.id });
  price = price > 0 ? Math.max(round2(price), MIN_POST_PRICE) : null;
  const v = [String(chat.id), chat.username || null, chat.title, ownerId, subs, price, cat, (full.photo && full.photo.small_file_id) || null];
  const id = ex
    ? (await one("UPDATE channels SET username=$2,title=$3,owner_id=$4,subs=$5,custom_price=$6,category=$7,photo=$8,status='pending' WHERE chat_id=$1 RETURNING id", v)).id
    : (await one('INSERT INTO channels(chat_id,username,title,owner_id,subs,custom_price,category,photo) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', v)).id;
  await toAdmins(a => say(a, `<b>New ${chat.type === 'channel' ? 'channel' : 'group'} request</b>\n${esc(nm({ username: chat.username, title: chat.title }))} — ${esc(chat.title)}\n${subs} members\nOwner: <a href="tg://user?id=${ownerId}">${ownerId}</a>\nSingle post price: ${birr(pkgPrice({ custom_price: price }, 'single'))}`,
    { reply_markup: kb([{ text: 'Approve', callback_data: 'ca:' + id }, { text: 'Reject', callback_data: 'cr:' + id }]) }));
  return { ok: true };
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(async (req, res, next) => {
  try {
    if (!DB_URL) return res.status(500).json({ error: 'DATABASE_URL is missing. Add it in Vercel > Settings > Environment Variables, then redeploy.' });
    await init(); next();
  } catch (e) { console.log('db', e.message); res.status(500).json({ error: 'Database connection failed: ' + e.message }); }
});
const h = fn => (req, res) => fn(req, res).catch(e => { console.log(e); res.status(500).json({ error: 'Server error' }); });

async function auth(req, res, next) {
  let u;
  try {
    const p = new URLSearchParams(req.get('x-init-data') || '');
    const hash = p.get('hash'); p.delete('hash');
    const check = [...p].map(([k, v]) => k + '=' + v).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (!hash || !safeEq(crypto.createHmac('sha256', key).update(check).digest('hex'), hash)) throw 0;
    if (Date.now() / 1000 - +p.get('auth_date') > 86400) throw 0;
    u = JSON.parse(p.get('user'));
  } catch (e) { return res.status(401).json({ error: 'Open this app inside Telegram.' }); }
  try {
    await upsertUser(u);
    const bu = await one('SELECT banned FROM users WHERE id=$1', [u.id]);
    if (bu && bu.banned) return res.status(403).json({ error: 'Your account is blocked.' });
    if (limited('u' + u.id, 120)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    req.uid = u.id; next();
  } catch (e) { console.log('auth', e.message); res.status(500).json({ error: 'Server error' }); }
}
const adm = (req, res, next) => ADMINS.includes(req.uid) ? next() : res.status(403).json({ error: 'Admins only.' });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/me', auth, h(async (req, res) => {
  await maybeTick();
  res.json({
    me: await one('SELECT id,name,username,balance,code,lang,ref_earned FROM users WHERE id=$1', [req.uid]),
    refCount: (await one('SELECT COUNT(*) n FROM users WHERE ref=$1', [req.uid])).n, botUsername: E.BOT_USERNAME || '', cats: CATS, refPercent: REF_PERCENT,
    isAdmin: ADMINS.includes(req.uid), banks: BANKS, packages: Object.entries(PKGS).map(([key, p]) => ({ key, ...p })), ownerShare: OWNER_SHARE,
    minWithdraw: MIN_WITHDRAW, minTopup: MIN_TOPUP, postHours: POST_HOURS, minPostPrice: MIN_POST_PRICE,
    withdrawals: await q('SELECT id,amount,method,account,status FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.uid])
  });
}));

app.get('/api/channels', auth, h(async (req, res) => {
  const rows = await q("SELECT * FROM channels WHERE status='approved' ORDER BY subs DESC");
  res.json(rows.map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, category: c.category || 'other', photo: !!c.photo, prices: prices(c) })));
}));

// Hours (EAT) already booked on a channel for the date range of a package
app.get('/api/slots', auth, h(async (req, res) => {
  const date = String(req.query.date || ''), days = Math.min(30, Math.max(1, +req.query.days || 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ error: 'Bad date.' });
  const [y, m, d] = date.split('-').map(Number), from = Date.UTC(y, m - 1, d, -3);
  const rows = await q("SELECT DISTINCT (((post_at+10800000)/3600000)%24)::int AS h FROM items WHERE channel_id=$1 AND post_at>=$2 AND post_at<$3 AND status IN('queued','posting','live','closing')", [+req.query.channel || 0, from, from + days * 864e5]);
  res.json({ taken: rows.map(r => r.h) });
}));

app.get('/api/mine', auth, h(async (req, res) => {
  const channels = (await q('SELECT * FROM channels WHERE owner_id=$1 ORDER BY id DESC', [req.uid]))
    .map(c => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, status: c.status, category: c.category || 'other', photo: !!c.photo, price: pkgPrice(c, 'single') }));
  const os = await q('SELECT o.*,c.title ctitle FROM orders o LEFT JOIN channels c ON c.id=o.channel_id WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 30', [req.uid]);
  const items = os.length ? await q('SELECT id,order_id,status,post_at,ends_at,clicks FROM items WHERE order_id=ANY($1::bigint[]) ORDER BY post_at', [os.map(o => o.id)]) : [];
  res.json({ channels, orders: os.map(o => ({ id: o.id, code: 'AD' + o.id, channel_id: o.channel_id, channel: o.ctitle || '', pkg: o.pkg, kind: o.kind || 'text', label: o.label || '', html: o.html || '', parse_mode: o.parse_mode || 'HTML', photos: json(o.photos, []), btn_text: o.btn_text || '', btn_url: o.btn_url || '', total: o.total, discount: o.discount || 0, status: o.status, pay_method: o.pay_method, created: o.created, items: items.filter(i => i.order_id === o.id) })) });
}));

app.get('/api/wallet', auth, h(async (req, res) => {
  res.json({
    payments: await q('SELECT id,kind,order_id,amount,tx_number,status,created FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.uid]),
    ledger: await q('SELECT amount,type,note,created FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 40', [req.uid])
  });
}));

app.get('/api/coupon', auth, h(async (req, res) => {
  const c = await one('SELECT percent FROM coupons WHERE code=$1 AND uses>0', [String(req.query.code || '').trim().toUpperCase()]);
  res.json(c ? { ok: true, percent: c.percent } : { error: 'Invalid or used-up coupon.' });
}));

// Images (ad photos and payment receipts): the app sends a compressed JPEG as a data URL
app.post('/api/upload', auth, h(async (req, res) => {
  if (await recent('media', 'owner', req.uid, 600e3, 40)) return res.json({ error: 'Too many uploads. Wait a few minutes.' });
  const s = String(req.body.data || ''), pre = 'data:image/jpeg;base64,';
  if (!s.startsWith(pre)) return res.json({ error: 'Invalid image.' });
  const buf = Buffer.from(s.slice(pre.length), 'base64');
  if (buf.length < 500 || buf.length > 1.5e6 || buf[0] !== 0xFF || buf[1] !== 0xD8) return res.json({ error: 'The image must be a JPEG under 1.5 MB.' });
  const id = crypto.randomBytes(12).toString('hex');
  await q('INSERT INTO media(id,owner,data,hash,created) VALUES($1,$2,$3,$4,$5)', [id, req.uid, buf, crypto.createHash('sha256').update(buf).digest('hex'), Date.now()]);
  res.json({ ok: true, id });
}));
app.get('/media/:id', h(async (req, res) => {
  const m = await one('SELECT data FROM media WHERE id=$1', [req.params.id.replace(/\.\w+$/, '')]);
  if (!m) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }).send(m.data);
}));
app.get('/avatar/:id', h(async (req, res) => {
  const c = await one("SELECT photo FROM channels WHERE id=$1 AND status='approved'", [+req.params.id || 0]);
  if (!c || !c.photo) return res.sendStatus(404);
  const f = await tg('getFile', { file_id: c.photo });
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }).send(Buffer.from(await r.arrayBuffer()));
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

// Payment details sent by the advertiser (bank transfer / top-up)
async function payFields(uid, b) {
  const tx = String(b.tx || '').trim(), name = String(b.sender_name || '').trim().slice(0, 60), phone = String(b.sender_phone || '').trim().slice(0, 20), rid = b.receipt ? String(b.receipt) : null;
  if (tx && !/^[A-Za-z0-9._-]{4,40}$/.test(tx)) return { error: 'The transaction number looks invalid (letters, digits, - . _ only).' };
  let rhash = null;
  if (rid) { const m = await one('SELECT hash FROM media WHERE id=$1 AND owner=$2', [rid, uid]); if (!m) return { error: 'Receipt image not found. Upload it again.' }; rhash = m.hash; }
  if (!tx && !rid) return { error: 'Enter the transaction number or upload the receipt screenshot.' };
  return { tx_number: tx || null, sender_name: name || null, sender_phone: phone || null, receipt: rid, rhash };
}
const DUP = 'This transaction number or receipt was already used.';

async function notifyOrder(o, ch, p) {
  const pk = PKGS[o.pkg] || { name: o.pkg };
  const cap = `<b>AD${o.id}</b> — ${esc(pk.name)}\nChannel: ${esc(nm(ch))}\nWhen: ${esc(slotText(o))}\nTotal: ${birr(o.total)}${o.discount ? ' (discount ' + birr(o.discount) + ')' : ''}\nUser: <a href="tg://user?id=${o.user_id}">${o.user_id}</a>\n` +
    (o.pay_method === 'wallet' ? 'Paid from wallet (returned to the wallet if rejected).' : `Bank transfer — Tx: <code>${esc(p.tx_number || '-')}</code>\nSender: ${esc(p.sender_name || '-')} ${esc(p.sender_phone || '')}\nCheck the amount and the transaction before approving.`);
  const markup = { reply_markup: kb([{ text: 'Approve', callback_data: 'oa:' + o.id }, { text: 'Reject', callback_data: 'or:' + o.id }]) };
  await toAdmins(async a => {
    await sendAd(a, o, o.btn_url && o.btn_text ? o.btn_url : null).catch(e => say(a, `AD${o.id}: the ad has an error: ${esc(e.message)}`));
    if (!(p && p.receipt && await safe('sendPhoto', { chat_id: a, photo: mediaUrl(p.receipt), caption: cap, parse_mode: 'HTML', ...markup }))) await say(a, cap, markup);
  });
}

// Create an order (one order = one channel + one package; every post is a row in `items`)
app.post('/api/order', auth, h(async (req, res) => {
  const b = req.body, pk = PKGS[b.pkg];
  if (!pk) return res.json({ error: 'Choose a package.' });
  if (await recent('orders', 'user_id', req.uid, 3600e3, 10)) return res.json({ error: 'Too many orders. Try again later.' });
  const ch = await one("SELECT * FROM channels WHERE id=$1 AND status='approved'", [+b.channel || 0]);
  if (!ch) return res.json({ error: 'Channel not found.' });
  const date = String(b.date || ''), hours = [...new Set((Array.isArray(b.hours) ? b.hours : []).map(Number))].filter(x => Number.isInteger(x) && x >= SLOT_FIRST && x <= SLOT_LAST).sort((a, c) => a - c);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !hours.length || hours.length > pk.max) return res.json({ error: `Pick a start date and 1-${pk.max} posting hour(s).` });
  const [Y, Mo, D] = date.split('-').map(Number), times = [];
  for (let d = 0; d < pk.days; d++) for (const x of hours) times.push(Date.UTC(Y, Mo - 1, D + d, x - 3)); // EAT = UTC+3
  const now = Date.now();
  if (!(times[0] >= now + LEAD_MS) || times[0] > now + 60 * 864e5) return res.json({ error: 'The first post must be at least 10 minutes from now and within 60 days.' });
  // creative
  const kind = b.kind === 'photos' ? 'photos' : 'text', pm = ['HTML', 'Markdown', 'Plain'].includes(b.parse_mode) ? b.parse_mode : 'HTML';
  const text = String(b.html || '').trim(), label = String(b.label || '').trim().slice(0, 60);
  let photos = [];
  if (kind === 'photos') {
    photos = [...new Set(Array.isArray(b.photos) ? b.photos.map(String) : [])].slice(0, 5);
    if (!photos.length) return res.json({ error: 'Add at least one photo.' });
    if ((await q('SELECT id FROM media WHERE id=ANY($1::text[]) AND owner=$2', [photos, req.uid])).length !== photos.length) return res.json({ error: 'A photo was not found. Upload it again.' });
    if (text.length > 1024) return res.json({ error: 'The caption must be 1024 characters or less.' });
  } else {
    if (!text) return res.json({ error: 'Write your ad text.' });
    if (text.length > 4096) return res.json({ error: 'The text is too long (max 4096).' });
  }
  if (pm === 'HTML' && badHtml(text)) return res.json({ error: 'Invalid HTML. Allowed tags: b, i, u, s, code, pre, a href="https://…". Write other < > & as &lt; &gt; &amp;.' });
  const bt = String(b.btn_text || '').trim().slice(0, 30), bu = String(b.btn_url || '').trim().slice(0, 300);
  if ((bt || bu) && (!bt || !/^https?:\/\/\S+$/i.test(bu))) return res.json({ error: 'The button needs a label and a link starting with http(s).' });
  // payment
  const method = b.pay === 'wallet' ? 'wallet' : 'bank';
  const pf = method === 'bank' ? await payFields(req.uid, b) : null;
  if (pf && pf.error) return res.json(pf);
  const couponCode = String(b.coupon || '').trim().toUpperCase(), gross = pkgPrice(ch, b.pkg), n = times.length;
  let out;
  try {
    out = await tx(async run => {
      let disc = 0;
      if (couponCode) {
        const cp = (await run('UPDATE coupons SET uses=uses-1 WHERE code=$1 AND uses>0 RETURNING percent', [couponCode]))[0];
        if (!cp) throw new UErr('Invalid or used-up coupon.');
        disc = Math.round(gross * cp.percent) / 100;
      }
      const total = round2(gross - disc);
      const o = (await run("INSERT INTO orders(user_id,channel_id,pkg,kind,label,html,parse_mode,photos,slots,start_date,btn_text,btn_url,total,discount,coupon,pay_method,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17) RETURNING id",
        [req.uid, ch.id, b.pkg, kind, label || null, text, pm, JSON.stringify(photos), JSON.stringify(hours), date, bt || null, bu || null, total, disc, disc ? couponCode : null, method, now]))[0];
      const gs = split(gross, n), ps = split(total, n);
      for (let i = 0; i < n; i++) await run("INSERT INTO items(order_id,channel_id,price,paid,post_at,status) VALUES($1,$2,$3,$4,$5,'queued')", [o.id, ch.id, gs[i], ps[i], times[i]]);
      if (method === 'wallet') { if (!(await debit(req.uid, total, 'order', 'AD' + o.id, run))) throw new UErr('Insufficient wallet balance.'); }
      else await run("INSERT INTO payments(user_id,kind,order_id,amount,tx_number,sender_name,sender_phone,receipt,rhash,status,created) VALUES($1,'order',$2,$3,$4,$5,$6,$7,$8,'pending',$9)", [req.uid, o.id, total, pf.tx_number, pf.sender_name, pf.sender_phone, pf.receipt, pf.rhash, now]);
      return { id: o.id, total, disc };
    });
  } catch (e) {
    if (e instanceof UErr) return res.json({ error: e.message });
    if (e.code === '23505') return res.json({ error: /items_slot/.test(e.constraint || '') ? 'One of the selected hours was just booked by someone else. Pick another hour.' : DUP });
    throw e;
  }
  await notifyOrder(await one('SELECT * FROM orders WHERE id=$1', [out.id]), ch, pf);
  res.json({ ok: true, id: out.id, code: 'AD' + out.id, total: out.total, discount: out.disc });
}));

// Wallet top-up by bank transfer (admin approves in the bot)
app.post('/api/topup', auth, h(async (req, res) => {
  if (await recent('payments', 'user_id', req.uid, 3600e3, 10)) return res.json({ error: 'Too many requests. Try again later.' });
  const amount = round2(+req.body.amount);
  if (!(amount >= MIN_TOPUP && amount <= 1e6)) return res.json({ error: `Minimum top-up is ${MIN_TOPUP} ETB.` });
  const pf = await payFields(req.uid, req.body);
  if (pf.error) return res.json(pf);
  let p;
  try { p = await one("INSERT INTO payments(user_id,kind,amount,tx_number,sender_name,sender_phone,receipt,rhash,status,created) VALUES($1,'topup',$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING id", [req.uid, amount, pf.tx_number, pf.sender_name, pf.sender_phone, pf.receipt, pf.rhash, Date.now()]); }
  catch (e) { if (e.code === '23505') return res.json({ error: DUP }); throw e; }
  const cap = `<b>Top-up #${p.id}</b> — ${birr(amount)}\nUser: <a href="tg://user?id=${req.uid}">${req.uid}</a>\nTx: <code>${esc(pf.tx_number || '-')}</code>\nSender: ${esc(pf.sender_name || '-')} ${esc(pf.sender_phone || '')}`;
  const markup = { reply_markup: kb([{ text: 'Approve', callback_data: 'pa:' + p.id }, { text: 'Reject', callback_data: 'pr:' + p.id }]) };
  await toAdmins(async a => { if (!(pf.receipt && await safe('sendPhoto', { chat_id: a, photo: mediaUrl(pf.receipt), caption: cap, parse_mode: 'HTML', ...markup }))) await say(a, cap, markup); });
  res.json({ ok: true, id: p.id });
}));

app.post('/api/withdraw', auth, h(async (req, res) => {
  const amount = round2(+req.body.amount), method = req.body.method === 'CBE' ? 'CBE' : 'Telebirr', account = String(req.body.account || '').trim().slice(0, 60);
  if (!(amount >= MIN_WITHDRAW && amount < 1e9)) return res.json({ error: `Minimum withdrawal is ${MIN_WITHDRAW} ETB.` });
  if (!account) return res.json({ error: 'Enter your account or phone number.' });
  if (await recent('withdrawals', 'user_id', req.uid, 864e5, 5)) return res.json({ error: 'Too many withdrawal requests today.' });
  if (!(await debit(req.uid, amount, 'withdraw', method))) return res.json({ error: 'Insufficient balance.' }); // funds held atomically
  const { id } = await one('INSERT INTO withdrawals(user_id,amount,method,account,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.uid, amount, method, account, Date.now()]);
  await toAdmins(a => say(a, `<b>Withdrawal request #${id}</b>\n<a href="tg://user?id=${req.uid}">${req.uid}</a>\n${birr(amount)} to ${method}: <code>${esc(account)}</code>`,
    { reply_markup: kb([{ text: 'Mark as paid', callback_data: 'wa:' + id }, { text: 'Reject', callback_data: 'wr:' + id }]) }));
  res.json({ ok: true });
}));

// Click tracking for the ad button (one click per visitor per post)
app.get('/r/:id', h(async (req, res) => {
  const id = +req.params.id || 0;
  const r = await one('SELECT o.btn_url FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1', [id]);
  if (!r || !r.btn_url) return res.sendStatus(404);
  const who = crypto.createHash('sha256').update(String(req.get('x-forwarded-for') || req.ip || '').split(',')[0] + (req.get('user-agent') || '')).digest('hex').slice(0, 16);
  if (await one('INSERT INTO click_log(item_id,h) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING item_id', [id, who])) await q('UPDATE items SET clicks=clicks+1 WHERE id=$1', [id]);
  res.redirect(302, r.btn_url);
}));

// Admin dashboard
app.get('/api/admin/stats', auth, adm, h(async (req, res) => {
  const stats = await one("SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM channels WHERE status='approved') channels, (SELECT COUNT(*) FROM orders WHERE status IN('active','done')) paid_orders, (SELECT COALESCE(SUM(total),0) FROM orders WHERE status IN('active','done')) revenue, (SELECT COUNT(*) FROM items WHERE status='live') live");
  res.json({ stats,
    pendingOrders: await q("SELECT id,user_id,total FROM orders WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    pendingChannels: await q("SELECT id,title,username,subs FROM channels WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    pendingWd: await q("SELECT id,user_id,amount,method FROM withdrawals WHERE status='pending' ORDER BY id DESC LIMIT 20"),
    pendingTopups: await q("SELECT id,user_id,amount FROM payments WHERE kind='topup' AND status='pending' ORDER BY id DESC LIMIT 20"),
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
const closeIfDone = async oid => {
  if (!(await one("SELECT 1 FROM items WHERE order_id=$1 AND status IN('queued','posting','live','closing')", [oid])))
    await q("UPDATE orders SET status='done' WHERE id=$1 AND status='active'", [oid]);
};
const releaseCoupon = o => o.coupon ? q('UPDATE coupons SET uses=uses+1 WHERE code=$1', [o.coupon]) : null;

async function launchItem(id) {
  const i = await one("UPDATE items SET status='posting', busy_at=$2 WHERE id=$1 AND status='queued' RETURNING *", [id, Date.now()]);
  if (!i) return; // claimed by another run
  const o = await one('SELECT * FROM orders WHERE id=$1', [i.order_id]), c = await one('SELECT * FROM channels WHERE id=$1', [i.channel_id]);
  if (Date.now() - i.post_at > LATE_MS) { // approved too late: refund this post
    await q("UPDATE items SET status='missed' WHERE id=$1", [id]);
    await credit(o.user_id, i.paid, 'refund', `AD${o.id} missed slot`);
    await say2(o.user_id, 'missed', 'AD' + o.id, esc(nm(c)), birr(i.paid));
    return closeIfDone(o.id);
  }
  let ids;
  try {
    const bm = await tg('getChatMember', { chat_id: c.chat_id, user_id: await botId() }).catch(() => null);
    if (!bm || !['administrator', 'creator'].includes(bm.status)) throw new Error('bot is no longer an administrator there');
    ids = await sendAd(c.chat_id, o, o.btn_url && o.btn_text ? `${WEBAPP_URL}/r/${i.id}` : null);
  } catch (e) {
    await q("UPDATE items SET status='failed' WHERE id=$1", [id]);
    await credit(o.user_id, i.paid, 'refund', `AD${o.id} post failed`);
    await say2(o.user_id, 'refund_fail', esc(nm(c)), esc(e.message), birr(i.paid));
    await toAdmins(a => say(a, `AD${o.id} ${esc(nm(c))} post failed: ${esc(e.message)}`));
    return closeIfDone(o.id);
  }
  await q("UPDATE items SET status='live',msg_ids=$1,ends_at=$2 WHERE id=$3", [ids.join(','), Date.now() + POST_HOURS * 3600e3, id]);
  await say2(o.user_id, 'live', esc(nm(c)), POST_HOURS);
}

async function tick() {
  await tickExtras().catch(e => console.log('extras', e.message));
  const now = Date.now();
  // 1) publish posts that are due (only for approved orders)
  for (const i of await q("SELECT i.id FROM items i JOIN orders o ON o.id=i.order_id WHERE o.status='active' AND i.status='queued' AND i.post_at IS NOT NULL AND i.post_at<=$1 ORDER BY i.post_at LIMIT 20", [now]))
    await launchItem(i.id).catch(e => console.log('launch', e.message));
  // 2) finish posts whose time is over
  const rows = await q("SELECT i.*,c.chat_id,c.owner_id,c.username,c.title,o.user_id uid,u.ref FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id JOIN users u ON u.id=o.user_id WHERE i.status='live' AND i.ends_at<=$1 ORDER BY i.ends_at LIMIT 20", [now]);
  for (const i of rows) {
    if (!(await one("UPDATE items SET status='closing', busy_at=$2 WHERE id=$1 AND status='live' RETURNING id", [i.id, now]))) continue;
    const ids = idsOf(i); let removedEarly = false;
    try { await tg('deleteMessage', { chat_id: i.chat_id, message_id: ids[0] }); }
    catch (e) {
      if (/message to delete not found/i.test(e.message)) removedEarly = true;
      else if ((i.tries || 0) < 4) { await q("UPDATE items SET status='live', tries=tries+1 WHERE id=$1", [i.id]); continue; } // retry on the next ticks
      else await toAdmins(a => say(a, `AD${i.order_id}: could not delete the ad from ${esc(nm(i))} (${esc(e.message)}). Please remove it manually.`));
    }
    for (const m of ids.slice(1)) await safe('deleteMessage', { chat_id: i.chat_id, message_id: m });
    if (removedEarly) {
      await q("UPDATE items SET status='removed' WHERE id=$1", [i.id]);
      await credit(i.uid, i.paid, 'refund', `AD${i.order_id} removed early`); await say2(i.uid, 'removed_adv', esc(nm(i)), birr(i.paid));
      await say2(i.owner_id, 'removed_own', esc(nm(i)));
      await toAdmins(a => say(a, `AD${i.order_id}: ad removed early from ${esc(nm(i))} (owner ${i.owner_id}).`));
    } else {
      const pay = round2(i.price * OWNER_SHARE / 100);
      await q("UPDATE items SET status='done' WHERE id=$1", [i.id]);
      await credit(i.owner_id, pay, 'earning', `AD${i.order_id}`);
      if (i.ref) { const rc = round2(i.paid * REF_PERCENT / 100); if (rc > 0) { await credit(i.ref, rc, 'referral', `AD${i.order_id}`); await q('UPDATE users SET ref_earned=ref_earned+$1 WHERE id=$2', [rc, i.ref]); await say2(i.ref, 'ref', birr(rc)); } } // commission only for posts that really ran
      await say2(i.owner_id, 'fin_own', 'AD' + i.order_id, esc(nm(i)), birr(pay));
      await say2(i.uid, 'fin_adv', 'AD' + i.order_id, esc(nm(i)), i.clicks);
    }
    await closeIfDone(i.order_id);
  }
}
let lastClean = 0;
async function tickExtras() {
  const now = Date.now();
  // recover posts stuck by a crashed/timed-out run
  await q("UPDATE items SET status='queued' WHERE status='posting' AND busy_at<$1", [now - 5 * 60e3]);
  await q("UPDATE items SET status='live' WHERE status='closing' AND busy_at<$1", [now - 5 * 60e3]);
  // refresh member counts + avatars (5 channels per run, each once a day)
  for (const c of await q("SELECT id,chat_id FROM channels WHERE status='approved' AND COALESCE(subs_at,0)<$1 ORDER BY subs_at LIMIT 5", [now - 864e5])) {
    const n = await tg('getChatMemberCount', { chat_id: c.chat_id }).catch(() => null), f = await tg('getChat', { chat_id: c.chat_id }).catch(() => null);
    await q('UPDATE channels SET subs=COALESCE($1,subs), photo=COALESCE($2,photo), subs_at=$3 WHERE id=$4', [n, (f && f.photo && f.photo.small_file_id) || null, now, c.id]);
  }
  // delete old uploads that no order or payment uses
  if (now - lastClean > 3600e3) {
    lastClean = now;
    await q("DELETE FROM media m WHERE created<$1 AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.photos LIKE '%'||m.id||'%') AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.receipt=m.id)", [now - 2 * 864e5]);
  }
}
let lastTick = 0;
const maybeTick = async () => { if (Date.now() - lastTick < 20000) return; lastTick = Date.now(); await tick().catch(e => console.log('tick', e.message)); };

// ---------- Bot handlers ----------
const WELCOME = `Welcome to <b>Addis Ad</b> — the Telegram ad marketplace!

Open the Mini App to book a sponsored post on a channel/group, or to earn from your own channels &amp; groups.

<b>For Channel &amp; Group Owners:</b>
1. Tap <b>Publisher / Owner Mode</b> below.
2. Add this bot as an Administrator in your channel (with Post Messages) or group (with Send Messages &amp; Photos).
3. Verify your channel/group inside the Mini App (or run /connect CODE inside your group).

<b>Useful commands:</b>
• /app — Launch the Mini App
• /connect CODE — Link this group/channel using your verification token
• /id — View your User ID and this Chat ID

<b>አማርኛ:</b> እንኳን ደህና መጡ! ማስታወቂያ ለመለጠፍ "Advertiser"፣ ከቻናልዎ ገቢ ለማግኘት "Publisher / Owner Mode" ይጫኑ። ክፍያ በ Mini App ውስጥ (Wallet) ይፈጸማል።`;

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
    if (ref && ref !== uid) // opened the Mini App before /start? still credit the inviter if the user has no orders yet
      await q('UPDATE users SET ref=$2 WHERE id=$1 AND ref IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=$2) AND NOT EXISTS(SELECT 1 FROM orders WHERE user_id=$1)', [uid, ref]);
    return say(uid, `${WELCOME}\n\nYour referral link: https://t.me/${E.BOT_USERNAME || 'YOUR_BOT'}?start=ref_${uid}`, { reply_markup: menuKb() });
  }
  if (cmd === '/app') return say(uid, 'Open the Mini App:', { reply_markup: menuKb() });
  if (m.photo || m.document) return say(uid, 'Payments are made inside the Mini App: open it, then Wallet → Top Up (or choose Bank Transfer at checkout) and upload your receipt there.', { reply_markup: menuKb() });
}

async function onCallback(cb) {
  const done = t => safe('answerCallbackQuery', { callback_query_id: cb.id, text: t });
  if (!ADMINS.includes(cb.from.id)) return done('You are not an admin.');
  const [a, sid] = String(cb.data || '').split(':'), id = +sid;
  let note = '';
  if (a === 'oa') {
    const o = await one("UPDATE orders SET status='active' WHERE id=$1 AND status='pending' RETURNING *", [id]);
    if (!o) return done('Already handled.');
    await q("UPDATE payments SET status='approved' WHERE order_id=$1 AND kind='order' AND status='pending'", [id]);
    await say2(o.user_id, 'approved', 'AD' + id); note = 'Approved';
    await tick().catch(e => console.log('tick', e.message)); // publish anything that is already due
  } else if (a === 'or') {
    const o = await one("UPDATE orders SET status='rejected' WHERE id=$1 AND status='pending' RETURNING *", [id]);
    if (!o) return done('Already handled.');
    await q("UPDATE items SET status='cancelled' WHERE order_id=$1 AND status='queued'", [id]); // frees the booked hours
    await q("UPDATE payments SET status='rejected' WHERE order_id=$1 AND kind='order' AND status='pending'", [id]);
    await releaseCoupon(o);
    const wallet = o.pay_method === 'wallet';
    if (wallet) await credit(o.user_id, o.total, 'refund', `AD${id} rejected`);
    await say2(o.user_id, 'rejected', 'AD' + id, wallet); note = 'Rejected';
  } else if (a === 'ca' || a === 'cr') {
    const c = await one("UPDATE channels SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'ca' ? 'approved' : 'rejected']);
    if (!c) return done('Already handled.');
    await say2(c.owner_id, a === 'ca' ? 'chan_ok' : 'chan_no', esc(nm(c)));
    note = a === 'ca' ? 'Approved' : 'Rejected';
  } else if (a === 'wa' || a === 'wr') {
    const w = await one("UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'wa' ? 'paid' : 'rejected']);
    if (!w) return done('Already handled.');
    if (a === 'wa') { await say2(w.user_id, 'wd_paid', birr(w.amount), w.method); note = 'Paid'; }
    else { await credit(w.user_id, w.amount, 'refund', `withdrawal #${id} rejected`); await say2(w.user_id, 'wd_rej', birr(w.amount)); note = 'Rejected'; }
  } else if (a === 'pa' || a === 'pr') {
    const p = await one("UPDATE payments SET status=$2 WHERE id=$1 AND kind='topup' AND status='pending' RETURNING *", [id, a === 'pa' ? 'approved' : 'rejected']);
    if (!p) return done('Already handled.');
    if (a === 'pa') { await credit(p.user_id, p.amount, 'topup', '#' + id); await say2(p.user_id, 'topup_ok', birr(p.amount)); note = 'Approved'; }
    else { await say2(p.user_id, 'topup_no'); note = 'Rejected'; }
  }
  if (cb.message) await safe('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: note, callback_data: 'x' }]] } });
  await done(note);
}
const handle = async u => {
  if (u.message) await onMessage(u.message);
  if (u.channel_post) await onMessage(u.channel_post);
  if (u.callback_query) await onCallback(u.callback_query);
};
const UPDATES = ['message', 'channel_post', 'callback_query'];
const MENU = () => ({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: WEBAPP_URL } } });
const COMMANDS = [{ command: 'start', description: 'Welcome and open the app' }, { command: 'app', description: 'Launch the Mini App' }, { command: 'connect', description: 'Link this group/channel with your code' }, { command: 'id', description: 'Show your User ID and Chat ID' }];

// ---------- Webhook, setup and cron (Vercel) ----------
app.post('/webhook/:key', async (req, res) => {
  if (!SECRET || !safeEq(req.params.key, SECRET)) return res.sendStatus(403);
  try { await handle(req.body); await maybeTick(); } catch (e) { console.log('webhook', e.message); }
  res.sendStatus(200); // always 200 so Telegram doesn't retry
});
app.get('/api/setup', h(async (req, res) => { // open once after every deploy: /api/setup?key=SECRET
  if (!SECRET || !safeEq(req.query.key || '', SECRET)) return res.sendStatus(403);
  await tg('setWebhook', { url: `${WEBAPP_URL}/webhook/${SECRET}`, allowed_updates: UPDATES, drop_pending_updates: true });
  await safe('setChatMenuButton', MENU());
  await safe('setMyCommands', { commands: COMMANDS });
  res.send('OK: webhook, menu button and commands set');
}));
app.get('/api/cron', h(async (req, res) => { // ping every minute: /api/cron?key=SECRET
  if (!SECRET || !safeEq(req.query.key || '', SECRET)) return res.sendStatus(403);
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
