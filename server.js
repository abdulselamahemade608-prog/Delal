// Addis Ad — Telegram ad marketplace (Mini App + bot) — server.js
// Vercel (webhook) + Neon Postgres; on a VPS `node server.js` uses long polling.
// Flow: advertiser pays (wallet / bank receipt) -> admin checks bank receipts -> CHANNEL OWNER approves the ad -> bot posts on schedule.
const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool, types } = require('pg');
types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number

const E = process.env;
const BOT_TOKEN = E.BOT_TOKEN, WEBAPP_URL = (E.WEBAPP_URL || '').replace(/\/$/, ''), SECRET = E.SECRET;
const ADMINS = (E.ADMIN_IDS || '').split(',').map(s => +s.trim()).filter(Boolean);
const OWNER_SHARE = +E.OWNER_SHARE || 70, REF_PERCENT = +E.REF_PERCENT || 5;
const MIN_WITHDRAW = +E.MIN_WITHDRAW || 100, MIN_TOPUP = +E.MIN_TOPUP || 50, MIN_POST_PRICE = +E.MIN_PRICE || 50;
const POST_HOURS = +E.POST_HOURS || 1;                 // fixed-price post stays this long
const CPC_DEFAULT = +E.CPC_PRICE || 3, CPC_MIN_BUDGET = +E.CPC_MIN_BUDGET || 100, CPC_HOURS = +E.CPC_HOURS || 24; // pay-per-click
const ON_VERCEL = !!E.VERCEL;
const EAT = 3 * 3600e3, LEAD_MS = 10 * 60e3, LATE_MS = 30 * 60e3;
const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i);
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

const PKGS = { // flat prices; override with PACKAGE_PRICES='{"single":300,"daily":500,"weekly":800,"monthly":2500}'
  single: { name: 'Single Sponsored Post', tag: 'One post', price: 300, days: 1, max: 1 },
  daily: { name: 'Daily Package', tag: 'Daily', price: 500, days: 1, max: 3 },
  weekly: { name: 'Weekly Package', tag: 'Weekly', price: 800, days: 7, max: 2 },
  monthly: { name: 'Monthly Partner', tag: 'Monthly', price: 2500, days: 30, max: 2 },
  cpc: { name: 'Pay per Click', tag: 'Pay per click', price: 0, days: 1, max: 1, cpc: true }
};
const PR = json(E.PACKAGE_PRICES, {}) || {};
for (const k in PKGS) if (!PKGS[k].cpc) PKGS[k].price = +PR[k] || PKGS[k].price;
let BANKS = json(E.BANKS, null); // BANKS='[{"bank":"Telebirr","name":"Name","number":"09..."}]'
if (!Array.isArray(BANKS) || !BANKS.length) BANKS = [{ bank: 'Telebirr', name: 'Account Name', number: '09XXXXXXXX' }, { bank: 'CBE', name: 'Account Name', number: '1000XXXXXXXXX' }];
if (!BOT_TOKEN || !WEBAPP_URL || !E.DATABASE_URL || !SECRET) { console.log('Set BOT_TOKEN, WEBAPP_URL, DATABASE_URL, SECRET'); if (!ON_VERCEL) process.exit(1); }

// ---------- Database ----------
const DB_URL = (E.DATABASE_URL || '').trim().replace(/^psql\s+/, '').replace(/^['"]|['"]$/g, '').replace(/([?&])channel_binding=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: E.DB_SSL_INSECURE !== '1' }, max: ON_VERCEL ? 1 : 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
const q = (t, p = []) => pool.query(t, p).then(r => r.rows);
const one = async (t, p) => (await q(t, p))[0];
async function tx(fn) { // inside fn use ONLY `run` (the pool may have a single connection)
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn((t, p = []) => c.query(t, p).then(x => x.rows)); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => { }); throw e; } finally { c.release(); }
}
class UErr extends Error { }
const SCHEMA = '4';
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
ALTER TABLE channels ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'channel';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS bot_ok INTEGER DEFAULT 1;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS hours TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS cpc DOUBLE PRECISION;
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
ALTER TABLE items ADD COLUMN IF NOT EXISTS cpc DOUBLE PRECISION;
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

// ---------- Money (every balance change is in the ledger) ----------
const credit = (uid, amt, type, note = '', run = q) => run(
  'WITH u AS(UPDATE users SET balance=balance+$1 WHERE id=$2 RETURNING id) INSERT INTO ledger(user_id,amount,type,note,created) SELECT id,$1::float8,$3::text,$4::text,$5::bigint FROM u', [amt, uid, type, note, Date.now()]);
const debit = async (uid, amt, type, note = '', run = q) => {
  if (!(await run('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1 RETURNING id', [amt, uid])).length) return false;
  await run('INSERT INTO ledger(user_id,amount,type,note,created) VALUES($1,$2,$3,$4,$5)', [uid, -amt, type, note, Date.now()]); return true;
};
const round2 = n => Math.round(n * 100) / 100;
const split = (a, n) => { const s = Math.floor(a / n * 100) / 100; return Array.from({ length: n }, (_, i) => i < n - 1 ? s : round2(a - s * (n - 1))); };
const recent = (tbl, col, uid, ms, n) => one(`SELECT COUNT(*) n FROM ${tbl} WHERE ${col}=$1 AND created>$2`, [uid, Date.now() - ms]).then(r => r.n >= n);

