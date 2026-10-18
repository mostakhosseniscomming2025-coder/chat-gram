'use strict';
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8'; // scrypt (password) kaj parallel-e korte
/*
 * Chatgram server — ekta file-e sob kichu: website serve kore + WebSocket diye chat/call/signup handle kore.
 * Sob data ei folder-er `data/` e save hoy (data/db.json + data/uploads/).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX_WS_CONNECTIONS = Math.max(50, Math.min(20000, Number(process.env.MAX_WS_CONNECTIONS) || 5000));
const MAX_WS_MESSAGES_PER_MINUTE = Math.max(30, Math.min(2400, Number(process.env.MAX_WS_MESSAGES_PER_MINUTE) || 300));
const MAX_HTTP_REQUESTS_PER_MINUTE = Math.max(60, Math.min(60000, Number(process.env.MAX_HTTP_REQUESTS_PER_MINUTE) || 3000));
const ALLOW_NO_ORIGIN = process.env.ALLOW_NO_ORIGIN === 'true';
// Hosting platform (Railway/Suga/Render/Fly...) proxy-r pichone thake, tai default-e proxy-r deya IP (X-Forwarded-For-er shesh entry) use kora hoy.
// Na hole sob user ek IP hoye rate-limit-e atke jay. Direct internet-e chalale TRUST_PROXY=false din.
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const CLOUDFLARE = process.env.CLOUDFLARE === 'true'; // Cloudflare-er pichone thakle true din (CF-Connecting-IP use hobe)
function clientIp(req) {
  const IPV = /^[0-9a-fA-F:.]{3,45}$/;
  // Render/Cloudflare-er pichone: CF-Connecting-IP-i asol user-er IP (XFF-er shesh entry proxy-r shared IP hote pare)
  if (CLOUDFLARE || process.env.RENDER) { const c = String(req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || '').trim(); if (c && IPV.test(c)) return c; }
  if (process.env.RENDER && TRUST_PROXY) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f && IPV.test(f)) return f; }
  if (TRUST_PROXY) { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean); if (x.length) return x[x.length - 1]; }
  return req.socket.remoteAddress || '?';
}
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
// Railway volume attach korle nijei oi folder use kore, kono variable lage na
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'));
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('WARNING: Volume attach kora nai. Restart/redeploy hole sob account ar message muche jabe. Volume add korun.');
}
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(UP_DIR, { recursive: true });
const sec = require('./security').create({ dataDir: DATA_DIR });

/* ------------------------------------------------------------------ embedded SQLite storage
 * Node 22's built-in SQLite: no PostgreSQL or external database service required.
 * Existing data/db.json is imported automatically on first launch and left untouched as backup.
 */
const store = require('./store').open({ file: path.join(DATA_DIR, 'chatgram.sqlite'), legacyJsonFile: DB_FILE, fs });
const { sqlite, db, save, saveNow } = store; store.saveNow = saveNow;
const RAW = store.raw; // hot loop-e Proxy-r kharoch bachate (shudhu porar jonno)
sqlite.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, t INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_t ON messages(t);`);

/* ---- messages alada table-e (protita message-e poora DB likhte hoy na) ---- */
const qPut = sqlite.prepare('INSERT OR REPLACE INTO messages (id, room, t, body) VALUES (?, ?, ?, ?)');
const qDel = sqlite.prepare('DELETE FROM messages WHERE id = ?');
const qPurge = sqlite.prepare('DELETE FROM messages WHERE t <= ?');
const qAll = sqlite.prepare('SELECT room, body FROM messages ORDER BY t ASC');
const mput = (code, m) => { try { qPut.run(String(m.id), store.mcol(code), +m.t || Date.now(), store.encrypted ? store.wrap(JSON.stringify([code, m])) : JSON.stringify(m)); } catch (e) { console.error('msg save failed:', e.message); } };
const mdel = id => { try { qDel.run(String(id)); } catch (e) { console.error('msg delete failed:', e.message); } };
(function loadMessages() {
  let moved = 0;
  if (store.legacyMessages.length) { // purano format-e room-er vitore message chhilo
    sqlite.exec('BEGIN');
    for (const [code, list] of store.legacyMessages) for (const m of list) { mput(code, m); moved++; }
    sqlite.exec('COMMIT');
  }
  let n = 0, plainMsgs = null;
  for (const row of qAll.iterate()) {
    let m, code = row.room;
    try { if (row.body.startsWith('E1:')) { const pr = JSON.parse(store.unwrap(row.body)); code = pr[0]; m = pr[1]; } else m = JSON.parse(row.body); } catch { continue; }
    let r = db.rooms[code];
    if (!r) { if (!String(code).startsWith('dm~')) continue; db.rooms[code] = { isDM: true, messages: [], reads: {} }; r = db.rooms[code]; }
    r.messages.push(m); n++;
    if (store.encrypted && !row.body.startsWith('E1:')) (plainMsgs ||= []).push([code, m]);
  }
  if (plainMsgs) { sqlite.exec('BEGIN'); for (const [c, m] of plainMsgs) mput(c, m); sqlite.exec('COMMIT'); console.log(`[security] ${plainMsgs.length} purano message encrypt kora holo`); store.saveNow(); store.scrub(); }
  else if (store.needScrub) store.scrub();
  console.log(`[storage] ${n} message memory-te load hoyeche` + (moved ? `, ${moved} purano message migrate hoyeche` : ''));
})();
// profile photo snapshot-e na rekhe file-e (2000 user x photo = snapshot boro hoye jay)
const AV_DIR = path.join(DATA_DIR, 'avatars'); fs.mkdirSync(AV_DIR, { recursive: true });
function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || ''); if (!m) return null;
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 120000) return null;
  if (!magicOk(m[1] === 'jpeg' ? 'jpg' : m[1], buf)) return null;
  const name = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(AV_DIR, name), buf); return '/avatars/' + name;
}
/* ---- Custom stickers (sticker bot diye upload, emoji-r sathe bind) ---- */
const STK_DIR = path.join(DATA_DIR, 'stickers'); fs.mkdirSync(STK_DIR, { recursive: true });
db.stickers ||= {};
const STK_MAX_USER = Number(process.env.STICKER_MAX_PER_USER) || 150;
const STK_ADMINS = (process.env.STICKER_ADMINS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const STK_ADMINS_ONLY = process.env.STICKER_UPLOAD_ADMINS_ONLY === 'true';
const STK_MIME = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const EMOJI_ONE = /^(?:\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]*)*)$/u;
const stkView = x => ({ id: x.id, url: '/stickers/' + x.file, emoji: x.emoji, owner: x.owner });
function dropPhoto(url) { if (typeof url === 'string' && url.startsWith('/avatars/')) fs.unlink(path.join(AV_DIR, path.basename(url)), () => {}); }
{ let mig = false; for (const u of Object.values(RAW.users)) if (typeof u.photo === 'string' && u.photo.startsWith('data:')) { u.photo = savePhoto(u.photo); mig = true; } if (mig) setImmediate(() => saveNow()); }

// Automatic chat retention: each message expires 24 hours after its own timestamp.
// Account, session, profile, contacts, blocks, push settings, and room membership are untouched.
const CHAT_RETENTION_MS = (Number(process.env.CHAT_RETENTION_HOURS) > 0 ? Number(process.env.CHAT_RETENTION_HOURS) : 24) * 60 * 60 * 1000;
const CHAT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let cleanupRunning = false;
function cleanupExpiredChatData() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const cutoff = Date.now() - CHAT_RETENTION_MS;
    const expired = [];
    for (const [rcode, room] of Object.entries(RAW.rooms)) {
      if (!room || !Array.isArray(room.messages) || !room.messages.length) continue;
      const keep = [];
      for (const msg of room.messages) {
        // date nai emon record rekhe dei (bhul kore data harate na hoy)
        const stamp = Number(msg && msg.t);
        if (Number.isFinite(stamp) && stamp > 0 && stamp <= cutoff) expired.push(msg); else keep.push(msg);
      }
      if (keep.length !== room.messages.length) {
        room.messages = keep;
        if (room.pinned && !keep.some(x => x.id === room.pinned.id)) delete db.rooms[rcode].pinned;
      }
    }
    if (expired.length) {
      qPurge.run(cutoff);
      // media ref ekbar-i set kore nei (protita file-er jonno shob message scan korle onek slow)
      const refs = new Set();
      for (const r of Object.values(RAW.rooms)) for (const x of r.messages) for (const u of [x.img, x.audio, x.video, x.file && x.file.url]) if (typeof u === 'string') refs.add(u);
      for (const m of expired) for (const u of [m.img, m.audio, m.video, m.file && m.file.url]) {
        if (typeof u === 'string' && u.startsWith('/uploads/') && !refs.has(u)) fs.unlink(path.join(UP_DIR, path.basename(u)), () => {});
      }
      save();
      for (const set of online.values()) for (const w of set) send(w, { push: 'purge', before: cutoff });
      console.log(`[retention] deleted ${expired.length} expired chat messages (24h policy)`);
    }
    // kono message-e nai emon purano file (orphan) shoriye fela
    if (Date.now() - lastOrphanSweep > 3600e3) {
      lastOrphanSweep = Date.now();
      const refs = new Set();
      for (const r of Object.values(RAW.rooms)) for (const x of r.messages) for (const u of [x.img, x.audio, x.video, x.file && x.file.url]) if (typeof u === 'string') refs.add(u);
      fs.readdir(UP_DIR, (e, names) => { if (e) return; for (const n of names) fs.stat(path.join(UP_DIR, n), (e2, st) => { if (!e2 && st.mtimeMs < cutoff - 3600e3 && !refs.has('/uploads/' + n)) fs.unlink(path.join(UP_DIR, n), () => {}); }); });
      for (const [k, sess] of Object.entries(RAW.sessions)) if (Date.now() - sess.created > SESSION_MS) delete db.sessions[k];
    }
  } catch (e) {
    console.error('[retention] cleanup failed:', e && e.message ? e.message : e);
  } finally {
    cleanupRunning = false;
  }
}
let lastOrphanSweep = 0;
const bk = require('./backup').start({ sqlite, saveNow, dir: DATA_DIR });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { try { saveNow(); await bk.final(); sqlite.close(); } catch (e) { console.error('shutdown save failed:', e.message); } process.exit(0); });

/* ------------------------------------------------------------------ helpers */
const rand = n => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const VERIFY = new Map(); // vtoken -> {kind,target,code,...} (memory-te, 10 min)
const VERIFIED_IDX = new Map(); // 'email:x' -> username
function verifiedTaken(kind, target) { return VERIFIED_IDX.has(kind + ':' + target); }
let scryptPending = 0; // login/signup flood-e CPU ses na hoy: ekshathe 64-er beshi password-hash cholbe na
const scrypt = (pw, salt) => {
  if (scryptPending >= 64) return Promise.reject(new Error('ratelimit'));
  scryptPending++;
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => { scryptPending--; e ? rej(e) : res(k); }));
};
const fail = code => { throw new Error(code); };
const USER_RE = /^[a-z0-9_]{3,20}$/;
const OWNER_HANDLES = new Set(String(process.env.OWNER_HANDLES || 'mostak').toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
const OWNER_KEY = String(process.env.OWNER_KEY || '');
function ownerKeyOk(k) { if (OWNER_KEY.length < 12) return false; const a = Buffer.from(String(k || '').slice(0, 200)), b = Buffer.from(OWNER_KEY); return a.length === b.length && crypto.timingSafeEqual(a, b); }
const RESERVED = new Set(['chatgram_ai', 'admin', 'chatgram', 'support', 'me', 'ai', 'system', 'root', 'null', 'undefined', 'security', '__proto__', 'constructor', 'prototype', 'administrator', 'moderator', 'official', 'staff']);
const COMMON_PW = new Set(['password', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', 'password1', 'abcd1234', '11111111', '00000000', 'chatgram', 'chatgram123', 'bangladesh', '987654321']);
const weakPassword = (pw, user) => pw.length < 8 || pw.length > 200 || COMMON_PW.has(pw.toLowerCase()) || (user && pw.toLowerCase() === String(user).toLowerCase()) || /^(.)\1+$/.test(pw);
const SESSION_MS = 60 * 24 * 3600 * 1000;

const limits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let e = limits.get(key);
  if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; limits.set(key, e); }
  return ++e.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of limits) if (now > v.reset) limits.delete(k); }, 60000).unref();

const online = new Map(); // username -> Set<ws>
const pendingCalls = new Map(); // callee -> { id, from, fromName, type, offer, t, cands[], delivered }

/* ------------------------------------------------------------------ web push (VAPID, kono library lage na) */
const b64u = b => Buffer.from(b).toString('base64url');
db.push ||= {}; // username -> [subscription]
if (!db.vapid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  db.vapid = { pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  saveNow();
}
const VAPID_KEY = crypto.createPrivateKey(db.vapid.priv);
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@chatgram.local' }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: VAPID_KEY, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${db.vapid.pub}`;
}
function hkdf(salt, ikm, info, len) { return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len)); }
function encryptPush(sub, text) { // RFC 8291 aes128gcm
  const ua = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}
