/* GitHub backup: Render/Koyeb-er moto free host-e disk muche gele data ferot ane.
   Env: GITHUB_TOKEN (repo contents read/write), GITHUB_REPO=owner/repo (PRIVATE repo!), GITHUB_BACKUP_PATH, GITHUB_BRANCH, BACKUP_MINUTES */
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const TOKEN = process.env.GITHUB_TOKEN, REPO = process.env.GITHUB_REPO;
const FILE_PATH = process.env.GITHUB_BACKUP_PATH || 'chatgram-backup.sqlite.gz';
const BRANCH = process.env.GITHUB_BACKUP_BRANCH || '';
const enabled = !!(TOKEN && /^[\w.-]+\/[\w.-]+$/.test(REPO || ''));
const url = () => `${process.env.GITHUB_API || 'https://api.github.com'}/repos/${REPO}/contents/${FILE_PATH.split('/').map(encodeURIComponent).join('/')}`;
const hdr = extra => ({ authorization: 'Bearer ' + TOKEN, 'user-agent': 'chatgram-backup', 'x-github-api-version': '2022-11-28', ...extra });
const q = () => (BRANCH ? '?ref=' + encodeURIComponent(BRANCH) : '');
let remoteShaLog = null, lastLogHash = '', remoteSha = null, lastHash = '', st = { on: enabled, lastOk: null, lastError: null, restored: false };

async function getMeta() {
  const r = await fetch(url() + q(), { headers: hdr({ accept: 'application/vnd.github+json' }) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('github ' + r.status);
  return (await r.json()).sha;
}
async function restore(dbFile, log = console) {
  if (!enabled) return false;
  if (fs.existsSync(dbFile)) return false;
  try {
    const r = await fetch(url() + q(), { headers: hdr({ accept: 'application/vnd.github.raw+json' }) });
    if (r.status === 404) { log.log('[backup] GitHub-e kono backup nai (prothom bar)'); return false; }
    if (!r.ok) throw new Error('github ' + r.status);
    const raw = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
    if (raw.slice(0, 15).toString() !== 'SQLite format 3') throw new Error('backup file valid noy');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, raw);
    try { const lr = await fetch(url().replace(/[^/]+$/, 'chatgram-security.log') + q(), { headers: hdr({ accept: 'application/vnd.github.raw+json' }) }); if (lr.ok) fs.writeFileSync(path.join(path.dirname(dbFile), 'security.log'), Buffer.from(await lr.arrayBuffer()), { mode: 0o600 }); } catch {}
    st.restored = true; log.log('[backup] GitHub theke data ferot ana holo (' + raw.length + ' bytes)');
    return true;
  } catch (e) { st.lastError = 'restore: ' + e.message; log.error('[backup] restore fail:', e.message); return false; }
}
function start({ sqlite, saveNow, dir, log = console }) {
  if (!enabled) { log.log('[backup] GitHub backup bondho (GITHUB_TOKEN/GITHUB_REPO nai) — free host-e restart-e data muche jete pare'); return { status: () => st, final: async () => {}, status: () => st }; }
  let busy = false;
  async function run() {
    if (busy) return; busy = true;
    const tmp = path.join(dir, 'snap-' + process.pid + '.sqlite');
    try {
      saveNow(); try { fs.rmSync(tmp, { force: true }); } catch {}
      sqlite.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
      const h = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (h === lastHash) return;
      if (gz.length > 90e6) { log.error('[backup] file onek boro (>90MB), skip'); return; }
      for (let i = 0; i < 2; i++) {
        if (remoteSha === null) remoteSha = await getMeta();
        const body = { message: 'backup ' + new Date().toISOString(), content: gz.toString('base64') };
        if (remoteSha) body.sha = remoteSha; if (BRANCH) body.branch = BRANCH;
        const r = await fetch(url(), { method: 'PUT', headers: hdr({ accept: 'application/vnd.github+json', 'content-type': 'application/json' }), body: JSON.stringify(body) });
        if (r.ok) { remoteSha = (await r.json()).content.sha; lastHash = h; st.lastOk = new Date().toISOString(); st.lastError = null; log.log('[backup] GitHub-e save holo (' + gz.length + ' bytes)'); return; }
        if (r.status === 409 || r.status === 422) { remoteSha = null; continue; }
        throw new Error('github ' + r.status);
      }
    } catch (e) { st.lastError = e.message; log.error('[backup] fail:', e.message); }
    finally { try { fs.rmSync(tmp, { force: true }); } catch {} busy = false; }
  }
  async function runLog() {
    try {
      const lf = path.join(dir, 'security.log'); if (!fs.existsSync(lf)) return;
      const txt = fs.readFileSync(lf); const h = crypto.createHash('sha256').update(txt).digest('hex'); if (h === lastLogHash || txt.length > 20e6) return;
      const u = url().replace(/[^/]+$/, 'chatgram-security.log');
      if (remoteShaLog === null) { const r = await fetch(u + q(), { headers: hdr({ accept: 'application/vnd.github+json' }) }); remoteShaLog = r.ok ? (await r.json()).sha : ''; }
      const body = { message: 'security log', content: txt.toString('base64') }; if (remoteShaLog) body.sha = remoteShaLog; if (BRANCH) body.branch = BRANCH;
      const r = await fetch(u, { method: 'PUT', headers: hdr({ accept: 'application/vnd.github+json', 'content-type': 'application/json' }), body: JSON.stringify(body) });
      if (r.ok) { remoteShaLog = (await r.json()).content.sha; lastLogHash = h; } else if (r.status === 409 || r.status === 422) remoteShaLog = null;
    } catch {}
  }
  const runAll = async () => { await run(); await runLog(); };
  const mins = Math.max(1, Number(process.env.BACKUP_MINUTES) || 3);
  setTimeout(runAll, 20e3).unref();
  setInterval(runAll, mins * 60e3).unref();
  return { status: () => st, final: async () => { for (let i = 0; i < 40 && busy; i++) await new Promise(r => setTimeout(r, 250)); await Promise.race([runAll(), new Promise(r => setTimeout(r, 15e3))]); }, now: runAll };
}
module.exports = { enabled, restore, start, getStatus: () => st };