// ---------- Telegram helpers ----------
async function tg(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error(j.description); return j.result;
}
const safe = (m, b) => tg(m, b).catch(e => { console.log(m, e.message); return null; });
const say = (id, text, extra = {}) => safe('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const toAdmins = fn => Promise.all(ADMINS.map(a => Promise.resolve().then(() => fn(a)).catch(e => console.log('admin', e.message))));
const kb = (...rows) => ({ inline_keyboard: rows });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const birr = n => round2(n) + ' ETB';
const nm = c => c.username ? '@' + c.username : c.title;
const pad = n => String(n).padStart(2, '0');
const mediaUrl = id => `${WEBAPP_URL}/media/${id}.jpg`;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const CATS = ['news', 'sports', 'business', 'tech', 'music', 'education', 'shopping', 'other'];
const RL = new Map();
const limited = (key, n) => { const k = key + ':' + Math.floor(Date.now() / 60000); const c = (RL.get(k) || 0) + 1; RL.set(k, c); if (RL.size > 5000) RL.clear(); return c > n; };
const LANG = new Map();
const getLang = async uid => { if (LANG.has(uid)) return LANG.get(uid); const r = await one('SELECT lang FROM users WHERE id=$1', [uid]); const l = r && r.lang === 'am' ? 'am' : 'en'; LANG.set(uid, l); return l; };
const M = {
  live: { en: (n, h) => `Your ad is live on ${n} for ${h} hour(s).`, am: (n, h) => `ማስታወቂያዎ በ${n} ላይ ለ${h} ሰዓት ተለጥፏል።` },
  fin_adv: { en: (c, n, k) => `Your ad ${c} finished on ${n}.${k ? ' Unique clicks: ' + k + '.' : ''}`, am: (c, n, k) => `ማስታወቂያዎ ${c} በ${n} ላይ ተጠናቋል።${k ? ' ጠቅታዎች: ' + k + '።' : ''}` },
  fin_own: { en: (c, n, a) => `Ad ${c} finished on ${n}. ${a} was added to your balance.`, am: (c, n, a) => `ማስታወቂያ ${c} በ${n} ላይ ተጠናቋል። ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  review: { en: (c, n) => `Payment for ${c} is confirmed. Waiting for the owner of ${n} to approve your ad.`, am: (c, n) => `የ${c} ክፍያ ተረጋግጧል። የ${n} ባለቤት ማስታወቂያዎን እንዲያጸድቅ እየተጠበቀ ነው።` },
  approved: { en: c => `The channel owner approved ${c}. Your post(s) will be published at the scheduled time(s).`, am: c => `የቻናሉ ባለቤት ${c}ን አጽድቋል። ማስታወቂያዎ በተመደበው ሰዓት ይለጠፋል።` },
  rejected: { en: (c, r) => `Order ${c} was rejected.${r ? ' The full amount was returned to your wallet.' : ' If you think this is a mistake, contact the administrator.'}`, am: (c, r) => `ትዕዛዝ ${c} ተቀባይነት አላገኘም።${r ? ' ሙሉ ገንዘቡ ወደ ዋሌትዎ ተመልሷል።' : ' ስህተት ከሆነ አድሚኑን ያነጋግሩ።'}` },
  expired: { en: c => `Order ${c} was cancelled: the channel owner did not answer before the first slot. The full amount was returned to your wallet.`, am: c => `ትዕዛዝ ${c} ተሰርዟል፤ ባለቤቱ ከመጀመሪያው ሰዓት በፊት አልመለሰም። ሙሉ ገንዘቡ ወደ ዋሌትዎ ተመልሷል።` },
  refund_fail: { en: (n, e, a) => `Could not post on ${n} (${e}). ${a} was refunded to your wallet.`, am: (n, e, a) => `በ${n} ላይ መለጠፍ አልተቻለም (${e})። ${a} ወደ ዋሌትዎ ተመልሷል።` },
  missed: { en: (c, n, a) => `A scheduled post of ${c} on ${n} could not be published in time. ${a} was refunded to your wallet.`, am: (c, n, a) => `የ${c} ማስታወቂያ በ${n} በሰዓቱ መለጠፍ አልተቻለም። ${a} ወደ ዋሌትዎ ተመልሷል።` },
  removed_own: { en: n => `The ad was deleted from ${n} before its time ended, so no payment was made.`, am: n => `ማስታወቂያው ጊዜው ሳያልቅ ከ${n} ስለተሰረዘ ክፍያ አልተፈጸመም።` },
  removed_adv: { en: (n, a) => `Your ad was removed early from ${n}. ${a} was refunded to your wallet.`, am: (n, a) => `ማስታወቂያዎ ከ${n} ቀድሞ ስለተሰረዘ ${a} ወደ ዋሌትዎ ተመልሷል።` },
  cpc_back: { en: (c, a) => `Ad ${c} used only part of its click budget. ${a} was returned to your wallet.`, am: (c, a) => `ማስታወቂያ ${c} የጠቅታ በጀቱን በከፊል ብቻ ተጠቅሟል። ${a} ወደ ዋሌትዎ ተመልሷል።` },
  ref: { en: a => `Referral commission of ${a} was added to your balance.`, am: a => `የሪፈራል ኮሚሽን ${a} ወደ ሒሳብዎ ተጨምሯል።` },
  chan_ok: { en: n => `Your chat ${n} was approved. Advertisers can book it now.`, am: n => `${n} ጸድቋል። አስተዋዋቂዎች አሁን ሊያዙት ይችላሉ።` },
  chan_no: { en: n => `Your chat ${n} was not approved.`, am: n => `${n} አልጸደቀም።` },
  wd_paid: { en: (a, m) => `${a} was sent to your ${m} account.`, am: (a, m) => `${a} ወደ ${m} ሒሳብዎ ተልኳል።` },
  wd_rej: { en: a => `Your withdrawal was rejected. ${a} was returned to your balance.`, am: a => `የገንዘብ ማውጫ ጥያቄዎ ተቀባይነት አላገኘም። ${a} ወደ ሒሳብዎ ተመልሷል።` },
  topup_ok: { en: a => `Your top-up of ${a} was approved and added to your wallet.`, am: a => `የ${a} ሙሌትዎ ጸድቆ ወደ ዋሌትዎ ተጨምሯል።` },
  topup_no: { en: () => 'Your top-up receipt was rejected. If you think this is a mistake, contact the administrator.', am: () => 'የሙሌት ደረሰኝዎ ተቀባይነት አላገኘም። ስህተት ከሆነ አድሚኑን ያነጋግሩ።' }
};
const say2 = async (uid, key, ...a) => say(uid, M[key][await getLang(uid)](...a));
let ME;
const botMe = async () => ME || (ME = await tg('getMe'));
const botId = async () => (await botMe()).id;
const botName = async () => E.BOT_USERNAME || (await botMe()).username;
const menuKb = () => kb([{ text: 'Advertiser', web_app: { url: WEBAPP_URL + '/?mode=advertiser' } }], [{ text: 'Publisher / Owner Mode', web_app: { url: WEBAPP_URL + '/?mode=publisher' } }]);

// Telegram HTML check: only allowed tags; every other < > & must be escaped
const badHtml = s => { const t = s.replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)>|<a href="https?:\/\/[^"<>\s]*">|<\/a>/gi, ''); return /[<>]/.test(t) || /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/i.test(t); };
const PM = { HTML: 'HTML', Markdown: 'Markdown' };
async function sendAd(chat, o, url) { // text, one photo, or a 1-5 photo album; returns message ids
  const pm = PM[o.parse_mode], ph = json(o.photos, []), text = o.html || '';
  const markup = url && o.btn_text ? { reply_markup: kb([{ text: o.btn_text, url }]) } : {};
  if (!ph.length) return [(await tg('sendMessage', { chat_id: chat, text, parse_mode: pm, disable_web_page_preview: true, ...markup })).message_id];
  if (ph.length === 1) return [(await tg('sendPhoto', { chat_id: chat, photo: mediaUrl(ph[0]), caption: text || undefined, parse_mode: pm, ...markup })).message_id];
  const ms = await tg('sendMediaGroup', { chat_id: chat, media: ph.map((id, i) => ({ type: 'photo', media: mediaUrl(id), ...(i === 0 && text ? { caption: text, parse_mode: pm } : {}) })) });
  const ids = ms.map(m => m.message_id);
  if (markup.reply_markup) ids.push((await tg('sendMessage', { chat_id: chat, text: '', ...markup })).message_id); // albums cannot carry buttons
  return ids;
}
const idsOf = i => String(i.msg_ids || i.msg_id || '').split(',').filter(Boolean).map(Number);

// ---------- Data helpers ----------
const userCode = uid => 'AD' + crypto.createHmac('sha256', SECRET || 'x').update(String(uid)).digest('hex').slice(0, 8).toUpperCase();
const upsertUser = (u, ref) => q('INSERT INTO users(id,name,username,ref,code,lang) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username, code=COALESCE(users.code,EXCLUDED.code)',
  [u.id, u.first_name || u.username || '', u.username || null, ref && ref !== u.id ? ref : null, userCode(u.id), String(u.language_code || '').startsWith('am') ? 'am' : 'en']);
const chMult = c => c.custom_price ? c.custom_price / PKGS.single.price : 1;
const pkgPrice = (c, k) => Math.round(PKGS[k].price * chMult(c));
const prices = c => Object.fromEntries(Object.keys(PKGS).filter(k => !PKGS[k].cpc).map(k => [k, pkgPrice(c, k)]));
const offered = c => { const h = json(c.hours, null); return Array.isArray(h) && h.length ? h : ALL_HOURS; };
const cpcOf = c => c.cpc || CPC_DEFAULT;
const slotText = o => { const pk = PKGS[o.pkg] || { days: 1 }, hs = json(o.slots, []); return `${o.start_date} · ${hs.map(h => pad(h) + ':00').join(', ')} EAT${pk.days > 1 ? ' · ' + pk.days + ' days' : ''}`; };
const chanOut = (c, bn) => ({ id: c.id, title: c.title, username: c.username || '', subs: c.subs, category: c.category || 'other', type: c.type || 'channel', photo: !!c.photo, prices: prices(c), cpc: cpcOf(c), link: `https://t.me/${bn}?start=ch_${c.id}` });

// Accept @username, t.me/username, t.me/c/ID/post (private) or a numeric chat id
const parseRef = s => {
  s = String(s || '').trim(); let m;
  if (/^-?\d{5,}$/.test(s)) return s.startsWith('-') ? s : '-100' + s;
  if ((m = s.match(/(?:t|telegram)\.me\/c\/(\d+)/i))) return '-100' + m[1];
  if ((m = s.match(/(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,})/i))) return '@' + m[1];
  if ((m = s.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/))) return '@' + m[1];
  return null;
};
// Verify the chat, the owner (must be admin) and the bot (must be admin), then list it for approval
async function registerChat(chat, ownerId, kind) {
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) return { error: 'This is not a channel or a group.' };
  if (kind === 'channel' && chat.type !== 'channel') return { error: 'This chat is a group. Switch to "Group / Supergroup" and try again.' };
  if (kind === 'group' && chat.type === 'channel') return { error: 'This chat is a channel. Switch to "Channel" and try again.' };
  const m = await tg('getChatMember', { chat_id: chat.id, user_id: ownerId }).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return { error: 'You must be an administrator of this chat.' };
  const b = await tg('getChatMember', { chat_id: chat.id, user_id: await botId() }).catch(() => null);
  if (!b || b.status !== 'administrator') return { error: 'Add the bot as an administrator first (Post Messages for channels, Send Messages for groups).' };
  const ex = await one('SELECT id,owner_id,status FROM channels WHERE chat_id=$1', [String(chat.id)]);
  if (ex && !(ex.status === 'rejected' && ex.owner_id === ownerId)) return { error: 'This chat is already registered.' };
  const full = await tg('getChat', { chat_id: chat.id }).catch(() => chat), subs = await tg('getChatMemberCount', { chat_id: chat.id });
  const v = [String(chat.id), chat.username || null, chat.title, ownerId, subs, (full.photo && full.photo.small_file_id) || null, chat.type];
  const id = ex
    ? (await one("UPDATE channels SET username=$2,title=$3,owner_id=$4,subs=$5,photo=$6,type=$7,bot_ok=1,status='pending' WHERE chat_id=$1 RETURNING id", v)).id
    : (await one("INSERT INTO channels(chat_id,username,title,owner_id,subs,photo,type,bot_ok,hours) VALUES($1,$2,$3,$4,$5,$6,$7,1,'" + JSON.stringify(ALL_HOURS) + "') RETURNING id", v)).id;
  await toAdmins(a => say(a, `<b>New ${chat.type === 'channel' ? 'channel' : 'group'} request</b>\n${esc(nm({ username: chat.username, title: chat.title }))} — ${esc(chat.title)}\n${subs} members\nOwner: <a href="tg://user?id=${ownerId}">${ownerId}</a>`,
    { reply_markup: kb([{ text: 'Approve', callback_data: 'ca:' + id }, { text: 'Reject', callback_data: 'cr:' + id }]) }));
  return { ok: true, id };
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
    const p = new URLSearchParams(req.get('x-init-data') || ''), hash = p.get('hash'); p.delete('hash');
    const check = [...p].map(([k, v]) => k + '=' + v).sort().join('\n'), key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (!hash || !safeEq(crypto.createHmac('sha256', key).update(check).digest('hex'), hash)) throw 0;
    if (Date.now() / 1000 - +p.get('auth_date') > 86400) throw 0;
    u = JSON.parse(p.get('user'));
  } catch (e) { return res.status(401).json({ error: 'Open this app inside Telegram.' }); }
  try {
    await upsertUser(u);
    const bu = await one('SELECT banned FROM users WHERE id=$1', [u.id]);
    if (bu && bu.banned) return res.status(403).json({ error: 'Your account is blocked.' });
    if (limited('u' + u.id, 150)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    req.uid = u.id; next();
  } catch (e) { console.log('auth', e.message); res.status(500).json({ error: 'Server error' }); }
}
const adm = (req, res, next) => ADMINS.includes(req.uid) ? next() : res.status(403).json({ error: 'Admins only.' });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/me', auth, h(async (req, res) => {
  await maybeTick();
  res.json({
    me: await one('SELECT id,name,username,balance,code,lang,ref_earned FROM users WHERE id=$1', [req.uid]),
    refCount: (await one('SELECT COUNT(*) n FROM users WHERE ref=$1', [req.uid])).n, botUsername: await botName(), cats: CATS, refPercent: REF_PERCENT,
    isAdmin: ADMINS.includes(req.uid), banks: BANKS, packages: Object.entries(PKGS).map(([key, p]) => ({ key, ...p })), ownerShare: OWNER_SHARE,
    minWithdraw: MIN_WITHDRAW, minTopup: MIN_TOPUP, postHours: POST_HOURS, minPostPrice: MIN_POST_PRICE, cpcMin: CPC_MIN_BUDGET, cpcHours: CPC_HOURS, cpcDefault: CPC_DEFAULT,
    withdrawals: await q('SELECT id,amount,method,account,status FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.uid])
  });
}));
app.get('/api/channels', auth, h(async (req, res) => {
  const bn = await botName();
  res.json((await q("SELECT * FROM channels WHERE status='approved' AND COALESCE(bot_ok,1)=1 ORDER BY subs DESC")).map(c => chanOut(c, bn)));
}));
app.get('/api/slots', auth, h(async (req, res) => { // hours already booked, and hours the owner does not offer
  const date = String(req.query.date || ''), days = Math.min(30, Math.max(1, +req.query.days || 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ error: 'Bad date.' });
  const cid = +req.query.channel || 0, c = await one('SELECT hours FROM channels WHERE id=$1', [cid]);
  if (!c) return res.json({ error: 'Channel not found.' });
  const [y, m, d] = date.split('-').map(Number), from = Date.UTC(y, m - 1, d, -3), on = offered(c);
  const rows = await q("SELECT DISTINCT (((post_at+10800000)/3600000)%24)::int AS h FROM items WHERE channel_id=$1 AND post_at>=$2 AND post_at<$3 AND status IN('queued','posting','live','closing')", [cid, from, from + days * 864e5]);
  res.json({ taken: rows.map(r => r.h), off: ALL_HOURS.filter(x => !on.includes(x)) });
}));
app.get('/api/mine', auth, h(async (req, res) => {
  const bn = await botName();
  const channels = (await q('SELECT * FROM channels WHERE owner_id=$1 ORDER BY id DESC', [req.uid])).map(c => ({ ...chanOut(c, bn), status: c.status, bot_ok: c.bot_ok !== 0, hours: offered(c), price: pkgPrice(c, 'single'), custom: !!c.custom_price, cpcCustom: !!c.cpc }));
  const os = await q('SELECT o.*,c.title ctitle FROM orders o LEFT JOIN channels c ON c.id=o.channel_id WHERE o.user_id=$1 ORDER BY o.id DESC LIMIT 30', [req.uid]);
  const items = os.length ? await q('SELECT id,order_id,status,post_at,ends_at,clicks,cpc,price FROM items WHERE order_id=ANY($1::bigint[]) ORDER BY post_at', [os.map(o => o.id)]) : [];
  const stats = await one("SELECT (SELECT COUNT(*) FROM orders o JOIN channels c ON c.id=o.channel_id WHERE c.owner_id=$1 AND o.status='review') review, (SELECT COUNT(*) FROM items i JOIN channels c ON c.id=i.channel_id WHERE c.owner_id=$1 AND i.status='live') live, (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE user_id=$1 AND type='earning') earned", [req.uid]);
  res.json({ channels, stats, orders: os.map(o => ({ id: o.id, code: 'AD' + o.id, channel_id: o.channel_id, channel: o.ctitle || '', pkg: o.pkg, kind: o.kind || 'text', label: o.label || '', html: o.html || '', parse_mode: o.parse_mode || 'HTML', photos: json(o.photos, []), btn_text: o.btn_text || '', btn_url: o.btn_url || '', total: o.total, discount: o.discount || 0, status: o.status, pay_method: o.pay_method, created: o.created, items: items.filter(i => i.order_id === o.id) })) });
}));
app.get('/api/wallet', auth, h(async (req, res) => res.json({
  payments: await q('SELECT id,kind,order_id,amount,tx_number,status,created FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [req.uid]),
  ledger: await q('SELECT amount,type,note,created FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 40', [req.uid])
})));
app.get('/api/coupon', auth, h(async (req, res) => {
  const c = await one('SELECT percent FROM coupons WHERE code=$1 AND uses>0', [String(req.query.code || '').trim().toUpperCase()]);
  res.json(c ? { ok: true, percent: c.percent } : { error: 'Invalid or used-up coupon.' });
}));

// Images (ad photos and receipts): the app sends a compressed JPEG data URL
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
  const c = await one("SELECT photo FROM channels WHERE id=$1 AND status IN('approved','pending')", [+req.params.id || 0]);
  if (!c || !c.photo) return res.sendStatus(404);
  const f = await tg('getFile', { file_id: c.photo }), r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
  if (!r.ok) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }).send(Buffer.from(await r.arrayBuffer()));
}));