async function sendPush(user, sub, payload, ttl, urgent) {
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: vapidAuth(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl || 60), Urgency: urgent ? 'high' : 'normal' }, body: encryptPush(sub, JSON.stringify(payload)), signal: AbortSignal.timeout(10000) });
    if (r.status === 404 || r.status === 410) { db.push[user] = (db.push[user] || []).filter(s => s.endpoint !== sub.endpoint); save(); }
    return r.status;
  } catch (e) { return 0; }
}
function pushTo(user, payload, ttl, urgent) {
  for (const s of db.push[user] || []) sendPush(user, s, payload, ttl, urgent);
  return (db.push[user] || []).length;
}
function endPending(to, why) {
  const p = pendingCalls.get(to); if (!p) return null;
  pendingCalls.delete(to);
  // callee kokhono call dekhe nai -> server missed call log kore
  let logged = false;
  if (why === 'missed' && !p.delivered) {
    const room = dmRoom(p.from, to);
    try { deliver(room, { id: rand(8), sender: p.from, name: p.fromName, t: Date.now(), sys: true, call: { type: p.type, status: 'missed', dur: 0 }, text: callText({ type: p.type, status: 'missed', dur: 0 }) }); logged = true; } catch {}
  }
  return { p, logged };
}
setInterval(() => { const now = Date.now(); for (const [to, p] of pendingCalls) if (now - p.t > 55000) { const r = endPending(to, 'missed'); pushUser(p.from, { push: 'call', kind: 'end', from: to, status: 'missed', callId: p.id, logged: r && r.logged }); pushTo(to, { t: 'callend', tag: 'call', callId: p.id }, 30); } }, 5000).unref();

const PRIV_FIELDS = ['lastSeen', 'photo', 'bio', 'birthday'];
const PRIV_RULES = ['all', 'contacts', 'none'];
function canSee(owner, viewer, field) {
  if (!viewer || owner.username === viewer) return true;
  const ex = owner.privEx && owner.privEx[viewer] && owner.privEx[viewer][field];
  if (typeof ex === 'boolean') return ex;
  const rule = (owner.privacy && owner.privacy[field]) || 'all';
  if (rule === 'all') return true;
  if (rule === 'none') return false;
  return !!(db.contacts[owner.username] && db.contacts[owner.username]['u_' + viewer]);
}
// viewer undefined => owner'er nijer view (shob dekhay)
function pubFor(u, viewer) {
  const o = { username: u.username, name: u.name, bio: u.bio, photo: u.photo || null, avatar: u.avatar, online: online.has(u.username), lastSeen: u.lastSeen || 0, birthday: u.birthday || '' };
  if (viewer === undefined || viewer === u.username) { o.privacy = { lastSeen: 'all', photo: 'all', bio: 'all', birthday: 'all', ...(u.privacy || {}) }; return o; }
  if (!canSee(u, viewer, 'lastSeen')) { o.online = false; o.lastSeen = 0; o.lsHidden = true; }
  if (!canSee(u, viewer, 'photo')) o.photo = null;
  if (!canSee(u, viewer, 'bio')) o.bio = '';
  if (!canSee(u, viewer, 'birthday')) o.birthday = '';
  return o;
}
const pub = u => pubFor(u);
function send(ws, obj) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > 6 * 1024 * 1024) { try { ws.terminate(); } catch {} return; } // dhimi client-er jonno server-er memory bhore jete debo na
  ws.send(JSON.stringify(obj));
}
function pushUser(username, obj, except) { const set = online.get(username); if (set) for (const w of set) if (w !== except) send(w, obj); }
// shudhu jara ei user-ke contact-e rekheche tader-ke pathai (2000 user-er sobai-ke na)
function notifyRelated(username, obj, except) {
  const key = 'u_' + username;
  for (const [u, set] of online) {
    if (u !== username && !(db.contacts[u] && db.contacts[u][key])) continue;
    for (const w of set) if (w !== except) send(w, obj);
  }
}
function notifyRelatedPub(username, build, except) { // build(viewer) -> obj
  const key = 'u_' + username;
  for (const [u, set] of online) {
    if (u !== username && !(db.contacts[u] && db.contacts[u][key])) continue;
    const obj = build(u); for (const w of set) if (w !== except) send(w, obj);
  }
}
function broadcast(obj, except) { for (const set of online.values()) for (const w of set) if (w !== except && w.user) send(w, obj); }

/* ---- Group voice/video call (rooms). Mesh WebRTC: server sirf signaling relay kore, media server-er upor diye jay na. */
const groupCalls = new Map(); // room -> { id, started, parts: Map(user -> {ws, muted, video, sharing}) }
const GC_MAX = Number(process.env.GROUP_CALL_MAX) || 8;
function gcView(code) {
  const g = groupCalls.get(code); if (!g) return { active: false, parts: [] };
  return { active: true, id: g.id, started: g.started, parts: [...g.parts].map(([u, p]) => ({ u, name: (db.users[u] && db.users[u].name) || u, muted: p.muted, video: p.video, sharing: p.sharing })) };
}
function gcBroadcast(code) { pushRoom(code, { push: 'gcstate', room: code, ...gcView(code) }); }
function gcLeave(code, user, ws) {
  const g = groupCalls.get(code); if (!g) return; const p = g.parts.get(user); if (!p || (ws && p.ws !== ws)) return;
  g.parts.delete(user);
  if (!g.parts.size) groupCalls.delete(code); else for (const q of g.parts.values()) send(q.ws, { push: 'gcpeer', room: code, kind: 'left', user });
  gcBroadcast(code);
}
function gcDropWs(ws, user) { for (const [code, g] of groupCalls) { const p = g.parts.get(user); if (p && p.ws === ws) gcLeave(code, user, ws); } }

