'use strict';
/*
 * Chatgram storage layer (scale-er jonno).
 *
 * Agey puro database (users + sessions + contacts + rooms ...) ekta boro JSON hishebe protibar likha hoto.
 * 70,000 user hole oi JSON 50-100MB hoy ar server protibar atke jay. Ekhon:
 *   - protita user / session / contact-list / room ekta alada row (SQLite `kv` table)
 *   - kon row bodleche seta Proxy diye automatic dhora hoy; shudhu seigulo-i save hoy
 *   - message gulo alada `messages` table-e (server.js-e)
 *   - DATA_KEY env dile shob row AES-256-GCM diye encrypt hoye save hoy (file chure gelew pora jabe na)
 *
 * server.js-er baki code-e kono poriborton lage na: `db.users[x].name = ...; save();` ageri moto kaj kore.
 */
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const COLLS = ['users', 'sessions', 'contacts', 'blocks', 'push', 'stickers', 'rooms'];
const FLUSH_MS = Math.max(200, Number(process.env.SAVE_INTERVAL_MS) || 1000);

function open({ file, legacyJsonFile, fs, log = console }) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32000;
    CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (c TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (c, k)) WITHOUT ROWID;`);

  /* ---------------- encryption at rest (optional) ---------------- */
  const getKv = sqlite.prepare('SELECT v FROM kv WHERE c = ? AND k = ?');
  const putKv = sqlite.prepare('INSERT INTO kv (c, k, v) VALUES (?, ?, ?) ON CONFLICT(c, k) DO UPDATE SET v = excluded.v');
  const delKv = sqlite.prepare('DELETE FROM kv WHERE c = ? AND k = ?');
  let KEY = null;
  const passphrase = process.env.DATA_KEY || '';
  if (passphrase) {
    if (passphrase.length < 16) { log.error('[security] DATA_KEY kompokkhe 16 akkhor-er hote hobe. Server bondho holo.'); process.exit(1); }
    let saltRow = getKv.get('sys', 'salt');
    if (!saltRow) { putKv.run('sys', 'salt', crypto.randomBytes(16).toString('hex')); saltRow = getKv.get('sys', 'salt'); }
    KEY = crypto.scryptSync(passphrase, Buffer.from(saltRow.v, 'hex'), 32);
    // key thik ache kina check (vul key diye start korle data nosto na kore bondho hoye jabe)
    const chk = getKv.get('sys', 'check');
    if (!chk) putKv.run('sys', 'check', wrap('chatgram-ok'));
    else { try { if (unwrap(chk.v) !== 'chatgram-ok') throw 0; } catch { log.error('[security] DATA_KEY vul! Ager key-ta din, na hole database porte parbe na. Server bondho holo.'); process.exit(1); } }
    log.log('[security] encryption at rest: ON (AES-256-GCM)');
  } else {
    const chk = getKv.get('sys', 'check');
    if (chk && chk.v.startsWith('E1:')) { log.error('[security] Ei database encrypted, kintu DATA_KEY set kora nai. Server bondho holo.'); process.exit(1); }
    log.warn('[security] WARNING: DATA_KEY set kora nai — database file plain text-e thakbe. Production-e DATA_KEY (16+ akkhor) dewa uchit.');
  }
  // encryption ON hole row-er key (username, room code ...)-o hash kora thake, jate file-e kono naam dekha na jay
  const hm = x => crypto.createHmac('sha256', KEY).update(String(x)).digest('hex');
  const kcol = (c, k) => (KEY ? hm(c + ':' + k) : String(k));
  const mcol = code => (KEY ? hm('m:' + code) : String(code));
  const pack = (k, js) => (KEY ? wrap(JSON.stringify([k, js])) : wrap(js));
  function wrap(str) {
    if (!KEY) return str;
    const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(str, 'utf8'), c.final()]);
    return 'E1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  function unwrap(str) {
    if (typeof str !== 'string' || !str.startsWith('E1:')) return str;
    if (!KEY) throw new Error('encrypted data but no DATA_KEY');
    const b = Buffer.from(str.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }

  /* ---------------- load ---------------- */
  const raw = {}; for (const c of COLLS) raw[c] = Object.create(null);
  const meta = {};
  const migrated = getKv.get('sys', 'migrated');
  const nKv = sqlite.prepare("SELECT COUNT(*) AS n FROM kv WHERE c <> 'sys'").get().n;
  if (!migrated && nKv === 0) {
    // purano format theke (app_state blob ba db.json) ekbar import
    let legacy = null;
    try { const row = sqlite.prepare('SELECT payload FROM app_state WHERE id = 1').get(); if (row && row.payload) legacy = JSON.parse(row.payload); } catch {}
    if (!legacy && legacyJsonFile) { try { legacy = JSON.parse(fs.readFileSync(legacyJsonFile, 'utf8')); } catch {} }
    if (legacy) {
      sqlite.exec('BEGIN');
      for (const c of COLLS) for (const [k, v] of Object.entries(legacy[c] || {})) putKv.run(c, kcol(c, k), pack(k, JSON.stringify(c === 'rooms' ? stripMsgs(v) : v)));
      for (const k of ['v', 'vapid']) if (legacy[k] !== undefined) putKv.run('meta', kcol('meta', k), pack(k, JSON.stringify(legacy[k])));
      sqlite.exec('COMMIT');
      // purano room-er vitore message thakle seguloo return kori (server.js messages table-e tule nibe)
      for (const [code, r] of Object.entries(legacy.rooms || {})) if (r && Array.isArray(r.messages) && r.messages.length) (meta.__legacyMsgs ||= []).push([code, r.messages]);
      log.log('[storage] purano database kv format-e import hoyeche (backup: app_state/db.json rakha ache)');
    }
    putKv.run('sys', 'migrated', '1');
  }
  const t0 = Date.now();
  for (const row of sqlite.prepare("SELECT c, k, v FROM kv WHERE c <> 'sys'").iterate()) {
    let val, key = row.k;
    try {
      const plain = unwrap(row.v);
      if (row.v.startsWith('E1:')) { const pr = JSON.parse(plain); key = pr[0]; val = JSON.parse(pr[1]); } else val = JSON.parse(plain);
    } catch (e) { log.error('[storage] row porte parlam na:', row.c, e.message); continue; }
    if (row.c === 'meta') meta[key] = val; else if (raw[row.c]) raw[row.c][key] = val;
  }
  for (const k of Object.keys(raw.rooms)) { const r = raw.rooms[k]; if (r && typeof r === 'object') r.messages = []; }
  log.log(`[storage] loaded ${Object.keys(raw.users).length} users, ${Object.keys(raw.sessions).length} sessions, ${Object.keys(raw.rooms).length} rooms in ${Date.now() - t0}ms`);

  /* ---------------- change tracking ---------------- */
  const dirty = Object.fromEntries(COLLS.map(c => [c, new Set()]));
  let timer = null, metaCache = {}, flushing = false, purgePlain = false, needScrub = false;
  for (const k of ['v', 'vapid']) if (meta[k] !== undefined) metaCache[k] = JSON.stringify(meta[k]);
  const stats = { flushes: 0, rows: 0, lastMs: 0, maxMs: 0 };
  function mark(c, k) { dirty[c].add(k); schedule(); }
  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS); if (timer.unref) timer.unref(); }
  const rawOf = new WeakMap(), proxyCache = new WeakMap();
  const unproxy = v => (v && typeof v === 'object' && rawOf.get(v)) || v;
  function track(obj, c, k, isRoom) {
    if (obj === null || typeof obj !== 'object') return obj;
    let p = proxyCache.get(obj); if (p) return p;
    p = new Proxy(obj, {
      get(t, key, recv) {
        const v = Reflect.get(t, key, recv);
        if (v === null || typeof v !== 'object') return v;
        if (isRoom && key === 'messages') return v; // message-er array alada table-e, track kora hoy na
        return track(v, c, k, false);
      },
      set(t, key, v, recv) { if (!(isRoom && key === 'messages')) mark(c, k); return Reflect.set(t, key, unproxy(v), recv); },
      deleteProperty(t, key) { if (!(isRoom && key === 'messages')) mark(c, k); return Reflect.deleteProperty(t, key); },
      defineProperty(t, key, d) { if (!(isRoom && key === 'messages')) mark(c, k); return Reflect.defineProperty(t, key, d); }
    });
    proxyCache.set(obj, p); rawOf.set(p, obj); return p;
  }
  function rootProxy(c) {
    const r = raw[c];
    return new Proxy(r, {
      get(t, key, recv) { const v = Reflect.get(t, key, recv); return (v !== null && typeof v === 'object') ? track(v, c, String(key), c === 'rooms') : v; },
      set(t, key, v) { v = unproxy(v); t[key] = v; mark(c, String(key)); return true; },
      deleteProperty(t, key) { delete t[key]; mark(c, String(key)); return true; },
      has(t, key) { return key in t; }
    });
  }
  const db = Object.create(null);
  for (const c of COLLS) db[c] = rootProxy(c);
  db.v = meta.v || 0; db.vapid = meta.vapid || null;

  function ser(c, v) { return JSON.stringify(c === 'rooms' ? stripMsgs(v) : v); }
  function flush() {
    if (flushing) return; flushing = true; const t = Date.now(); let n = 0;
    try {
      sqlite.exec('BEGIN');
      if (purgePlain) sqlite.exec("DELETE FROM kv WHERE c <> 'sys' AND v NOT LIKE 'E1:%'");
      for (const c of COLLS) {
        for (const k of dirty[c]) {
          const v = raw[c][k];
          if (v === undefined) delKv.run(c, kcol(c, k)); else putKv.run(c, kcol(c, k), pack(k, ser(c, v)));
          n++;
        }
      }
      for (const k of ['v', 'vapid']) {
        const js = db[k] === undefined || db[k] === null ? undefined : JSON.stringify(db[k]);
        if (js !== undefined && js !== metaCache[k]) { putKv.run('meta', kcol('meta', k), pack(k, js)); metaCache[k] = js; n++; }
      }
      sqlite.exec('COMMIT');
      for (const c of COLLS) dirty[c].clear();
      purgePlain = false;
    } catch (e) { try { sqlite.exec('ROLLBACK'); } catch {} log.error('save failed (abar chesta hobe):', e.message); schedule(); }
    finally { flushing = false; }
    const ms = Date.now() - t; stats.flushes++; stats.rows += n; stats.lastMs = ms; stats.maxMs = Math.max(stats.maxMs, ms);
  }
  // DATA_KEY pore on kora hole: aager plain row gulo encrypt kore ekshathe likhe (ek transaction-e)
  if (KEY) {
    const plainRows = sqlite.prepare("SELECT COUNT(*) AS n FROM kv WHERE c <> 'sys' AND v NOT LIKE 'E1:%'").get().n;
    if (plainRows) {
      for (const c of COLLS) for (const k of Object.keys(raw[c])) dirty[c].add(k);
      for (const k of ['v', 'vapid']) delete metaCache[k];
      needScrub = true; purgePlain = true; flush(); // delete + notun encrypted row ek-i transaction-e (majhpothe crash hole data harabe na)
      log.log(`[security] ${plainRows} purano plain row encrypt kora holo`);
    }
  }
  // delete-hoya purano plain data file theke shotti-i muche fele (VACUUM puro file notun kore lekhe)
  function scrub() { try { sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sqlite.exec('VACUUM'); sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); log.log('[security] database file scrub kora holo'); } catch (e) { log.error('scrub failed:', e.message); } }
  function save() { schedule(); }
  function saveNow() { if (timer) { clearTimeout(timer); timer = null; } flush(); }

  return { get needScrub() { return needScrub; }, scrub, sqlite, db, raw, wrap, unwrap, kcol, mcol, pack, save, saveNow, stats, legacyMessages: meta.__legacyMsgs || [], encrypted: !!KEY, dirtyCount: () => COLLS.reduce((a, c) => a + dirty[c].size, 0) };
}
function stripMsgs(r) { if (!r || typeof r !== 'object' || !('messages' in r)) return r; const { messages, ...rest } = r; return rest; }

module.exports = { open };