// ----- Publisher: add chat, settings, sync -----
app.post('/api/channel', auth, h(async (req, res) => {
  const ref = parseRef(req.body.ref);
  if (!ref) return res.json({ error: 'Enter a public @username, a t.me link, a post link (t.me/c/…) or the numeric chat ID (-100…).' });
  try { res.json(await registerChat(await tg('getChat', { chat_id: ref }), req.uid, req.body.kind)); }
  catch (e) { res.json({ error: 'Chat not found. Add the bot as an administrator first, then try again. (' + e.message + ')' }); }
}));
const mineChan = (id, uid) => one('SELECT * FROM channels WHERE id=$1 AND owner_id=$2', [+id || 0, uid]);
app.post('/api/channel/settings', auth, h(async (req, res) => {
  const c = await mineChan(req.body.id, req.uid); if (!c) return res.json({ error: 'Channel not found.' });
  const cat = CATS.includes(req.body.category) ? req.body.category : (c.category || 'other');
  const price = +req.body.price > 0 ? Math.max(round2(+req.body.price), MIN_POST_PRICE) : null, cpc = +req.body.cpc > 0 ? Math.max(round2(+req.body.cpc), 0.5) : null;
  const hrs = [...new Set((Array.isArray(req.body.hours) ? req.body.hours : []).map(Number))].filter(x => Number.isInteger(x) && x >= 0 && x <= 23).sort((a, b) => a - b);
  if (!hrs.length) return res.json({ error: 'Offer at least one hour.' });
  await q('UPDATE channels SET category=$2,custom_price=$3,cpc=$4,hours=$5 WHERE id=$1', [c.id, cat, price, cpc, JSON.stringify(hrs)]);
  res.json({ ok: true });
}));
app.post('/api/channel/sync', auth, h(async (req, res) => {
  const c = await mineChan(req.body.id, req.uid); if (!c) return res.json({ error: 'Channel not found.' });
  try {
    const chat = await tg('getChat', { chat_id: c.chat_id }), subs = await tg('getChatMemberCount', { chat_id: c.chat_id }).catch(() => c.subs);
    const b = await tg('getChatMember', { chat_id: c.chat_id, user_id: await botId() }).catch(() => null), ok = !!b && ['administrator', 'creator'].includes(b.status);
    await q('UPDATE channels SET title=$2,username=$3,subs=$4,photo=COALESCE($5,photo),bot_ok=$6,subs_at=$7 WHERE id=$1', [c.id, chat.title, chat.username || null, subs, (chat.photo && chat.photo.small_file_id) || null, ok ? 1 : 0, Date.now()]);
    res.json({ ok: true, bot_ok: ok });
  } catch (e) { await q('UPDATE channels SET bot_ok=0 WHERE id=$1', [c.id]); res.json({ ok: true, bot_ok: false }); }
}));