function kickSess(user, key) { const set = online.get(user); if (set) for (const w of [...set]) if (w.sess === key) { send(w, { push: 'kicked' }); setTimeout(() => { try { w.close(); } catch {} }, 200); } }
function attach(ws, username) {
  detach(ws);
  ws.user = username;
  let set = online.get(username);
  if (!set) { set = new Set(); online.set(username, set); }
  const first = set.size === 0; set.add(ws);
  if (first) notifyRelatedPub(username, v => { const o = db.users[username]; const hid = o && !canSee(o, v, 'lastSeen'); return { push: 'presence', username, online: hid ? false : true, lastSeen: hid ? 0 : Date.now(), lsHidden: !!hid }; }, ws);
}
function detach(ws) {
  const u = ws.user; if (!u) return;
  gcDropWs(ws, u);
  ws.user = null;
  const set = online.get(u); if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    online.delete(u);
    if (db.users[u]) { db.users[u].lastSeen = Date.now(); save(); }
    notifyRelatedPub(u, v => { const o = db.users[u]; const hid = o && !canSee(o, v, 'lastSeen'); return { push: 'presence', username: u, online: false, lastSeen: hid ? 0 : Date.now(), lsHidden: !!hid }; });
  }
}

const dmParts = code => code.split('~');
const isDM = code => code.startsWith('dm~');
function canAccess(user, code) {
  if (typeof code !== 'string' || code.length > 80) return false;
  if (isDM(code)) { const p = dmParts(code); return p.length === 3 && (p[1] === user || p[2] === user) && !!db.users[p[1]] && !!db.users[p[2]]; }
  const r = db.rooms[code]; return !!r && r.members.includes(user);
}
function roomMembers(code) { return [...new Set(isDM(code) ? dmParts(code).slice(1) : (db.rooms[code] ? db.rooms[code].members : []))]; }
function peerOf(code, user) { return isDM(code) ? dmParts(code).slice(1).find(x => x !== user) : null; }
function getRoom(code) {
  if (!db.rooms[code]) db.rooms[code] = isDM(code) ? { isDM: true, messages: [], reads: {} } : fail('notfound');
  return db.rooms[code];
}
function pushRoom(code, obj, except) { for (const u of roomMembers(code)) pushUser(u, obj, except); }
const dmRoom = (a, b) => 'dm~' + [a, b].sort().join('~');
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
const blockedBetween = (a, b) => (db.blocks[a] || []).includes(b) || (db.blocks[b] || []).includes(a);
function assertCanSend(user, code) {
  const rm = db.rooms[code]; if (rm && rm.channel && rm.owner !== user) fail('forbidden');
  const peer = peerOf(code, user);
  if (peer && blockedBetween(user, peer)) fail('blocked');
}

// v3 migration: purano room gulo te "read" shurur shomoy dhore nei, jate sob unread na dekhay
if ((db.v || 0) < 3) {
  const now = Date.now();
  for (const [code, r] of Object.entries(db.rooms)) {
    r.reads ||= {};
    for (const u of (isDM(code) ? dmParts(code).slice(1) : (r.members || []))) if (r.reads[u] === undefined) r.reads[u] = now;
  }
  db.v = 3; saveNow();
}

function unreadFor(code, user) {
  const r = db.rooms[code]; if (!r) return 0;
  const rd = (r.reads && r.reads[user]) || 0; let n = 0;
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i]; if (m.t <= rd) break;
    if (m.sender !== user && (!m.sys || (m.call && m.call.status === 'missed'))) n++;
    if (n >= 99) break;
  }
  return n;
}
function lastOf(room) {
  const m = room && room.messages && room.messages[room.messages.length - 1]; if (!m) return null;
  return { t: m.t, sender: m.sender, sys: !!m.sys, call: m.call || null, text: (m.text || '').slice(0, 100), img: !!m.img, audio: !!m.audio, video: !!m.video, file: !!m.file };
}
function contactView(c, user) {
  const v = { ...c }; const room = db.rooms[c.roomCode];
  v.last = lastOf(room); v.unread = unreadFor(c.roomCode, user);
  if (c.type === 'dm') { const u = db.users[c.username]; v.user = u ? pubFor(u, user) : null; v.blockedByMe = (db.blocks[user] || []).includes(c.username); }
  else if (c.type === 'room') { v.name = room ? room.name : c.name; v.members = room ? room.members.length : 0; v.channel = !!(room && room.channel); v.owner = !!(room && room.owner === user); }
  else if (c.type === 'saved') v.name = 'Saved Messages';
  return v;
}
function myContacts(user) { return (db.contacts[user] ||= {}); }
function addContact(user, c) {
  const list = myContacts(user);
  if (!list[c.id]) { list[c.id] = { ...c, addedAt: Date.now() }; save(); return true; }
  return false;
}
const preview = m => (m.text || (m.img ? 'Photo' : m.video ? 'Video' : m.audio ? 'Voice message' : m.file ? m.file.name : '')).slice(0, 100);

/* ------------------------------------------------------------------ media */
const MEDIA = {
  image: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' },
  audio: { 'audio/webm': 'weba', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' },
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }
};
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', weba: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const MAX_MEDIA = 8 * 1024 * 1024;
const DATA_URL_RE = /^data:([a-z0-9.+/-]*)(?:;[a-z0-9=._-]+)*;base64,([A-Za-z0-9+/=]+)$/i;
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') fail('badfile');
  const m = DATA_URL_RE.exec(dataUrl); if (!m) fail('badfile');
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > MAX_MEDIA) fail('toobig');
  return { mime: m[1].toLowerCase(), buf };
}
// file-er asol content ki (magic bytes) — nam/mime vua hole reject
function startsWith(b, ...bytes) { return bytes.every((x, i) => b[i] === x); }
function magicOk(ext, b) {
  if (!b || b.length < 12) return false;
  switch (ext) {
    case 'jpg': case 'jpeg': return startsWith(b, 0xFF, 0xD8, 0xFF);
    case 'png': return startsWith(b, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
    case 'gif': return b.toString('latin1', 0, 4) === 'GIF8';
    case 'webp': return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'weba': case 'webm': return startsWith(b, 0x1A, 0x45, 0xDF, 0xA3);
    case 'ogg': return b.toString('latin1', 0, 4) === 'OggS';
    case 'mp4': case 'm4a': case 'mov': return b.toString('latin1', 4, 8) === 'ftyp' || b.toString('latin1', 4, 8) === 'moov' || b.toString('latin1', 4, 8) === 'wide' || b.toString('latin1', 4, 8) === 'mdat';
    case 'mp3': return b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0);
    case 'aac': return (b[0] === 0xFF && (b[1] & 0xF0) === 0xF0) || b.toString('latin1', 4, 8) === 'ftyp';
    default: return true;
  }
}
const BLOCKED_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'vbs', 'vbe', 'ps1', 'psm1', 'jar', 'dll', 'lnk', 'hta', 'cpl', 'reg', 'wsf', 'js', 'mjs', 'html', 'htm', 'svg', 'xhtml', 'php', 'phtml', 'sh', 'apk', 'dmg', 'pif', 'gadget']);
function saveMedia(dataUrl, kind) {
  const { mime, buf } = decodeDataUrl(dataUrl);
  const ext = MEDIA[kind][mime]; if (!ext) fail('badfile');
  if (!magicOk(ext, buf)) { sec.event('fake-upload', 'internal', { kind, mime, ext }); fail('badfile'); }
  const name = rand(12) + '.' + ext;
  fs.writeFileSync(path.join(UP_DIR, name), buf);
  return '/uploads/' + name;
}
function cleanFileName(n) {
  n = String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(-80);
  return n || 'file';
}
function saveFile(f) {
  if (!f || typeof f !== 'object') fail('badfile');
  const { buf } = decodeDataUrl(f.data);
  const fname = cleanFileName(f.name);
  const em = /\.([a-z0-9]{1,6})$/i.exec(fname);
  let ext = em ? em[1].toLowerCase() : 'bin';
  if (BLOCKED_EXT.has(ext)) fail('badfile'); // exe/script/html file pathano jabe na
  if (/\.(exe|bat|cmd|com|scr|msi|vbs|ps1|jar|dll|lnk|hta|cpl|js|html|htm|svg|php|sh)\b/i.test(fname)) fail('badfile'); // double extension (photo.jpg.exe)
  const name = rand(12) + '.' + ext;
  fs.writeFileSync(path.join(UP_DIR, name), buf);
  return { url: '/uploads/' + name, name: fname, size: buf.length };
}
function mediaRefs(url) {
  let n = 0;
  for (const r of Object.values(RAW.rooms)) {
    if (!r || !Array.isArray(r.messages)) continue;
    for (const x of r.messages) if (x && (x.img === url || x.audio === url || x.video === url || (x.file && x.file.url === url))) n++;
  }
  return n;
}
// message already list theke soriye felar PORE call korte hobe; onno kono message ei file use korle file thake (forward)
function removeMediaOf(msg) {
  for (const u of [msg.img, msg.audio, msg.video, msg.file && msg.file.url]) {
    if (typeof u === 'string' && u.startsWith('/uploads/') && mediaRefs(u) === 0) fs.unlink(path.join(UP_DIR, path.basename(u)), () => {});
  }
}

// Run on startup and periodically; message expiration is based on each message's creation time.
cleanupExpiredChatData();
setInterval(cleanupExpiredChatData, CHAT_CLEANUP_INTERVAL_MS).unref();