// ----- Payments -----
async function payFields(uid, b) {
  const tx = String(b.tx || '').trim(), name = String(b.sender_name || '').trim().slice(0, 60), phone = String(b.sender_phone || '').trim().slice(0, 20), rid = b.receipt ? String(b.receipt) : null;
  if (tx && !/^[A-Za-z0-9._-]{4,40}$/.test(tx)) return { error: 'The transaction number looks invalid (letters, digits, - . _ only).' };
  let rhash = null;
  if (rid) { const m = await one('SELECT hash FROM media WHERE id=$1 AND owner=$2', [rid, uid]); if (!m) return { error: 'Receipt image not found. Upload it again.' }; rhash = m.hash; }
  if (!tx && !rid) return { error: 'Enter the transaction number or upload the receipt screenshot.' };
  return { tx_number: tx || null, sender_name: name || null, sender_phone: phone || null, receipt: rid, rhash };
}
const DUP = 'This transaction number or receipt was already used.';

// Admin only checks BANK receipts (money received). Then the channel owner reviews the ad.
async function notifyAdminPayment(o, ch, p) {
  const pk = PKGS[o.pkg] || { name: o.pkg };
  const cap = `<b>Payment check — AD${o.id}</b>\n${esc(pk.name)} · ${esc(nm(ch))}\nTotal: ${birr(o.total)}${o.discount ? ' (discount ' + birr(o.discount) + ')' : ''}\nUser: <a href="tg://user?id=${o.user_id}">${o.user_id}</a>\nTx: <code>${esc(p.tx_number || '-')}</code>\nSender: ${esc(p.sender_name || '-')} ${esc(p.sender_phone || '')}\nApprove only if the money arrived. The channel owner then reviews the ad.`;
  const markup = { reply_markup: kb([{ text: 'Money received', callback_data: 'oa:' + o.id }, { text: 'Reject', callback_data: 'or:' + o.id }]) };
  await toAdmins(async a => { if (!(p.receipt && await safe('sendPhoto', { chat_id: a, photo: mediaUrl(p.receipt), caption: cap, parse_mode: 'HTML', ...markup }))) await say(a, cap, markup); });
}
async function askOwner(o) { // the channel owner gets the ad and decides
  const c = await one('SELECT * FROM channels WHERE id=$1', [o.channel_id]), pk = PKGS[o.pkg] || { name: o.pkg };
  const gross = (await one('SELECT COALESCE(SUM(price),0) s FROM items WHERE order_id=$1', [o.id])).s, earn = round2(gross * OWNER_SHARE / 100);
  await sendAd(c.owner_id, o, o.btn_url && o.btn_text ? o.btn_url : null).catch(e => say(c.owner_id, `The ad could not be previewed: ${esc(e.message)}`));
  await say(c.owner_id, `<b>New ad for ${esc(nm(c))}</b> · AD${o.id}\n${esc(pk.name)}${pk.cpc ? ' · ' + birr(cpcOf(c)) + ' per click' : ''}\nWhen: ${esc(slotText(o))}\nYou can earn up to ${birr(earn)}\nThe advertiser has already paid; the money is held until the posts finish.\n\nApprove or reject the ad shown above.`,
    { reply_markup: kb([{ text: 'Approve', callback_data: 'ra:' + o.id }, { text: 'Reject', callback_data: 'rr:' + o.id }], [{ text: 'Open Queue', web_app: { url: WEBAPP_URL + '/?mode=publisher&tab=queue' } }]) });
}
async function refundOrder(o) { // payment was confirmed, so the whole amount goes back to the wallet
  await q("UPDATE items SET status='cancelled' WHERE order_id=$1 AND status='queued'", [o.id]);
  await releaseCoupon(o);
  await credit(o.user_id, o.total, 'refund', `AD${o.id} not accepted`);
}
async function ownerDecide(id, ok, uid) {
  const o0 = await one('SELECT o.id,c.owner_id FROM orders o JOIN channels c ON c.id=o.channel_id WHERE o.id=$1', [id]);
  if (!o0) return { error: 'Order not found.' };
  if (o0.owner_id !== uid && !ADMINS.includes(uid)) return { error: 'This is not your channel.' };
  const o = await one("UPDATE orders SET status=$2 WHERE id=$1 AND status='review' RETURNING *", [id, ok ? 'active' : 'rejected']);
  if (!o) return { error: 'Already handled.' };
  if (ok) { await say2(o.user_id, 'approved', 'AD' + id); await tick().catch(e => console.log('tick', e.message)); }
  else { await refundOrder(o); await say2(o.user_id, 'rejected', 'AD' + id, true); }
  return { ok: true };
}
app.get('/api/owner/queue', auth, h(async (req, res) => {
  const os = await q("SELECT o.*,c.title ctitle,c.username cuser,u.name aname,u.username auser FROM orders o JOIN channels c ON c.id=o.channel_id JOIN users u ON u.id=o.user_id WHERE c.owner_id=$1 AND o.status IN('review','active','done','rejected') ORDER BY (o.status='review') DESC, o.id DESC LIMIT 50", [req.uid]);
  const it = os.length ? await q("SELECT order_id,COUNT(*) n,COALESCE(SUM(price),0) gross,COALESCE(SUM(clicks),0) clicks,MIN(post_at) first FROM items WHERE order_id=ANY($1::bigint[]) GROUP BY order_id", [os.map(o => o.id)]) : [];
  res.json(os.map(o => { const i = it.find(x => x.order_id === o.id) || { n: 0, gross: 0, clicks: 0 }; return { id: o.id, code: 'AD' + o.id, status: o.status, pkg: o.pkg, channel: o.ctitle, channel_user: o.cuser || '', advertiser: o.auser ? '@' + o.auser : o.aname, kind: o.kind || 'text', label: o.label || '', html: o.html || '', parse_mode: o.parse_mode || 'HTML', photos: json(o.photos, []), btn_text: o.btn_text || '', btn_url: o.btn_url || '', slots: i.n, earn: round2(i.gross * OWNER_SHARE / 100), clicks: i.clicks, first: i.first, when: slotText(o) }; }));
}));
app.post('/api/owner/review', auth, h(async (req, res) => res.json(await ownerDecide(+req.body.id || 0, !!req.body.approve, req.uid))));

// ----- Orders -----
app.post('/api/order', auth, h(async (req, res) => {
  const b = req.body, pk = PKGS[b.pkg];
  if (!pk) return res.json({ error: 'Choose a package.' });
  if (await recent('orders', 'user_id', req.uid, 3600e3, 10)) return res.json({ error: 'Too many orders. Try again later.' });
  const ch = await one("SELECT * FROM channels WHERE id=$1 AND status='approved' AND COALESCE(bot_ok,1)=1", [+b.channel || 0]);
  if (!ch) return res.json({ error: 'This channel is not available right now.' });
  const date = String(b.date || ''), on = offered(ch), hours = [...new Set((Array.isArray(b.hours) ? b.hours : []).map(Number))].filter(x => Number.isInteger(x) && x >= 0 && x <= 23).sort((a, c) => a - c);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !hours.length || hours.length > pk.max) return res.json({ error: `Pick a start date and 1-${pk.max} posting hour(s).` });
  if (hours.some(x => !on.includes(x))) return res.json({ error: 'One of those hours is not offered by this channel.' });
  const [Y, Mo, D] = date.split('-').map(Number), times = [];
  for (let d = 0; d < pk.days; d++) for (const x of hours) times.push(Date.UTC(Y, Mo - 1, D + d, x - 3)); // EAT = UTC+3
  const now = Date.now();
  if (!(times[0] >= now + LEAD_MS) || times[0] > now + 60 * 864e5) return res.json({ error: 'The first post must be at least 10 minutes from now and within 60 days.' });
  const kind = b.kind === 'photos' ? 'photos' : 'text', pm = ['HTML', 'Markdown', 'Plain'].includes(b.parse_mode) ? b.parse_mode : 'HTML';
  const text = String(b.html || '').trim(), label = String(b.label || '').trim().slice(0, 60);
  let photos = [];
  if (kind === 'photos') {
    photos = [...new Set(Array.isArray(b.photos) ? b.photos.map(String) : [])].slice(0, 5);
    if (!photos.length) return res.json({ error: 'Add at least one photo.' });
    if ((await q('SELECT id FROM media WHERE id=ANY($1::text[]) AND owner=$2', [photos, req.uid])).length !== photos.length) return res.json({ error: 'A photo was not found. Upload it again.' });
    if (text.length > 1024) return res.json({ error: 'The caption must be 1024 characters or less.' });
  } else { if (!text) return res.json({ error: 'Write your ad text.' }); if (text.length > 4096) return res.json({ error: 'The text is too long (max 4096).' }); }
  if (pm === 'HTML' && badHtml(text)) return res.json({ error: 'Invalid HTML. Allowed tags: b, i, u, s, code, pre, a href="https://…". Write other < > & as &lt; &gt; &amp;.' });
  const bt = String(b.btn_text || '').trim().slice(0, 30), bu = String(b.btn_url || '').trim().slice(0, 300);
  if ((bt || bu) && (!bt || !/^https?:\/\/\S+$/i.test(bu))) return res.json({ error: 'The button needs a label and a link starting with http(s).' });
  let budget = 0;
  if (pk.cpc) { // pay per click: the button must lead to a channel or bot link; clicks are counted on a tracked link
    budget = round2(+b.budget);
    if (!(budget >= CPC_MIN_BUDGET && budget <= 1e5)) return res.json({ error: `The click budget must be at least ${CPC_MIN_BUDGET} ETB.` });
    if (!bt || !/^https?:\/\/(?:t|telegram)\.me\/\S+$/i.test(bu)) return res.json({ error: 'Pay-per-click needs a button with your Telegram channel or bot link (https://t.me/…).' });
  }
  const method = b.pay === 'wallet' ? 'wallet' : 'bank', pf = method === 'bank' ? await payFields(req.uid, b) : null;
  if (pf && pf.error) return res.json(pf);
  const couponCode = String(b.coupon || '').trim().toUpperCase(), gross = pk.cpc ? budget : pkgPrice(ch, b.pkg), n = times.length, rate = pk.cpc ? cpcOf(ch) : null;
  let out;
  try {
    out = await tx(async run => {
      let disc = 0;
      if (couponCode) {
        const cp = (await run('UPDATE coupons SET uses=uses-1 WHERE code=$1 AND uses>0 RETURNING percent', [couponCode]))[0];
        if (!cp) throw new UErr('Invalid or used-up coupon.');
        disc = Math.round(gross * cp.percent) / 100;
      }
      const total = round2(gross - disc), status = method === 'wallet' ? 'review' : 'pending';
      const o = (await run('INSERT INTO orders(user_id,channel_id,pkg,kind,label,html,parse_mode,photos,slots,start_date,btn_text,btn_url,total,discount,coupon,pay_method,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id',
        [req.uid, ch.id, b.pkg, kind, label || null, text, pm, JSON.stringify(photos), JSON.stringify(hours), date, bt || null, bu || null, total, disc, disc ? couponCode : null, method, status, now]))[0];
      const gs = split(gross, n), ps = split(total, n);
      for (let i = 0; i < n; i++) await run("INSERT INTO items(order_id,channel_id,price,paid,post_at,cpc,status) VALUES($1,$2,$3,$4,$5,$6,'queued')", [o.id, ch.id, gs[i], ps[i], times[i], rate]);
      if (method === 'wallet') { if (!(await debit(req.uid, total, 'order', 'AD' + o.id, run))) throw new UErr('Insufficient wallet balance.'); }
      else await run("INSERT INTO payments(user_id,kind,order_id,amount,tx_number,sender_name,sender_phone,receipt,rhash,status,created) VALUES($1,'order',$2,$3,$4,$5,$6,$7,$8,'pending',$9)", [req.uid, o.id, total, pf.tx_number, pf.sender_name, pf.sender_phone, pf.receipt, pf.rhash, now]);
      return { id: o.id, total, disc };
    });
  } catch (e) {
    if (e instanceof UErr) return res.json({ error: e.message });
    if (e.code === '23505') return res.json({ error: /items_slot/.test(e.constraint || '') ? 'One of the selected hours was just booked by someone else. Pick another hour.' : DUP });
    throw e;
  }
  const o = await one('SELECT * FROM orders WHERE id=$1', [out.id]);
  if (method === 'wallet') { await askOwner(o); await say2(req.uid, 'review', 'AD' + o.id, esc(nm(ch))); } else await notifyAdminPayment(o, ch, pf);
  res.json({ ok: true, id: out.id, code: 'AD' + out.id, total: out.total, discount: out.disc, status: o.status });
}));
app.post('/api/topup', auth, h(async (req, res) => {
  if (await recent('payments', 'user_id', req.uid, 3600e3, 10)) return res.json({ error: 'Too many requests. Try again later.' });
  const amount = round2(+req.body.amount);
  if (!(amount >= MIN_TOPUP && amount <= 1e6)) return res.json({ error: `Minimum top-up is ${MIN_TOPUP} ETB.` });
  const pf = await payFields(req.uid, req.body); if (pf.error) return res.json(pf);
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
  if (!(await debit(req.uid, amount, 'withdraw', method))) return res.json({ error: 'Insufficient balance.' });
  const { id } = await one('INSERT INTO withdrawals(user_id,amount,method,account,created) VALUES($1,$2,$3,$4,$5) RETURNING id', [req.uid, amount, method, account, Date.now()]);
  await toAdmins(a => say(a, `<b>Withdrawal request #${id}</b>\n<a href="tg://user?id=${req.uid}">${req.uid}</a>\n${birr(amount)} to ${method}: <code>${esc(account)}</code>`, { reply_markup: kb([{ text: 'Mark as paid', callback_data: 'wa:' + id }, { text: 'Reject', callback_data: 'wr:' + id }]) }));
  res.json({ ok: true });
}));