/* ------------------------------------------------------------------ messages */
const CALL_STATUS = ['missed', 'declined', 'ended', 'busy'];
function callText(c) {
  const T = c.type === 'video' ? 'Video' : 'Voice';
  if (c.status === 'missed') return `Missed ${c.type} call`;
  if (c.status === 'declined') return `${T} call declined`;
  if (c.status === 'busy') return `${T} call · busy`;
  return `${T} call · ${String(Math.floor(c.dur / 60)).padStart(2, '0')}:${String(c.dur % 60).padStart(2, '0')}`;
}
function deliver(code, out, ws) {
  const room = getRoom(code);
  room.messages.push(out); mput(code, out);
  (room.reads ||= {})[out.sender] = out.t;
  while (room.messages.length > 5000) { const old = room.messages.shift(); mdel(old.id); removeMediaOf(old); }
  const peer = peerOf(code, out.sender);
  if (peer && addContact(peer, { id: 'u_' + out.sender, type: 'dm', username: out.sender, roomCode: code })) {
    pushUser(peer, { push: 'contact', contact: contactView(myContacts(peer)['u_' + out.sender], peer) });
  }
  pushRoom(code, { push: 'msg', room: code, msg: out }, ws);
  if (!out.sys) for (const u of roomMembers(code)) {
    if (u === out.sender || online.has(u) || !(db.push[u] || []).length) continue;
    const c = Object.values(myContacts(u)).find(x => x.roomCode === code);
    if (c && c.muted) continue;
    if (peerOf(code, out.sender) && blockedBetween(u, out.sender)) continue;
    const body = out.text ? out.text.slice(0, 120) : out.img ? '📷 Photo' : out.audio ? '🎤 Voice message' : out.video ? '🎬 Video' : '📎 File';
    pushTo(u, { t: 'msg', title: isDM(code) ? out.name : (db.rooms[code].name || 'Room') + ' · ' + out.name, body, tag: 'm-' + code, room: code }, 3600);
  }
  save();
  return out;
}
function findMsg(code, mid) {
  const r = db.rooms[code]; const msg = r && r.messages.find(x => x.id === mid);
  if (!msg) fail('notfound');
  return { r, msg };
}

/* ------------------------------------------------------------------ ops */
async function newSession(username, ws) {
  const token = rand(32);
  const sk = sha(token);
  db.sessions[sk] = { username, created: Date.now(), last: Date.now(), ua: ws ? cleanText(ws.ua, 220) : '', ip: ws ? String(ws.ip || '').slice(0, 45) : '' };
  const uu = db.users[username]; if (uu) { (uu.sess ||= []).push(sk); while (uu.sess.length > 15) delete db.sessions[uu.sess.shift()]; } // ekjon user max 15 session
  save();
  return token;
}
function cleanText(s, max) { return typeof s === 'string' ? s.slice(0, max) : ''; }