// Tracked link: counts one click per visitor; a pay-per-click post ends as soon as its budget is used
app.get('/r/:id', h(async (req, res) => {
  const id = +req.params.id || 0, r = await one('SELECT o.btn_url FROM items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1', [id]);
  if (!r || !r.btn_url) return res.sendStatus(404);
  const ua = req.get('user-agent') || '';
  if (!/bot|crawl|spider|preview|facebookexternalhit|slurp/i.test(ua)) {
    const who = crypto.createHash('sha256').update(String(req.get('x-forwarded-for') || req.ip || '').split(',')[0] + ua).digest('hex').slice(0, 16);
    if (await one('INSERT INTO click_log(item_id,h) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING item_id', [id, who])) {
      await q('UPDATE items SET clicks=clicks+1 WHERE id=$1', [id]);
      await q("UPDATE items SET ends_at=$2 WHERE id=$1 AND status='live' AND cpc>0 AND clicks*cpc>=price AND ends_at>$2", [id, Date.now()]);
    }
  }
  res.redirect(302, r.btn_url);
}));

// ----- Admin -----
app.get('/api/admin/stats', auth, adm, h(async (req, res) => {
  const stats = await one("SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM channels WHERE status='approved') channels, (SELECT COUNT(*) FROM orders WHERE status IN('review','active','done')) paid_orders, (SELECT COALESCE(SUM(total),0) FROM orders WHERE status IN('active','done')) revenue, (SELECT COUNT(*) FROM items WHERE status='live') live, (SELECT COUNT(*) FROM orders WHERE status='review') in_review");
  res.json({ stats,
    pendingOrders: await q("SELECT id FROM orders WHERE status='pending' LIMIT 50"), pendingChannels: await q("SELECT id FROM channels WHERE status='pending' LIMIT 50"),
    pendingWd: await q("SELECT id FROM withdrawals WHERE status='pending' LIMIT 50"), pendingTopups: await q("SELECT id FROM payments WHERE kind='topup' AND status='pending' LIMIT 50"), coupons: await q('SELECT * FROM coupons ORDER BY code') });
}));
app.post('/api/admin/ban', auth, adm, h(async (req, res) => { const id = +req.body.user_id; if (!id) return res.json({ error: 'Enter a user ID.' }); await q('UPDATE users SET banned=$1 WHERE id=$2', [req.body.ban ? 1 : 0, id]); res.json({ ok: true }); }));
app.post('/api/admin/coupon', auth, adm, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase().slice(0, 20), pct = Math.floor(+req.body.percent), uses = Math.floor(+req.body.uses);
  if (!/^[A-Z0-9]{3,20}$/.test(code) || !(pct >= 1 && pct <= 90) || !(uses >= 1)) return res.json({ error: 'Code 3-20 letters/digits, percent 1-90, uses 1+.' });
  await q('INSERT INTO coupons(code,percent,uses) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET percent=$2, uses=$3', [code, pct, uses]); res.json({ ok: true });
}));

// ---------- Posting + escrow ----------
const closeIfDone = async oid => { if (!(await one("SELECT 1 FROM items WHERE order_id=$1 AND status IN('queued','posting','live','closing')", [oid]))) await q("UPDATE orders SET status='done' WHERE id=$1 AND status='active'", [oid]); };
const releaseCoupon = o => o.coupon ? q('UPDATE coupons SET uses=uses+1 WHERE code=$1', [o.coupon]) : null;

async function launchItem(id) {
  const i = await one("UPDATE items SET status='posting', busy_at=$2 WHERE id=$1 AND status='queued' RETURNING *", [id, Date.now()]);
  if (!i) return;
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
    if (!bm || !['administrator', 'creator'].includes(bm.status)) { await q('UPDATE channels SET bot_ok=0 WHERE id=$1', [c.id]); throw new Error('the bot is no longer an administrator there'); }
    ids = await sendAd(c.chat_id, o, o.btn_url && o.btn_text ? `${WEBAPP_URL}/r/${i.id}` : null);
  } catch (e) {
    await q("UPDATE items SET status='failed' WHERE id=$1", [id]);
    await credit(o.user_id, i.paid, 'refund', `AD${o.id} post failed`);
    await say2(o.user_id, 'refund_fail', esc(nm(c)), esc(e.message), birr(i.paid));
    await toAdmins(a => say(a, `AD${o.id} ${esc(nm(c))} post failed: ${esc(e.message)}`));
    return closeIfDone(o.id);
  }
  const hrs = i.cpc > 0 ? CPC_HOURS : POST_HOURS;
  await q("UPDATE items SET status='live',msg_ids=$1,ends_at=$2 WHERE id=$3", [ids.join(','), Date.now() + hrs * 3600e3, id]);
  await say2(o.user_id, 'live', esc(nm(c)), hrs);
}
async function tick() {
  await tickExtras().catch(e => console.log('extras', e.message));
  const now = Date.now();
  // 0) owner never answered and the first slot has arrived: cancel and refund
  for (const x of await q("SELECT o.id FROM orders o WHERE o.status='review' AND EXISTS(SELECT 1 FROM items i WHERE i.order_id=o.id AND i.post_at<=$1) LIMIT 10", [now])) {
    const r = await one("UPDATE orders SET status='rejected' WHERE id=$1 AND status='review' RETURNING *", [x.id]);
    if (r) { await refundOrder(r); await say2(r.user_id, 'expired', 'AD' + r.id); }
  }
  // 1) publish due posts of approved orders
  for (const i of await q("SELECT i.id FROM items i JOIN orders o ON o.id=i.order_id WHERE o.status='active' AND i.status='queued' AND i.post_at IS NOT NULL AND i.post_at<=$1 ORDER BY i.post_at LIMIT 20", [now]))
    await launchItem(i.id).catch(e => console.log('launch', e.message));
  // 2) finish posts whose time (or click budget) is over
  const rows = await q("SELECT i.*,c.chat_id,c.owner_id,c.username,c.title,o.user_id uid,u.ref FROM items i JOIN channels c ON c.id=i.channel_id JOIN orders o ON o.id=i.order_id JOIN users u ON u.id=o.user_id WHERE i.status='live' AND i.ends_at<=$1 ORDER BY i.ends_at LIMIT 20", [now]);
  for (const i of rows) {
    if (!(await one("UPDATE items SET status='closing', busy_at=$2 WHERE id=$1 AND status='live' RETURNING id", [i.id, now]))) continue;
    const ids = idsOf(i); let removedEarly = false;
    try { await tg('deleteMessage', { chat_id: i.chat_id, message_id: ids[0] }); }
    catch (e) {
      if (/message to delete not found/i.test(e.message)) removedEarly = true;
      else if ((i.tries || 0) < 4) { await q("UPDATE items SET status='live', tries=tries+1 WHERE id=$1", [i.id]); continue; }
      else await toAdmins(a => say(a, `AD${i.order_id}: could not delete the ad from ${esc(nm(i))} (${esc(e.message)}). Please remove it manually.`));
    }
    for (const m of ids.slice(1)) await safe('deleteMessage', { chat_id: i.chat_id, message_id: m });
    if (removedEarly) {
      await q("UPDATE items SET status='removed' WHERE id=$1", [i.id]);
      await credit(i.uid, i.paid, 'refund', `AD${i.order_id} removed early`); await say2(i.uid, 'removed_adv', esc(nm(i)), birr(i.paid));
      await say2(i.owner_id, 'removed_own', esc(nm(i)));
      await toAdmins(a => say(a, `AD${i.order_id}: ad removed early from ${esc(nm(i))} (owner ${i.owner_id}).`));
    } else {
      const share = i.cpc > 0 ? Math.min(1, (i.clicks || 0) * i.cpc / i.price) : 1; // pay-per-click: only used clicks are paid
      const pay = round2(i.price * share * OWNER_SHARE / 100), back = round2(i.paid * (1 - share));
      await q("UPDATE items SET status='done' WHERE id=$1", [i.id]);
      if (pay > 0) { await credit(i.owner_id, pay, 'earning', `AD${i.order_id}`); await say2(i.owner_id, 'fin_own', 'AD' + i.order_id, esc(nm(i)), birr(pay)); }
      if (back > 0) { await credit(i.uid, back, 'refund', `AD${i.order_id} unused click budget`); await say2(i.uid, 'cpc_back', 'AD' + i.order_id, birr(back)); }
      if (i.ref) { const rc = round2(i.paid * share * REF_PERCENT / 100); if (rc > 0) { await credit(i.ref, rc, 'referral', `AD${i.order_id}`); await q('UPDATE users SET ref_earned=ref_earned+$1 WHERE id=$2', [rc, i.ref]); await say2(i.ref, 'ref', birr(rc)); } }
      await say2(i.uid, 'fin_adv', 'AD' + i.order_id, esc(nm(i)), i.clicks);
    }
    await closeIfDone(i.order_id);
  }
}
let lastClean = 0;
async function tickExtras() {
  const now = Date.now();
  await q("UPDATE items SET status='queued' WHERE status='posting' AND busy_at<$1", [now - 5 * 60e3]); // recover crashed runs
  await q("UPDATE items SET status='live' WHERE status='closing' AND busy_at<$1", [now - 5 * 60e3]);
  for (const c of await q("SELECT id,chat_id FROM channels WHERE status='approved' AND COALESCE(subs_at,0)<$1 ORDER BY subs_at LIMIT 5", [now - 864e5])) {
    const n = await tg('getChatMemberCount', { chat_id: c.chat_id }).catch(() => null), f = await tg('getChat', { chat_id: c.chat_id }).catch(() => null);
    const b = await tg('getChatMember', { chat_id: c.chat_id, user_id: await botId() }).catch(() => null), ok = b && ['administrator', 'creator'].includes(b.status) ? 1 : 0;
    await q('UPDATE channels SET subs=COALESCE($1,subs), photo=COALESCE($2,photo), bot_ok=$3, subs_at=$4 WHERE id=$5', [n, (f && f.photo && f.photo.small_file_id) || null, ok, now, c.id]);
  }
  if (now - lastClean > 3600e3) { lastClean = now; await q("DELETE FROM media m WHERE created<$1 AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.photos LIKE '%'||m.id||'%') AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.receipt=m.id)", [now - 2 * 864e5]); }
}
let lastTick = 0;
const maybeTick = async () => { if (Date.now() - lastTick < 20000) return; lastTick = Date.now(); await tick().catch(e => console.log('tick', e.message)); };