const TRAP_OPS = new Set(['adminlogin', 'admin', 'exec', 'eval', 'shell', 'cmd', 'dump', 'debug', 'sql', 'query', 'getusers', 'listusers', 'deleteuser', 'sudo', 'root', 'config', 'env', 'backup', 'export']);
const ID_FIELDS = ['username', 'room', 'token', 'sid', 'stickerId', 'mid', 'code', 'to', 'roomCode', 'callId', 'cid', 'field', 'rule', 'kind', 'type'];
async function handle(ws, m) {
  const op = m.op;
  if (typeof op !== 'string' || op.length > 40) { sec.strike(ws.ip, 2, 'bad-op', { ua: ws.ua }); fail('badreq'); }
  // fad: asol app-e nai emon op (hacker-ra try kore) — dhorlei ban
  if (TRAP_OPS.has(op.toLowerCase())) { sec.strike(ws.ip, 10, 'ws-honeypot', { op, ua: ws.ua, user: ws.user || '' }); fail('forbidden'); }
  // identifier field-e SQL/XSS/path-traversal moto kichu thakle log + strike + reject
  for (const f of ID_FIELDS) {
    const v = m[f];
    if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { sec.strike(ws.ip, 2, 'bad-type', { op, field: f, ua: ws.ua }); fail('badreq'); }
    if (typeof v === 'string' && sec.looksMalicious(v)) { sec.counters.injection++; sec.strike(ws.ip, 4, 'injection-attempt', { op, field: f, value: v.slice(0, 120), ua: ws.ua, user: ws.user || '' }); fail('badreq'); }
  }

  /* ---- auth-free ops ---- */
  if (op === 'checkUser') {
    const u = String(m.username || '').toLowerCase();
    return { available: USER_RE.test(u) && !RESERVED.has(u) && !db.users[u], owner: OWNER_HANDLES.has(u) };
  }
  /* ---- phone/email verification (onboarding) ---- */
  if (op === 'vsend') {
    const kind = m.kind === 'email' ? 'email' : m.kind === 'phone' ? 'phone' : null;
    let target = String(m.target || '').trim().toLowerCase().slice(0, 120);
    if (!kind) fail('badreq');
    if (kind === 'email' && !/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,60}\.[a-z]{2,24}$/.test(target)) fail('bademail');
    if (kind === 'phone') { target = target.replace(/[\s()-]/g, ''); if (!/^\+[1-9][0-9]{6,14}$/.test(target)) fail('badphone'); }
    if (limited('vs:' + ws.ip, 20, 3600e3) || limited('vt:' + target, 6, 3600e3)) fail('ratelimit');
    if (verifiedTaken(kind, target)) fail('taken');
    const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');
    const vtoken = rand(16);
    VERIFY.set(vtoken, { kind, target, code, tries: 0, exp: Date.now() + 10 * 60e3, ok: false });
    if (VERIFY.size > 20000) for (const [k, v] of VERIFY) { if (v.exp < Date.now()) VERIFY.delete(k); }
    if (process.env.VERIFY_WEBHOOK_URL) { try { fetch(process.env.VERIFY_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, target, code }) }).catch(() => {}); } catch {} }
    const demo = process.env.VERIFY_DEMO !== 'false' && !process.env.VERIFY_WEBHOOK_URL;
    return demo ? { vtoken, demoCode: code } : { vtoken };
  }
  if (op === 'vcheck') {
    const v = VERIFY.get(String(m.vtoken || ''));
    if (!v || v.exp < Date.now()) fail('expired');
    if (++v.tries > 6) { VERIFY.delete(String(m.vtoken)); sec.strike(ws.ip, 2, 'verify-brute', { ua: ws.ua }); fail('expired'); }
    const a = Buffer.from(String(m.code || '').padEnd(5, ' ').slice(0, 5)), b = Buffer.from(v.code);
    if (!crypto.timingSafeEqual(a, b)) fail('badcode');
    v.ok = true; v.exp = Date.now() + 30 * 60e3;
    return { ok: true };
  }
  if (op === 'signup') {
    if (limited('su:' + ws.ip, Number(process.env.SIGNUPS_PER_HOUR_PER_IP) || 40, 3600e3)) fail('ratelimit');
    const username = String(m.username || '').toLowerCase();
    const name = cleanText(m.name, 40).trim();
    const password = String(m.password || '');
    if (!USER_RE.test(username) || RESERVED.has(username)) fail('badid');
    if (OWNER_HANDLES.has(username) && !ownerKeyOk(m.ownerKey)) { sec.strike(ws.ip, 3, 'owner-handle-try', { user: username, ua: ws.ua }); fail('ownerkey'); }
    if (!name) fail('badname');
    if (weakPassword(password, username)) fail('weak');
    if (db.users[username]) fail('taken');
    let verified = null;
    if (m.vtoken) { const v = VERIFY.get(String(m.vtoken)); if (!v || !v.ok || v.exp < Date.now()) fail('expired'); if (verifiedTaken(v.kind, v.target)) fail('taken'); verified = v; }
    let photo = null;
    if (typeof m.photo === 'string') photo = savePhoto(m.photo);
    const salt = rand(16);
    const hash = (await scrypt(password, salt)).toString('hex');
    if (db.users[username]) fail('taken');
    const u = db.users[username] = {
      username, name, bio: cleanText(m.bio, 120).trim() || 'Hey there! I am using Chatgram.', photo,
      avatar: name.substring(0, 2).toUpperCase(), created: Date.now(), lastSeen: Date.now(), salt, hash
    };
    if (verified) { u[verified.kind === 'email' ? 'email' : 'phone'] = verified.target; VERIFY.delete(String(m.vtoken)); VERIFIED_IDX.set(verified.kind + ':' + verified.target, username); }
    const token = await newSession(username, ws); ws.sess = sha(token);
    attach(ws, username);
    save();
    return { token, user: pub(u) };
  }
  if (op === 'login') {
    const username = String(m.username || '').toLowerCase();
    if (limited('li:' + ws.ip + ':' + username, 8, 600e3) || limited('lu:' + username, 40, 3600e3) || limited('lip:' + ws.ip, 60, 600e3)) fail('ratelimit');
    const u = db.users[username];
    if (!u) { await scrypt(String(m.password || ''), 'dummy-salt-timing').catch(() => {}); sec.strike(ws.ip, 1, 'login-fail', { user: username, ua: ws.ua }); fail('badcreds'); } // user nai-o ekoi somoy lage (user-enumeration roke)
    const hash = await scrypt(String(m.password || ''), u.salt);
    const ok = crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex')); if (!ok) { sec.strike(ws.ip, 1, 'login-fail', { user: username, ua: ws.ua }); fail('badcreds'); }
    const token = await newSession(username, ws); ws.sess = sha(token);
    attach(ws, username);
    return { token, user: pub(u) };
  }
  if (op === 'resume') {
    const s = db.sessions[sha(String(m.token || ''))];
    if (!s || Date.now() - s.created > SESSION_MS || !db.users[s.username]) fail('auth');
    ws.sess = sha(String(m.token));
    if (Date.now() - (s.last || 0) > 300e3) { s.last = Date.now(); if (!s.ua && ws.ua) s.ua = cleanText(ws.ua, 220); if (!s.ip && ws.ip) s.ip = String(ws.ip).slice(0, 45); save(); }
    attach(ws, s.username);
    return { user: pub(db.users[s.username]) };
  }

  /* ---- authed ops ---- */
  const user = ws.user; if (!user) fail('auth');
  const me = db.users[user];

  switch (op) {
    case 'logout': {
      if (m.token) delete db.sessions[sha(String(m.token))];
      detach(ws); save(); return true;
    }
    case 'profile': {
      const name = cleanText(m.name, 40).trim(); if (!name) fail('badname');
      me.name = name; me.avatar = name.substring(0, 2).toUpperCase();
      me.bio = cleanText(m.bio, 120).trim() || 'Hey there! I am using Chatgram.';
      if (m.photo === null) { dropPhoto(me.photo); me.photo = null; }
      else if (typeof m.photo === 'string' && m.photo.startsWith('data:')) { const np = savePhoto(m.photo); if (np) { dropPhoto(me.photo); me.photo = np; } }
      save();
      if (typeof m.birthday === 'string') me.birthday = /^(\d{4}-)?\d{2}-\d{2}$/.test(m.birthday.trim()) ? m.birthday.trim() : '';
      save();
      notifyRelatedPub(user, v => ({ push: 'profile', user: pubFor(me, v) }));
      return pub(me);
    }
    case 'privacy': {
      const ex = Object.entries(me.privEx || {}).map(([un, f]) => ({ username: un, name: db.users[un] ? db.users[un].name : un, f }));
      return { rules: { lastSeen: 'all', photo: 'all', bio: 'all', birthday: 'all', ...(me.privacy || {}) }, ex };
    }
    case 'setPrivacy': {
      const f = String(m.field || ''), r = String(m.rule || ''); if (!PRIV_FIELDS.includes(f) || !PRIV_RULES.includes(r)) fail('badreq');
      me.privacy = { ...(me.privacy || {}), [f]: r }; save();
      notifyRelatedPub(user, v => ({ push: 'profile', user: pubFor(me, v) }));
      notifyRelatedPub(user, v => ({ push: 'presence', username: user, online: canSee(me, v, 'lastSeen') && online.has(user), lastSeen: canSee(me, v, 'lastSeen') ? (me.lastSeen || 0) : 0, lsHidden: !canSee(me, v, 'lastSeen') }));
      return true;
    }
    case 'setPrivEx': { // per-user "What can they see?" override; allow: true | false | null(default)
      const un = String(m.username || '').toLowerCase(); const f = String(m.field || '');
      if (!db.users[un] || un === user || !PRIV_FIELDS.includes(f)) fail('badreq');
      me.privEx ||= {}; const cur = { ...(me.privEx[un] || {}) };
      if (m.allow === null) delete cur[f]; else cur[f] = !!m.allow;
      if (Object.keys(cur).length) me.privEx[un] = cur; else delete me.privEx[un];
      if (Object.keys(me.privEx).length > 500) fail('full');
      save();
      const send1 = o => pushUser(un, o);
      send1({ push: 'profile', user: pubFor(me, un) });
      const see = canSee(me, un, 'lastSeen'); send1({ push: 'presence', username: user, online: see && online.has(user), lastSeen: see ? (me.lastSeen || 0) : 0, lsHidden: !see });
      return { f: me.privEx[un] || {} };
    }
    case 'changePassword': {
      if (limited('pw:' + user, 6, 600e3)) fail('ratelimit');
      const hash = await scrypt(String(m.oldPassword || ''), me.salt);
      if (!crypto.timingSafeEqual(hash, Buffer.from(me.hash, 'hex'))) fail('badcreds');
      const np = String(m.newPassword || ''); if (weakPassword(np, user)) fail('weak');
      me.salt = rand(16); me.hash = (await scrypt(np, me.salt)).toString('hex');
      for (const [k, s] of Object.entries(RAW.sessions)) if (s.username === user) delete db.sessions[k];
      const token = await newSession(user, ws); ws.sess = sha(token); save();
      return { token };
    }
    case 'search': {
      if (limited('sr:' + user, 40, 60e3)) fail('ratelimit');
      const q = String(m.q || '').toLowerCase().replace(/^@/, '').trim();
      if (q.length < 2 || q.length > 32) return [];
      const starts = [], contains = [];
      for (const un in RAW.users) {
        const u = RAW.users[un]; if (un === user) continue;
        const nm = (u.name || '').toLowerCase();
        if (un.startsWith(q) || nm.startsWith(q)) { if (starts.length < 12) starts.push(u); }
        else if (contains.length < 12 && nm.includes(q)) contains.push(u);
        if (starts.length >= 12) break;
      }
      return starts.concat(contains).slice(0, 12).map(u => pubFor(u, user));
    }
    case 'getUser': {
      const u = db.users[String(m.username || '').toLowerCase()]; if (!u) fail('notfound'); return pubFor(u, user);
    }
    case 'contacts': {
      return Object.values(myContacts(user)).map(c => contactView(c, user));
    }
    case 'openDM': {
      const other = String(m.username || '').toLowerCase();
      if (other === user || !db.users[other]) fail('notfound');
      const room = dmRoom(user, other); getRoom(room);
      addContact(user, { id: 'u_' + other, type: 'dm', username: other, roomCode: room });
      return contactView(myContacts(user)['u_' + other], user);
    }
    case 'openSaved': {
      const room = dmRoom(user, user); getRoom(room);
      addContact(user, { id: 'saved', type: 'saved', roomCode: room });
      return contactView(myContacts(user).saved, user);
    }
    case 'openRoom': {
      const code = cleanCode(m.code);
      if (code.length < 4 || code.length > 32) fail('badcode');
      let created = false, room = db.rooms[code];
      if (!room) {
        if (limited('rm:' + user, 20, 3600e3)) fail('ratelimit');
        room = db.rooms[code] = { name: cleanText(m.name, 40).trim() || code, owner: user, created: Date.now(), members: [], messages: [], reads: {}, channel: !!m.channel };
        created = true;
      }
      if (!room.members.includes(user)) { room.members.push(user); (room.reads ||= {})[user] = Date.now(); pushRoom(code, { push: 'roommembers', room: code, count: room.members.length }, ws); }
      addContact(user, { id: 'r_' + code, type: 'room', roomCode: code, name: room.name });
      save();
      return { contact: contactView(myContacts(user)['r_' + code], user), created };
    }
    case 'stickers': return Object.values(db.stickers).sort((a, b) => b.t - a.t).slice(0, 3000).map(stkView);
    case 'stickerAdd': {
      if (STK_ADMINS_ONLY && !STK_ADMINS.includes(user)) fail('forbidden');
      if (limited('sk:' + user, 40, 3600e3)) fail('ratelimit');
      const emoji = String(m.emoji || '').trim(); if (!EMOJI_ONE.test(emoji) || emoji.length > 24) fail('badreq');
      const { mime, buf } = decodeDataUrl(m.img); const ext = STK_MIME[mime]; if (!ext) fail('badfile');
      if (buf.length > 600 * 1024) fail('toobig');
      if (!magicOk(ext, buf)) fail('badfile');
      const mine = Object.values(db.stickers).filter(x => x.owner === user).length; if (mine >= STK_MAX_USER && !STK_ADMINS.includes(user)) fail('full');
      const id = rand(8), file = crypto.randomBytes(10).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(STK_DIR, file), buf);
      const rec = db.stickers[id] = { id, file, emoji, owner: user, t: Date.now() }; save();
      broadcast({ push: 'stickerAdded', sticker: stkView(rec) });
      return stkView(rec);
    }
    case 'stickerDel': {
      const x = db.stickers[String(m.sid || '')]; if (!x) fail('notfound');
      if (x.owner !== user && !STK_ADMINS.includes(user)) fail('forbidden');
      delete db.stickers[x.id]; fs.unlink(path.join(STK_DIR, x.file), () => {}); save();
      broadcast({ push: 'stickerRemoved', id: x.id }); return true;
    }
    case 'devices': {
      const cur = sha(String(m.token || ''));
      return Object.entries(RAW.sessions).filter(([, x]) => x.username === user).map(([k, x]) => ({ id: k.slice(0, 16), ua: x.ua || '', ip: x.ip || '', created: x.created, last: x.last || x.created, current: k === cur })).sort((a, b) => b.last - a.last);
    }
    case 'endDevice': {
      const id = String(m.id || ''); if (id.length < 8) fail('badreq');
      const cur = sha(String(m.token || ''));
      for (const [k, x] of Object.entries(RAW.sessions)) if (x.username === user && k.startsWith(id) && k !== cur) { delete db.sessions[k]; kickSess(user, k); }
      save(); return true;
    }
    case 'endOtherDevices': {
      const cur = sha(String(m.token || ''));
      for (const [k, x] of Object.entries(RAW.sessions)) if (x.username === user && k !== cur) { delete db.sessions[k]; kickSess(user, k); }
      save(); return true;
    }
    case 'recentCalls': {
      const out = [];
      for (const c of Object.values(myContacts(user))) {
        if (c.type !== 'dm') continue; const r = db.rooms[c.roomCode]; if (!r) continue;
        for (const x of r.messages) if (x.call) out.push({ id: x.id, peer: c.username, name: (db.users[c.username] || {}).name || c.username, type: x.call.type, status: x.call.status, dur: x.call.dur || 0, t: x.t, out: x.sender === user });
      }
      return out.sort((a, b) => b.t - a.t).slice(0, 60);
    }
    case 'removeContact': {
      const id = String(m.cid || ''); const c = myContacts(user)[id]; if (!c) return true;
      delete myContacts(user)[id];
      if (c.type === 'room' && db.rooms[c.roomCode]) {
        db.rooms[c.roomCode].members = db.rooms[c.roomCode].members.filter(x => x !== user);
        pushRoom(c.roomCode, { push: 'roommembers', room: c.roomCode, count: db.rooms[c.roomCode].members.length });
      }
      save(); return true;
    }
    case 'chatPref': {
      const c = myContacts(user)[String(m.cid || '')]; if (!c) fail('notfound');
      if (typeof m.pinned === 'boolean') c.pinned = m.pinned;
      if (typeof m.muted === 'boolean') c.muted = m.muted;
      save(); return contactView(c, user);
    }
    case 'block': {
      const other = String(m.username || '').toLowerCase();
      if (other === user || !db.users[other]) fail('notfound');
      const list = (db.blocks[user] ||= []);
      const i = list.indexOf(other);
      if (m.on && i < 0) list.push(other); else if (!m.on && i >= 0) list.splice(i, 1);
      save(); return !!m.on;
    }
    case 'members': {
      const code = String(m.room || ''); if (isDM(code) || !canAccess(user, code)) fail('forbidden');
      const r = db.rooms[code];
      return { owner: r.owner, members: r.members.slice(0, 300).map(u => db.users[u]).filter(Boolean).map(x => pubFor(x, user)) };
    }
    case 'history': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      const r = db.rooms[code];
      const base = { reads: (r && r.reads) || {}, pinned: (r && r.pinned) || null };
      const peer = peerOf(code, user);
      if (peer) base.blockedByMe = (db.blocks[user] || []).includes(peer);
      if (!r) return { messages: [], more: false, ...base };
      const all = r.messages; let list, more;
      if (m.around) {
        const i = all.findIndex(x => x.id === m.around); if (i < 0) fail('notfound');
        const s = Math.max(0, i - 40); list = all.slice(s, s + 600); more = s > 0; base.partial = s + 600 < all.length;
      } else if (m.before) {
        const t = +m.before || 0; const idx = all.findIndex(x => x.t >= t); const end = idx < 0 ? all.length : idx;
        const s = Math.max(0, end - 60); list = all.slice(s, end); more = s > 0;
      } else {
        const s = Math.max(0, all.length - 80); list = all.slice(s); more = s > 0;
      }
      return { messages: list, more, ...base };
    }
    case 'searchMsgs': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      const q = String(m.q || '').trim().toLowerCase(); if (q.length < 2 || q.length > 60) return [];
      if (limited('sm:' + user, 40, 10e3)) fail('ratelimit');
      const r = db.rooms[code]; if (!r) return [];
      const out = [];
      for (let i = r.messages.length - 1; i >= 0 && out.length < 40; i--) {
        const x = r.messages[i]; if (x.sys) continue;
        const t = (x.text || '') + ' ' + (x.file ? x.file.name : '');
        if (t.toLowerCase().includes(q)) out.push({ id: x.id, t: x.t, sender: x.sender, name: x.name, text: preview(x) });
      }
      return out;
    }
    case 'read': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      if (limited('rd:' + user, 200, 10e3)) return 0;
      const r = db.rooms[code]; if (!r) return 0;
      const t = Date.now(); (r.reads ||= {})[user] = t; save();
      pushRoom(code, { push: 'read', room: code, user, t }, ws);
      return t;
    }
    case 'typing': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      if (limited('ty:' + user, 30, 10e3)) return false;
      pushRoom(code, { push: 'typing', room: code, user }, ws);
      return true;
    }
    case 'send': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      if (limited('msg:' + user, 60, 10e3)) fail('ratelimit');
      assertCanSend(user, code);
      const src = m.msg || {};
      const out = { id: rand(8), sender: user, name: me.name, t: Date.now() };
      const text = cleanText(src.text, 4000);
      if (text.trim()) out.text = text;
      if (src.call && typeof src.call === 'object') {
        const peer = peerOf(code, user); if (!peer) fail('badreq');
        const c = { type: src.call.type === 'video' ? 'video' : 'voice', status: CALL_STATUS.includes(src.call.status) ? src.call.status : 'ended', dur: Math.max(0, Math.min(86400, parseInt(src.call.dur, 10) || 0)) };
        out.sys = true; out.call = c; out.text = callText(c);
      } else {
        if (typeof src.stickerId === 'string' && src.stickerId) {
          const sk = db.stickers[src.stickerId]; if (!sk) fail('notfound');
          out.stk = '/stickers/' + sk.file; out.text = sk.emoji + ' Sticker';
        }
        if (typeof src.sticker === 'string' && src.sticker) {
          const st = src.sticker.slice(0, 24);
          if (!/^(?:\p{Extended_Pictographic}[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]*)+$/u.test(st)) fail('badreq');
          out.sticker = st; out.text = st + ' Sticker';
        }
        if (src.img || src.audio || src.video || src.file) { if (limited('up:' + user, 60, 3600e3)) fail('ratelimit'); }
        if (src.img) out.img = saveMedia(src.img, 'image');
        if (src.audio) out.audio = saveMedia(src.audio, 'audio');
        if (src.video) out.video = saveMedia(src.video, 'video');
        if (src.file) out.file = saveFile(src.file);
        if (!out.text && !out.img && !out.audio && !out.video && !out.file) fail('empty');
      }
      if (src.reply && typeof src.reply === 'object') out.reply = { id: cleanText(src.reply.id, 40), name: cleanText(src.reply.name, 40), text: cleanText(src.reply.text, 100) };
      return deliver(code, out, ws);
    }
    case 'forward': {
      const from = String(m.from || ''), to = String(m.to || '');
      if (!canAccess(user, from) || !canAccess(user, to)) fail('forbidden');
      if (limited('fw:' + user, 30, 10e3)) fail('ratelimit');
      assertCanSend(user, to);
      const { msg: src } = findMsg(from, String(m.mid || '')); if (src.sys) fail('notfound');
      const out = { id: rand(8), sender: user, name: me.name, t: Date.now(), fwd: { name: src.fwd ? src.fwd.name : (src.name || src.sender) } };
      for (const k of ['text', 'img', 'audio', 'video', 'sticker', 'stk']) if (src[k]) out[k] = src[k];
      if (src.file) out.file = { ...src.file };
      return deliver(to, out, ws);
    }
    case 'edit': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      const { r, msg } = findMsg(code, String(m.mid || ''));
      if (msg.sender !== user || msg.sys || msg.audio || msg.sticker || msg.stk) fail('forbidden');
      const text = cleanText(m.text, 4000).trim();
      if (!text && !(msg.img || msg.video || msg.file)) fail('empty');
      if (text) msg.text = text; else delete msg.text;
      msg.edited = Date.now(); mput(code, msg);
      if (r.pinned && r.pinned.id === msg.id) r.pinned.text = preview(msg);
      save();
      pushRoom(code, { push: 'edit', room: code, mid: msg.id, text: msg.text || '', edited: msg.edited }, ws);
      return { edited: msg.edited };
    }
    case 'react': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      if (limited('rc:' + user, 60, 10e3)) fail('ratelimit');
      const { msg } = findMsg(code, String(m.mid || '')); if (msg.sys) fail('badreq');
      const emoji = String(m.emoji || '');
      if (emoji.length > 10 || !/\p{Extended_Pictographic}/u.test(emoji)) fail('badreq');
      msg.reactions ||= {};
      const had = (msg.reactions[emoji] || []).includes(user);
      for (const e of Object.keys(msg.reactions)) { msg.reactions[e] = msg.reactions[e].filter(u => u !== user); if (!msg.reactions[e].length) delete msg.reactions[e]; }
      if (!had) {
        if (Object.keys(msg.reactions).length >= 12) fail('badreq');
        (msg.reactions[emoji] ||= []).push(user);
      }
      if (!Object.keys(msg.reactions).length) delete msg.reactions;
      save();
      mput(code, msg);
      const reactions = msg.reactions || {};
      pushRoom(code, { push: 'react', room: code, mid: msg.id, reactions }, ws);
      return reactions;
    }
    case 'pin': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      const r = getRoom(code);
      if (m.mid) { const { msg } = findMsg(code, String(m.mid)); if (msg.sys) fail('badreq'); r.pinned = { id: msg.id, text: preview(msg), by: user, t: Date.now() }; }
      else delete r.pinned;
      save();
      pushRoom(code, { push: 'pin', room: code, pinned: r.pinned || null }, ws);
      return r.pinned || null;
    }
    case 'del': {
      const code = String(m.room || ''); if (!canAccess(user, code)) fail('forbidden');
      const room = db.rooms[code]; if (!room) return true;
      const i = room.messages.findIndex(x => x.id === m.mid); if (i < 0) return true;
      if (room.messages[i].sender !== user) fail('forbidden');
      const [gone] = room.messages.splice(i, 1); mdel(gone.id);
      removeMediaOf(gone);
      let unpinned = false;
      if (room.pinned && room.pinned.id === gone.id) { delete room.pinned; unpinned = true; }
      save();
      pushRoom(code, { push: 'del', room: code, id: m.mid }, ws);
      if (unpinned) pushRoom(code, { push: 'pin', room: code, pinned: null }, ws);
      return { unpinned };
    }
    case 'gcInfo': { const code = String(m.room || ''); if (isDM(code) || !canAccess(user, code)) fail('forbidden'); return gcView(code); }
    case 'gcJoin': {
      const code = String(m.room || ''); if (isDM(code) || !canAccess(user, code)) fail('forbidden');
      if (limited('gj:' + user, 30, 60e3)) fail('ratelimit');
      let g = groupCalls.get(code);
      if (!g) { g = { id: crypto.randomBytes(6).toString('hex'), started: Date.now(), parts: new Map() }; groupCalls.set(code, g); }
      if (!g.parts.has(user) && g.parts.size >= GC_MAX) fail('full');
      const peers = [...g.parts.keys()].filter(x => x !== user);
      g.parts.set(user, { ws, muted: !!m.muted, video: false, sharing: false });
      for (const [u, q] of g.parts) if (u !== user) send(q.ws, { push: 'gcpeer', room: code, kind: 'joined', user, name: me.name });
      gcBroadcast(code);
      return { id: g.id, peers, view: gcView(code), max: GC_MAX };
    }
    case 'gcLeave': { gcLeave(String(m.room || ''), user, ws); return {}; }
    case 'gcSig': {
      const code = String(m.room || ''), to = String(m.to || '').toLowerCase(), kind = String(m.kind || '');
      const g = groupCalls.get(code); if (!g || !g.parts.has(user) || !g.parts.has(to) || to === user) fail('notfound');
      if (!['offer', 'answer', 'cand'].includes(kind)) fail('badreq');
      if (!m.data || JSON.stringify(m.data).length > 60000) fail('badreq');
      send(g.parts.get(to).ws, { push: 'gcsig', room: code, from: user, kind, data: m.data });
      return {};
    }
    case 'gcState': {
      const code = String(m.room || ''); const g = groupCalls.get(code); const p = g && g.parts.get(user); if (!p) fail('notfound');
      if (typeof m.muted === 'boolean') p.muted = m.muted; if (typeof m.video === 'boolean') p.video = m.video; if (typeof m.sharing === 'boolean') p.sharing = m.sharing;
      gcBroadcast(code); return {};
    }
    case 'call': {
      const to = String(m.to || '').toLowerCase(); if (!db.users[to] || to === user) fail('notfound');
      const kind = String(m.kind || '');
      if (!['offer', 'answer', 'cand', 'end'].includes(kind)) fail('badreq');
      if (kind === 'offer') {
        if (blockedBetween(user, to)) fail('blocked');
        if (limited('co:' + user, 20, 60e3)) fail('ratelimit');
      }
      const payload = { push: 'call', kind, from: user, fromName: me.name, callId: cleanText(m.callId, 40), type: m.type === 'video' ? 'video' : 'voice' };
      if (kind === 'offer' || kind === 'answer') {
        const sdp = kind === 'offer' ? m.offer : m.answer;
        if (!sdp || typeof sdp.sdp !== 'string' || sdp.sdp.length > 60000) fail('badreq');
        payload[kind] = { type: String(sdp.type), sdp: sdp.sdp };
      }
      if (kind === 'cand') { if (!m.candidate || JSON.stringify(m.candidate).length > 4000) fail('badreq'); payload.candidate = m.candidate; }
      if (kind === 'end') payload.status = cleanText(m.status, 12) || 'ended';
      const isOn = online.has(to);
      const pc = pendingCalls.get(to);
      if (kind === 'offer') {
        const old = pendingCalls.get(to); if (old) endPending(to);
        pendingCalls.set(to, { id: payload.callId, from: user, fromName: me.name, type: payload.type, offer: payload.offer, t: Date.now(), cands: [], delivered: isOn });
        if (isOn) { pushUser(to, payload); pushUser(user, { push: 'call', kind: 'ringing', from: to, callId: payload.callId }); }
        const pushed = pushTo(to, { t: 'call', title: me.name, body: payload.type === 'video' ? '📹 Incoming video call' : '📞 Incoming voice call', tag: 'call', callId: payload.callId, from: user }, 45, true);
        return { delivered: isOn, queued: !isOn, push: pushed > 0 };
      }
      if (kind === 'cand') {
        if (pc && pc.from === user && pc.id === payload.callId && !pc.delivered) { if (pc.cands.length < 60) pc.cands.push(payload.candidate); return { delivered: false, queued: true }; }
        pushUser(to, payload); return { delivered: isOn };
      }
      if (kind === 'answer') { const q = pendingCalls.get(user); if (q && q.from === to) pendingCalls.delete(user); pushUser(to, payload); return { delivered: isOn }; }
      // end
      let logged = false;
      const mine = pendingCalls.get(to);
      if (mine && mine.from === user) {
        const r = endPending(to, payload.status === 'missed' || payload.status === 'ended' || payload.status === 'cancel' ? 'missed' : 'x');
        logged = !!(r && r.logged);
        pushTo(to, { t: 'callend', tag: 'call', callId: mine.id }, 30);
      } else { const q = pendingCalls.get(user); if (q && q.from === to) pendingCalls.delete(user); }
      pushUser(to, payload);
      return { delivered: isOn, logged };
    }
    case 'pending': { // callee online hole ashar por queue-te thaka call dey
      const p = pendingCalls.get(user);
      if (!p || Date.now() - p.t > 55000) return null;
      p.delivered = true;
      pushUser(user, { push: 'call', kind: 'offer', from: p.from, fromName: p.fromName, callId: p.id, type: p.type, offer: p.offer });
      for (const c of p.cands) pushUser(user, { push: 'call', kind: 'cand', from: p.from, fromName: p.fromName, callId: p.id, type: p.type, candidate: c });
      pushUser(p.from, { push: 'call', kind: 'ringing', from: user, callId: p.id });
      return true;
    }
    case 'iceServers': return await getIce();
    case 'pushKey': return db.vapid.pub;
    case 'pushSub': {
      const s = m.sub; if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') fail('badreq');
      let host; try { const u = new URL(s.endpoint); if (u.protocol !== 'https:') fail('badreq'); host = u.hostname; } catch { fail('badreq'); }
      if (!PUSH_HOSTS.test(host)) fail('badreq');
      const list = (db.push[user] ||= []).filter(x => x.endpoint !== s.endpoint);
      list.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
      db.push[user] = list.slice(-5); save(); return true;
    }
    case 'pushUnsub': { const e = String(m.endpoint || ''); db.push[user] = (db.push[user] || []).filter(x => x.endpoint !== e); save(); return true; }
    default: sec.strike(ws.ip, 1, 'unknown-op', { op: String(op).slice(0, 40), ua: ws.ua }); fail('badreq');
  }
}

/* ------------------------------------------------------------------ ICE / TURN servers (call-er jonno) */
let iceCache = null;
async function getIce() {
  if (iceCache && Date.now() < iceCache.exp) return iceCache.v;
  let servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  let ttl = 3600e3 * 6;
  try {
    const env = process.env;
    if (env.TURN_URLS) servers.push({ urls: env.TURN_URLS.split(',').map(x => x.trim()), username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json(); servers = servers.concat(j.iceServers || []); } else console.error('Cloudflare TURN error', r.status);
    }
    if (env.METERED_DOMAIN && env.METERED_API_KEY) {
      const r = await fetch(`https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) servers = servers.concat(await r.json()); else console.error('Metered TURN error', r.status);
    }
  } catch (e) { console.error('ice fetch failed:', e.message); ttl = 60e3; }
  let hasTurn = servers.some(sv => [].concat(sv.urls).some(u => /^turns?:/.test(u)));
  if (!hasTurn && process.env.PUBLIC_TURN_FALLBACK !== 'false') {
    // Free shared public TURN (Open Relay). Kono setup lage na, kintu speed/uptime-er guarantee nai. Nijer TURN dile eta bondho hoy.
    servers.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
    hasTurn = true;
  }
  const v = { iceServers: servers, turn: hasTurn };
  iceCache = { v, exp: Date.now() + ttl };
  if (!hasTurn) console.warn('WARNING: TURN server set kora nai. Alada network-er (mobile data / WiFi) duijon-er call-e kotha shona nao jete pare. README-r "Calls" ongsho dekhun.');
  return v;
}

/* ------------------------------------------------------------------ http (static + uploads) */
const MIME = { '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);

const gzMap = new Map();
function gzCached(file) {
  try {
    const st = fs.statSync(file); if (!st.isFile()) return null;
    const c = gzMap.get(file); if (c && c.m === st.mtimeMs) return c.b;
    const b = require('zlib').gzipSync(fs.readFileSync(file), { level: 9 }); gzMap.set(file, { m: st.mtimeMs, b }); return b;
  } catch { return null; }
}
function serveFile(req, res, file, mime, cache, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': cache, ...extra };
    const r = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (r) {
      let s = r[1] ? +r[1] : 0, e = r[2] ? +r[2] : st.size - 1;
      if (!r[1] && r[2]) { s = Math.max(0, st.size - +r[2]); e = st.size - 1; }
      e = Math.min(e, st.size - 1);
      if (s > e || s >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Content-Length': e - s + 1 });
      fs.createReadStream(file, { start: s, end: e }).pipe(res);
    } else {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

const httpRequestLimits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of httpRequestLimits) if (now > v.reset) httpRequestLimits.delete(k); }, 60000).unref();
// CSP: inline script-er hash (unsafe-inline lage na => XSS hole-o hacker-er script chalbe na)
const INDEX_FILE = path.join(PUB, 'index.html');
function scriptHashes() {
  try {
    const html = fs.readFileSync(INDEX_FILE, 'utf8'); const out = [];
    for (const mt of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) out.push("'sha256-" + crypto.createHash('sha256').update(mt[1]).digest('base64') + "'");
    return out;
  } catch { return []; }
}
const CSP_UNSAFE = process.env.CSP_UNSAFE_INLINE === 'true';
const CSP = `default-src 'self'; script-src 'self' ${CSP_UNSAFE ? "'unsafe-inline'" : scriptHashes().join(' ')}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';
sec.onBan = ip => { try { for (const w of wss.clients) if (w.ip === ip) w.terminate(); } catch {} }; // ban hole cholte thaka connection-o kete dei
const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
  const ip = clientIp(req);
  if (sec.isBanned(ip)) { req.socket.destroy(); return; } // banned: kono uttorii dei na (resource bachay)
  const now = Date.now(); let hit = httpRequestLimits.get(ip);
  if (!hit || now > hit.reset) { hit = { count: 0, reset: now + 60000 }; httpRequestLimits.set(ip, hit); }
  if (++hit.count > MAX_HTTP_REQUESTS_PER_MINUTE) { sec.counters.rateLimited++; if (hit.count % 50 === 1) sec.strike(ip, 3, 'http-flood', { ua: req.headers['user-agent'] || '', path: String(req.url).slice(0, 100) }); res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60', 'Cache-Control': 'no-store' }); return res.end('Too many requests'); }
  const host = String(req.headers.host || '').toLowerCase();
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(host.replace(/:\d+$/, ''))) { sec.strike(ip, 2, 'bad-host', { host, ua: req.headers['user-agent'] || '' }); res.writeHead(421); return res.end(); }
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (FORCE_HTTPS && proto === 'http' && !sec.isLoopback(ip)) { res.writeHead(301, { Location: 'https://' + host + req.url }); return res.end(); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (proto === 'https' || FORCE_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', CSP);
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (sec.adminRoute(req, res, ip, p)) return;
  if (sec.honeypot(req, res, ip, String(req.url), p)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') { if (!['OPTIONS', 'POST'].includes(req.method)) sec.strike(ip, 2, 'bad-method', { method: req.method, path: p, ua: req.headers['user-agent'] || '' }); res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); return res.end('Method not allowed'); }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'ok', backup: bk.status ? bk.status() : 'off' })); }
  if (p.startsWith('/uploads/')) {
    const name = path.basename(p);
    if (!/^[a-f0-9]{24}\.[a-z0-9]{1,6}$/.test(name)) { res.writeHead(404); return res.end(); }
    const ext = name.split('.').pop(), mime = MIME_BY_EXT[ext];
    // photo/audio/video inline chole, baki sob file download hishebe jay (kono script chalbe na)
    return serveFile(req, res, path.join(UP_DIR, name), mime || 'application/octet-stream', 'public, max-age=31536000, immutable', mime ? { 'Content-Security-Policy': 'sandbox' } : { 'Content-Disposition': 'attachment', 'Content-Security-Policy': 'sandbox' });
  }
  if (p.startsWith('/stickers/')) {
    const name = path.basename(p);
    if (!/^[a-f0-9]{20}\.(jpg|png|webp|gif)$/.test(name)) { res.writeHead(404); return res.end(); }
    return serveFile(req, res, path.join(STK_DIR, name), MIME['.' + name.split('.').pop()], 'public, max-age=31536000, immutable', { 'Content-Security-Policy': 'sandbox' });
  }
  if (p.startsWith('/avatars/')) {
    const name = path.basename(p);
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(name)) { res.writeHead(404); return res.end(); }
    return serveFile(req, res, path.join(AV_DIR, name), MIME['.' + name.split('.').pop()], 'public, max-age=31536000, immutable', { 'Content-Security-Policy': 'sandbox' });
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  if (/\.(html|js|css|svg|json|webmanifest)$/.test(file) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { // text file gzip: 2000 user-er bandwidth bachay
    const gz = gzCached(file);
    if (gz) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'text/plain', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': NO_CACHE.has(p) ? 'no-cache' : 'public, max-age=3600', 'Content-Length': gz.length }); return req.method === 'HEAD' ? res.end() : res.end(gz); }
  }
  serveFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', NO_CACHE.has(p) ? 'no-cache' : 'public, max-age=3600');
});

/* ------------------------------------------------------------------ websocket */
const ERRORS = ['badid', 'badname', 'weak', 'taken', 'badcreds', 'ratelimit', 'auth', 'notfound', 'forbidden', 'offline', 'badfile', 'toobig', 'empty', 'badreq', 'badcode', 'blocked', 'full', 'bademail', 'badphone', 'expired', 'ownerkey'];
const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024, perMessageDeflate: false, clientTracking: true });
server.on('upgrade', (req, socket, head) => {
  const ip0 = clientIp(req);
  if (sec.isBanned(ip0)) return socket.destroy();
  socket.on('error', () => {});
  const origin = req.headers.origin;
  const host = req.headers.host;
  const sameOrigin = origin && host && (() => { try { const u = new URL(origin); return u.host === host && ['http:', 'https:'].includes(u.protocol); } catch { return false; } })();
  const originAllowed = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.includes(origin) : (sameOrigin || (!origin && ALLOW_NO_ORIGIN));
  if (!originAllowed) { sec.strike(ip0, 2, 'bad-origin', { origin: String(origin || '').slice(0, 100), ua: req.headers['user-agent'] || '' }); socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (!req.url || req.url.split('?')[0] !== '/') { sec.strike(ip0, 3, 'bad-ws-path', { path: String(req.url).slice(0, 100), ua: req.headers['user-agent'] || '' }); socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (!sec.wsOpen(ip0)) { sec.strike(ip0, 2, 'ws-conn-limit', { ua: req.headers['user-agent'] || '' }); socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  socket.once('close', () => sec.wsClose(ip0));
  if (wss.clients.size >= MAX_WS_CONNECTIONS) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => { ws.cntIp = ip0; wss.emit('connection', ws, req); });
});
wss.on('connection', (ws, req) => {
  ws.user = null; ws.alive = true;
  ws.ip = clientIp(req); ws.ua = String(req.headers['user-agent'] || '');
  ws.messageWindow = { start: Date.now(), count: 0 };
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async raw => {
    const now = Date.now();
    if (now - ws.messageWindow.start >= 60000) ws.messageWindow = { start: now, count: 0 };
    if (++ws.messageWindow.count > MAX_WS_MESSAGES_PER_MINUTE) { sec.counters.wsFlood++; sec.strike(ws.ip, 4, 'ws-flood', { ua: ws.ua, user: ws.user || '' }); ws.close(1008, 'Rate limit exceeded'); return; }
    if (!ws.user && raw.length > 20000) { sec.strike(ws.ip, 5, 'big-unauth-frame', { size: raw.length, ua: ws.ua }); ws.terminate(); return; } // login-er aagey boro data pathano jabe na
    let m; try { m = JSON.parse(raw); } catch { sec.strike(ws.ip, 1, 'bad-json', { ua: ws.ua }); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { sec.strike(ws.ip, 1, 'bad-frame', { ua: ws.ua }); return; }
    try {
      const data = await handle(ws, m);
      if (m.id) send(ws, { id: m.id, ok: true, data });
    } catch (e) {
      if (!ERRORS.includes(e.message)) console.error('op error', m.op, e);
      if (m.id) send(ws, { id: m.id, ok: false, error: ERRORS.includes(e.message) ? e.message : 'server' });
    }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch {} }
}, 30000).unref();

if (process.env.STATS_LOG === 'true') { // load-test / monitoring: protita 10s-e server-er obostha print kore
  const { monitorEventLoopDelay } = require('perf_hooks'); const hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable();
  setInterval(() => { if (global.gc) global.gc(); const mu = process.memoryUsage(); console.log('[stats] ' + JSON.stringify({ rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576), ws: wss.clients.size, lagP99ms: Math.round(hist.percentile(99) / 1e6), lagMaxMs: Math.round(hist.max / 1e6), flush: store.stats, pendingDirty: store.dirtyCount() })); hist.reset(); }, 10000).unref();
}
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.maxRequestsPerSocket = 100;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
for (const k of Object.keys(db.users)) { const u = db.users[k]; if (u.email) VERIFIED_IDX.set('email:' + u.email, k); if (u.phone) VERIFIED_IDX.set('phone:' + u.phone, k); }
server.listen(PORT, () => console.log(`Chatgram running → http://localhost:${PORT}   (data: ${DATA_DIR})`));

// Keep-alive: Render free server 15 min kono visitor na pele ghumiye jay (ar tokhon data muche jay).
// Render nijei RENDER_EXTERNAL_URL dey, tai kono setup lage na. Server nijeke 10 min por por dake.
const self = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
if (self && process.env.KEEPALIVE !== 'false') {
  const ping = () => fetch(self.replace(/\/$/, '') + '/health', { headers: { 'user-agent': 'chatgram-keepalive' } }).catch(() => {});
  setTimeout(ping, 30e3).unref(); setInterval(ping, 8 * 60e3).unref();
  console.log('[keepalive] on →', self);
}