// ---------- Bot ----------
const WELCOME = `Welcome to <b>AddisAdBot Automation Marketplace</b>!

Launch the <b>Delal</b> Mini App right inside Telegram to book channel/group ad slots or monetize your own channels &amp; groups.

<b>For Channel &amp; Group Owners:</b>
1. Tap <b>Publisher / Owner Mode</b> below.
2. Add this bot as an Administrator in your channel (with Post Messages) or group (with Send Messages &amp; Photos).
3. Verify your channel/group inside the Mini App (or run /connect CODE inside your group).

<b>Useful commands:</b>
/app — Launch AddisAdBot Mini App
/connect CODE — Link this group/channel using your verification token
/id — View your User ID and this Chat ID`;
async function connectCmd(m, code) {
  const chat = m.chat;
  if (chat.type === 'private') return say(chat.id, 'Run /connect CODE inside the group or channel you want to link. Your code is in the Mini App: Publisher > Add Chat.');
  if (!code) return say(chat.id, 'Usage: /connect CODE');
  const u = await one('SELECT id FROM users WHERE code=$1', [code.toUpperCase()]);
  if (!u) return say(chat.id, 'Invalid code. Copy it from the Mini App.');
  const r = await registerChat(chat, u.id);
  if (r.error) return say(chat.id, r.error);
  await say(chat.id, 'Connected. Your chat was sent for approval.');
  await say(u.id, `Your chat <b>${esc(chat.title)}</b> was submitted for approval. You will be notified.`);
}
async function onMessage(m) {
  const raw = m.text || m.caption || '', parts = raw.startsWith('/') ? raw.trim().split(/\s+/) : [], cmd = (parts[0] || '').replace(/@.*$/, '').toLowerCase();
  const uid = m.from && m.from.id, priv = m.chat.type === 'private';
  if (cmd === '/id') return say(m.chat.id, `${uid ? 'Your User ID: <code>' + uid + '</code>\n' : ''}Chat ID: <code>${m.chat.id}</code>`);
  if (cmd === '/connect') return connectCmd(m, parts[1]);
  if (!priv || !uid) return;
  if (cmd === '/start') {
    const arg = parts[1] || '', ref = arg.startsWith('ref_') ? +arg.slice(4) || null : null;
    try {
    await upsertUser(m.from, ref);
    if (ref && ref !== uid) await q('UPDATE users SET ref=$2 WHERE id=$1 AND ref IS NULL AND EXISTS(SELECT 1 FROM users WHERE id=$2) AND NOT EXISTS(SELECT 1 FROM orders WHERE user_id=$1)', [uid, ref]);
    } catch (e) { console.log('start-db', e.message); }
    if (arg.startsWith('ch_')) { // advertiser link of a channel
      const c = await one("SELECT * FROM channels WHERE id=$1 AND status='approved'", [+arg.slice(3) || 0]);
      if (c) return say(uid, `<b>Advertise on ${esc(c.title)}</b>\n${esc(nm(c))} · ${c.subs} members\nFrom ${birr(pkgPrice(c, 'single'))} per post, or pay per click (${birr(cpcOf(c))}/click). Pick your hours, pay, and the owner approves.`, { reply_markup: kb([{ text: 'Book an ad', web_app: { url: `${WEBAPP_URL}/?ch=${c.id}` } }]) });
    }
    return say(uid, `${WELCOME}\n\nYour referral link: https://t.me/${await botName()}?start=ref_${uid}`, { reply_markup: menuKb() });
  }
  if (cmd === '/app') return say(uid, 'Open the Mini App:', { reply_markup: menuKb() });
  if (m.photo || m.document) return say(uid, 'Payments are made inside the Mini App: Wallet → Top Up (or Bank Transfer at checkout), then upload your receipt there.', { reply_markup: menuKb() });
}
async function onCallback(cb) {
  const done = t => safe('answerCallbackQuery', { callback_query_id: cb.id, text: t });
  const [a, sid] = String(cb.data || '').split(':'), id = +sid;
  const mark = t => cb.message ? safe('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: t, callback_data: 'x' }]] } }) : null;
  if (a === 'ra' || a === 'rr') { // channel owner decides
    const r = await ownerDecide(id, a === 'ra', cb.from.id);
    if (r.ok) await mark(a === 'ra' ? 'Approved' : 'Rejected');
    return done(r.error || (a === 'ra' ? 'Approved. It will post on schedule.' : 'Rejected. The advertiser was refunded.'));
  }
  if (!ADMINS.includes(cb.from.id)) return done('You are not an admin.');
  let note = '';
  if (a === 'oa') { // bank money received -> owner reviews
    const o = await one("UPDATE orders SET status='review' WHERE id=$1 AND status='pending' RETURNING *", [id]);
    if (!o) return done('Already handled.');
    await q("UPDATE payments SET status='approved' WHERE order_id=$1 AND kind='order' AND status='pending'", [id]);
    const c = await one('SELECT * FROM channels WHERE id=$1', [o.channel_id]);
    await say2(o.user_id, 'review', 'AD' + id, esc(nm(c))); await askOwner(o); note = 'Sent to owner';
  } else if (a === 'or') { // bank payment rejected (no money received)
    const o = await one("UPDATE orders SET status='rejected' WHERE id=$1 AND status='pending' RETURNING *", [id]);
    if (!o) return done('Already handled.');
    await q("UPDATE items SET status='cancelled' WHERE order_id=$1 AND status='queued'", [id]);
    await q("UPDATE payments SET status='rejected' WHERE order_id=$1 AND kind='order' AND status='pending'", [id]);
    await releaseCoupon(o); await say2(o.user_id, 'rejected', 'AD' + id, false); note = 'Rejected';
  } else if (a === 'ca' || a === 'cr') {
    const c = await one("UPDATE channels SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'ca' ? 'approved' : 'rejected']);
    if (!c) return done('Already handled.');
    await say2(c.owner_id, a === 'ca' ? 'chan_ok' : 'chan_no', esc(nm(c))); note = a === 'ca' ? 'Approved' : 'Rejected';
  } else if (a === 'wa' || a === 'wr') {
    const w = await one("UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending' RETURNING *", [id, a === 'wa' ? 'paid' : 'rejected']);
    if (!w) return done('Already handled.');
    if (a === 'wa') { await say2(w.user_id, 'wd_paid', birr(w.amount), w.method); note = 'Paid'; }
    else { await credit(w.user_id, w.amount, 'refund', `withdrawal #${id} rejected`); await say2(w.user_id, 'wd_rej', birr(w.amount)); note = 'Rejected'; }
  } else if (a === 'pa' || a === 'pr') {
    const p = await one("UPDATE payments SET status=$2 WHERE id=$1 AND kind='topup' AND status='pending' RETURNING *", [id, a === 'pa' ? 'approved' : 'rejected']);
    if (!p) return done('Already handled.');
    if (a === 'pa') { await credit(p.user_id, p.amount, 'topup', '#' + id); await say2(p.user_id, 'topup_ok', birr(p.amount)); note = 'Approved'; } else { await say2(p.user_id, 'topup_no'); note = 'Rejected'; }
  }
  await mark(note); await done(note);
}
const handle = async u => { if (u.message) await onMessage(u.message); if (u.channel_post) await onMessage(u.channel_post); if (u.callback_query) await onCallback(u.callback_query); };
const UPDATES = ['message', 'channel_post', 'callback_query'];
const MENU = () => ({ menu_button: { type: 'web_app', text: 'Open', web_app: { url: WEBAPP_URL } } });
const COMMANDS = [{ command: 'start', description: 'Welcome and open the app' }, { command: 'app', description: 'Launch the Mini App' }, { command: 'connect', description: 'Link this group/channel with your code' }, { command: 'id', description: 'Show your User ID and Chat ID' }];

// ---------- Webhook / setup / cron ----------
app.post('/webhook/:key', async (req, res) => {
  if (!SECRET || !safeEq(req.params.key, SECRET)) return res.sendStatus(403);
  try { await handle(req.body); await maybeTick(); } catch (e) { console.log('webhook', e.message); }
  res.sendStatus(200);
});
app.get('/api/setup', h(async (req, res) => { // open once after every deploy: /api/setup?key=SECRET
  if (!SECRET || !safeEq(req.query.key || '', SECRET)) return res.sendStatus(403);
  await tg('setWebhook', { url: `${WEBAPP_URL}/webhook/${SECRET}`, allowed_updates: UPDATES, drop_pending_updates: true });
  await safe('setChatMenuButton', MENU()); await safe('setMyCommands', { commands: COMMANDS });
  res.send('OK: webhook, menu button and commands set');
}));
app.get('/api/cron', h(async (req, res) => { // ping every minute: /api/cron?key=SECRET
  if (!SECRET || !safeEq(req.query.key || '', SECRET)) return res.sendStatus(403);
  await tick(); res.send('ok');
}));
module.exports = app;

if (!ON_VERCEL && require.main === module) { // VPS: long polling
  (async () => {
    await init(); await botId();
    app.listen(E.PORT || 3000, () => console.log('Server on', E.PORT || 3000));
    setInterval(() => tick().catch(e => console.log('tick', e.message)), 30000);
    await safe('deleteWebhook', {}); await safe('setChatMenuButton', MENU()); await safe('setMyCommands', { commands: COMMANDS });
    let offset = 0;
    for (;;) {
      try { for (const u of await tg('getUpdates', { offset, timeout: 30, allowed_updates: UPDATES })) { offset = u.update_id + 1; await handle(u).catch(e => console.log('upd', e.message)); } }
      catch (e) { console.log('poll', e.message); await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}
