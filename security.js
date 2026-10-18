'use strict';
/*
 * Chatgram security layer: ban list, strike system, honeypot (fad), attacker log, admin report.
 *
 * Ki kore:
 *  - Hacker/scanner jokhon /wp-login.php, /.env, /admin, /phpmyadmin, /server.js, /data/db.json er moto path-e jay,
 *    amra tader-ke fake page/fake secret dei (honeypot), IP + browser + header sob log kori, ar kichukkhon-er moto ban kori.
 *  - Biyadobi input (SQL injection / XSS / path traversal), brute-force, flood -> strike. Strike beshi hole auto-ban (bar bar hole ban-er somoy bere jay).
 *  - Sob ghotona data/security.log-e thake. ADMIN_KEY set korle /_sec page-e dekha jay (kon IP, ki chesta korse).
 *
 * Sotorko: ekta website-ke "kokhono hack hobe na" bola jay na. Eta onek attack theke bachay ar attacker-er IP/info dhore,
 * kintu volumetric DDoS (laksho request/sec) host-er bahire (Cloudflare) thamate hoy. Details: SECURITY.md.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

function create({ dataDir, log = console }) {
  const LOG_FILE = path.join(dataDir, 'security.log');
  const BANS_FILE = path.join(dataDir, 'security-bans.json');
  const BAN_SCORE = num(process.env.SEC_BAN_SCORE, 10);
  const BAN_BASE_MIN = num(process.env.SEC_BAN_MINUTES, 60);
  const BAN_MAX_MIN = 7 * 24 * 60;
  const MAX_HTTP_CONN_PER_IP = num(process.env.MAX_HTTP_CONN_PER_IP, 60);
  const MAX_WS_PER_IP = num(process.env.MAX_WS_PER_IP, 40);
  const TARPIT_MAX = num(process.env.SEC_TARPIT_MAX, 100);
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const ADMIN_ON = ADMIN_KEY.length >= 24;
  const WEBHOOK = process.env.SECURITY_WEBHOOK_URL || '';
  const ALLOW = new Set((process.env.SECURITY_ALLOW_IPS || '').split(',').map(x => x.trim()).filter(Boolean));
  const BAN_LOOPBACK = process.env.SEC_BAN_LOOPBACK === 'true';
  if (ADMIN_KEY && !ADMIN_ON) log.warn('[security] ADMIN_KEY kom (24+ akkhor lagbe) — /_sec page bondho thakbe.');

  const counters = { honeypot: 0, injection: 0, bans: 0, blockedConn: 0, rateLimited: 0, wsFlood: 0, loginAbuse: 0, adminFail: 0, traversal: 0, badClient: 0 };
  const ring = []; // sesh 500 ghotona
  const ipStats = new Map();
  const bans = new Map(); // ip -> {until, reason, offenses, since}
  const strikes = new Map(); // ip -> {score, last}
  const httpConn = new Map(), wsConn = new Map();
  let tarpits = 0;

  const isLoopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
  const exempt = ip => ALLOW.has(ip) || (!BAN_LOOPBACK && isLoopback(ip));
  const clean = (s, n = 300) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

  /* ---------- persistent bans ---------- */
  try {
    const saved = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    const now = Date.now();
    for (const [ip, b] of Object.entries(saved)) if (b && (b.until > now || b.offenses)) bans.set(ip, b);
  } catch { /* new */ }
  let banTimer = null;
  function saveBans() {
    if (banTimer) return;
    banTimer = setTimeout(() => {
      banTimer = null;
      const o = {}; for (const [ip, b] of bans) o[ip] = b;
      const tmp = BANS_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(o), { mode: 0o600 }, e => { if (!e) fs.rename(tmp, BANS_FILE, () => {}); });
    }, 1500);
    if (banTimer.unref) banTimer.unref();
  }

  /* ---------- log file (rotate hoy) ---------- */
  let logWrites = 0;
  function appendLog(rec) {
    fs.appendFile(LOG_FILE, JSON.stringify(rec) + '\n', { mode: 0o600 }, () => {});
    if (++logWrites % 200 === 0) fs.stat(LOG_FILE, (e, st) => {
      if (e || st.size < 5 * 1024 * 1024) return;
      fs.rename(LOG_FILE + '.2', LOG_FILE + '.3', () => fs.rename(LOG_FILE + '.1', LOG_FILE + '.2', () => fs.rename(LOG_FILE, LOG_FILE + '.1', () => {})));
    });
  }
  try { // restart-er por report-e agey-r ghotona dekhate
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-500);
    for (const l of lines) { try { ring.push(JSON.parse(l)); } catch {} }
  } catch {}

  /* ---------- webhook alert (optional) ---------- */
  const alertQ = [];
  let alertTimer = null;
  function alert(text) {
    if (!WEBHOOK) return;
    alertQ.push(text); if (alertQ.length > 20) alertQ.shift();
    if (alertTimer) return;
    alertTimer = setTimeout(async () => {
      alertTimer = null; const msg = alertQ.splice(0).join('\n').slice(0, 1800);
      try { await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: msg, text: msg }), signal: AbortSignal.timeout(5000) }); } catch {}
    }, 20000);
    if (alertTimer.unref) alertTimer.unref();
  }

  /* ---------- event ---------- */
  function event(type, ip, info = {}) {
    const rec = { ts: new Date().toISOString(), type, ip: clean(ip, 60) };
    for (const [k, v] of Object.entries(info)) rec[k] = typeof v === 'string' ? clean(v) : v;
    ring.push(rec); if (ring.length > 500) ring.shift();
    appendLog(rec);
    let st = ipStats.get(ip);
    if (!st) { st = { count: 0, first: rec.ts, last: rec.ts, types: {}, ua: '', paths: [] }; ipStats.set(ip, st); if (ipStats.size > 5000) ipStats.delete(ipStats.keys().next().value); }
    st.count++; st.last = rec.ts; st.types[type] = (st.types[type] || 0) + 1;
    if (info.ua) st.ua = clean(info.ua, 160);
    if (info.path && st.paths.length < 10 && !st.paths.includes(info.path)) st.paths.push(clean(info.path, 120));
    return rec;
  }

  /* ---------- ban / strike ---------- */
  function isBanned(ip) {
    if (exempt(ip)) return false;
    const b = bans.get(ip); if (!b) return false;
    if (b.until > Date.now()) return true;
    return false; // expired (offenses count rakha hoy, notun ban-er somoy barate)
  }
  function ban(ip, reason, minutes) {
    if (exempt(ip)) return;
    const prev = bans.get(ip); const offenses = (prev && prev.offenses || 0) + 1;
    const min = Math.min(BAN_MAX_MIN, minutes || BAN_BASE_MIN * Math.pow(4, offenses - 1));
    bans.set(ip, { until: Date.now() + min * 60000, reason: clean(reason, 100), offenses, since: new Date().toISOString() });
    counters.bans++; saveBans(); strikes.delete(ip);
    try { api.onBan && api.onBan(ip); } catch {}
    event('ban', ip, { reason, minutes: Math.round(min), offenses });
    alert(`🚫 Chatgram: IP ${ip} ban hoyeche (${reason}) — ${Math.round(min)} min, offense #${offenses}`);
  }
  function strike(ip, pts, type, info = {}) {
    event(type, ip, info);
    if (exempt(ip)) return false;
    const now = Date.now(); let s = strikes.get(ip);
    if (!s || now - s.last > 15 * 60000) s = { score: 0, last: now };
    s.score += pts; s.last = now; strikes.set(ip, s);
    if (s.score >= BAN_SCORE) { ban(ip, type + (info.path ? ' ' + info.path : '')); return true; }
    return false;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, s] of strikes) if (now - s.last > 15 * 60000) strikes.delete(ip);
    for (const [ip, b] of bans) if (b.until < now - 30 * 24 * 3600e3) bans.delete(ip);
  }, 60000).unref();

  /* ---------- connection caps ---------- */
  function connOpen(map, ip, max) { const n = (map.get(ip) || 0) + 1; map.set(ip, n); return n <= max || exempt(ip); }
  function connClose(map, ip) { const n = (map.get(ip) || 1) - 1; if (n <= 0) map.delete(ip); else map.set(ip, n); }
  const httpOpen = ip => { const ok = connOpen(httpConn, ip, MAX_HTTP_CONN_PER_IP); if (!ok) counters.blockedConn++; return ok; };
  const httpClose = ip => connClose(httpConn, ip);
  const wsOpen = ip => { const ok = connOpen(wsConn, ip, MAX_WS_PER_IP); if (!ok) { counters.blockedConn++; connClose(wsConn, ip); } return ok; };
  const wsClose = ip => connClose(wsConn, ip);

  /* ---------- honeypot ---------- */
  const HP = [
    [/^\/(\.env|\.env\.[a-z0-9_-]+|env\.js|config\.(json|js|yml|yaml|php|bak)|\.aws\/|\.ssh\/|id_rsa|credentials|secrets?\.(json|ya?ml))/i, 'env'],
    [/^\/\.(git|svn|hg|bzr|ds_store|htaccess|htpasswd|npmrc|docker|vscode|idea)/i, 'vcs'],
    [/(^|\/)(wp-(admin|login|content|includes|json|config)|xmlrpc\.php|wordpress|wlwmanifest)/i, 'wordpress'],
    [/(phpmyadmin|pma\/|adminer|myadmin|phpinfo|\.php\d?$|eval-stdin|vendor\/(phpunit|composer))/i, 'php'],
    [/(\.(asp|aspx|jsp|jspx|cgi|pl|cfm|action|do)$|cgi-bin|boaform|actuator|server-status|server-info|manager\/html|jmx-console|solr\/|jenkins|\/owa\/|autodiscover|\/ecp\/|remote\/login|\/api\/(v\d\/)?(admin|users?|config|debug|internal|keys?)\b|\/debug\b|\/console\b|\/telescope|\/\.well-known\/security\.txt\.php)/i, 'scanner'],
    [/^\/(adm|admi|admin|admin[0-9]|administrator|adminpanel|admin-panel|admincp|panel|cpanel|dashboard|login|signin|manage|backend|private|secret|root|sysadmin|webadmin)(\/|$|\.)/i, 'admin'],
    [/(server\.js|store\.js|security\.js|package(-lock)?\.json|dockerfile|railway\.json|\.sqlite|\.db$|db\.json|^\/data(\/|$)|\.sql$|\.bak$|\.old$|\.orig$|\.zip$|\.tar(\.gz)?$|\.rar$|\.7z$|backup|dump|security\.log|security-bans)/i, 'files'],
    [/\/etc\/passwd|\/proc\/self|\.\.[/\\]|%2e%2e|%252e|%00|\\x00/i, 'traversal']
  ];
  const kindOf = (rawUrl, p) => { for (const [re, k] of HP) if (re.test(p) || re.test(rawUrl)) return k; return null; };
  const rnd = n => crypto.randomBytes(n).toString('hex');
  const fakeEnv = () => `APP_ENV=production\nDEBUG=false\nDB_HOST=10.0.3.17\nDB_PORT=3306\nDB_NAME=chatgram\nDB_USER=cg_admin\nDB_PASSWORD=Cg!${rnd(5)}\nJWT_SECRET=${rnd(24)}\nADMIN_TOKEN=${rnd(16)}\nAWS_ACCESS_KEY_ID=AKIA${rnd(8).toUpperCase()}\nAWS_SECRET_ACCESS_KEY=${rnd(20)}\n`;
  const fakeLogin = pth => `<!doctype html><html><head><meta charset="utf-8"><title>Administrator Login</title><style>body{font-family:sans-serif;background:#f1f1f1;display:flex;justify-content:center;padding-top:80px}form{background:#fff;padding:24px;border-radius:6px;box-shadow:0 1px 4px #0003;width:280px}input{width:100%;padding:8px;margin:6px 0 12px;box-sizing:border-box}button{padding:8px 16px}</style></head><body><form method="post" action="${clean(pth, 80).replace(/[<>"'&]/g, '')}"><h3>Administrator Login</h3><label>Username</label><input name="username" autocomplete="off"><label>Password</label><input type="password" name="password"><button>Log In</button></form></body></html>`;
  function readBody(req, max, cb) {
    let n = 0; const chunks = []; let done = false;
    const fin = () => { if (!done) { done = true; cb(Buffer.concat(chunks).toString('utf8')); } };
    req.on('data', c => { n += c.length; if (n <= max) chunks.push(c); else { req.destroy(); fin(); } });
    req.on('end', fin); req.on('error', fin); setTimeout(fin, 3000).unref();
  }
  function maskBody(b) {
    // attacker jei password likhse seta rakhbo na (bhul kore asol user hole), shudhu username + length
    return clean(String(b).replace(/(pass(word)?|pwd|pw|secret|token|key)=([^&]*)/gi, (m, k, _g, v) => `${k}=<${v.length} chars>`), 200);
  }
  // true return korle request handle hoye geche (caller aar kichu korbe na)
  function honeypot(req, res, ip, rawUrl, p) {
    const kind = kindOf(rawUrl, p); if (!kind) return false;
    counters.honeypot++; if (kind === 'traversal') counters.traversal++;
    const info = { kind, method: req.method, path: p, ua: req.headers['user-agent'] || '', ref: req.headers.referer || '', lang: req.headers['accept-language'] || '', xff: req.headers['x-forwarded-for'] || '', host: req.headers.host || '' };
    const respond = body => {
      const delay = tarpits < TARPIT_MAX ? 1500 + Math.floor(Math.random() * 4500) : 0;
      if (delay) tarpits++;
      const send = () => { if (delay) tarpits--; if (res.writableEnded || res.destroyed) return; try { body(); } catch {} };
      delay ? setTimeout(send, delay).unref() : send();
    };
    const heavy = kind === 'traversal' || kind === 'files' || kind === 'env' ? 6 : 5;
    const go = bodyText => {
      if (bodyText) info.body = maskBody(bodyText);
      strike(ip, heavy, 'honeypot', info);
      if (kind === 'env') return respond(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(fakeEnv()); });
      if (kind === 'vcs') return respond(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote "origin"]\n\turl = git@github.com:internal/chatgram-private.git\n'); });
      if (kind === 'admin' || kind === 'wordpress' || kind === 'php') return respond(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fakeLogin(p)); });
      return respond(() => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>'); });
    };
    if (req.method === 'POST' || req.method === 'PUT') readBody(req, 2048, go); else go('');
    return true;
  }

  /* ---------- input checks ---------- */
  const INJ = /(\bunion\b[\s\S]{0,24}\bselect\b|\bselect\b[\s\S]{0,40}\bfrom\b|\bdrop\s+(table|database)\b|\binsert\s+into\b|\bdelete\s+from\b|\bsleep\s*\(|\bbenchmark\s*\(|\bwaitfor\s+delay\b|\bor\s+['"]?\d+['"]?\s*=\s*['"]?\d+|\band\s+['"]?\d+['"]?\s*=\s*['"]?\d+|['"`;]\s*(--|#|\/\*)|<\s*\/?\s*(script|iframe|img|svg|object|embed)|javascript:|\bon[a-z]+\s*=|\.\.[/\\]|%00|\x00|\$\{|\{\{|\bexec\s*\(|\/etc\/passwd|__proto__|\bprototype\b|\bconstructor\b)/i;
  const looksMalicious = v => typeof v === 'string' && v.length < 600 && INJ.test(v);

  /* ---------- admin report ---------- */
  const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
  function report() {
    const top = (arr, n = 15) => arr.sort((a, b) => b[1] - a[1]).slice(0, n);
    const ips = top([...ipStats].map(([ip, s]) => [ip, s.count]));
    const pathCount = new Map(), uaCount = new Map();
    for (const r of ring) { if (r.path) pathCount.set(r.path, (pathCount.get(r.path) || 0) + 1); if (r.ua) uaCount.set(r.ua, (uaCount.get(r.ua) || 0) + 1); }
    const now = Date.now();
    return {
      now: new Date().toISOString(), counters,
      activeBans: [...bans].filter(([, b]) => b.until > now).map(([ip, b]) => ({ ip, ...b, left_min: Math.ceil((b.until - now) / 60000) })),
      topIps: ips.map(([ip, c]) => ({ ip, count: c, ...ipStats.get(ip) })),
      topPaths: top([...pathCount]), topAgents: top([...uaCount], 8),
      recent: ring.slice(-300).reverse()
    };
  }
  const ADMIN_HTML = (() => {
    const script = `
const $=id=>document.getElementById(id);let key=sessionStorage.getItem('k')||'';
const el=(t,txt,c)=>{const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(c)e.className=c;return e};
const ipOk=ip=>/^[0-9a-fA-F:.]{3,45}$/.test(ip);
function ipCell(ip){const td=el('td');td.append(el('span',ip+' '));if(ipOk(ip)){const a=el('a','whois');a.href='https://ipinfo.io/'+encodeURIComponent(ip);a.target='_blank';a.rel='noopener noreferrer';td.append(a);td.append(document.createTextNode(' '));const b=el('a','abuse');b.href='https://www.abuseipdb.com/check/'+encodeURIComponent(ip);b.target='_blank';b.rel='noopener noreferrer';td.append(b);}return td}
function table(h,rows){const t=el('table');const tr=el('tr');h.forEach(x=>tr.append(el('th',x)));t.append(tr);rows.forEach(r=>t.append(r));return t}
async function api(p,o){const r=await fetch(p,Object.assign({headers:{'x-admin-key':key}},o));if(r.status===401){sessionStorage.removeItem('k');throw new Error('Vul key')}if(!r.ok)throw new Error('Error '+r.status);return r.json()}
async function load(){const out=$('out');out.textContent='';try{const d=await api('/_sec/api/report');
const c=el('div',null,'cards');Object.entries(d.counters).forEach(([k,v])=>{const x=el('div',null,'card');x.append(el('b',String(v)),el('span',k));c.append(x)});out.append(c);
out.append(el('h2','Active bans ('+d.activeBans.length+')'));
out.append(table(['IP','Reason','Left (min)','Offense',''],d.activeBans.map(b=>{const tr=el('tr');tr.append(ipCell(b.ip),el('td',b.reason),el('td',String(b.left_min)),el('td',String(b.offenses)));const td=el('td');const u=el('button','Unban');u.onclick=async()=>{await api('/_sec/api/unban',{method:'POST',headers:{'x-admin-key':key,'content-type':'application/json'},body:JSON.stringify({ip:b.ip})});load()};td.append(u);tr.append(td);return tr})));
out.append(el('h2','Top attacker IPs'));
out.append(table(['IP','Events','Last','User-Agent','Paths'],d.topIps.map(s=>{const tr=el('tr');tr.append(ipCell(s.ip),el('td',String(s.count)),el('td',s.last||''),el('td',s.ua||''),el('td',(s.paths||[]).join('  ')));return tr})));
out.append(el('h2','Top paths'));out.append(table(['Path','Hits'],d.topPaths.map(p=>{const tr=el('tr');tr.append(el('td',p[0]),el('td',String(p[1])));return tr})));
out.append(el('h2','Recent events'));
out.append(table(['Time','Type','IP','Details'],d.recent.map(r=>{const tr=el('tr');tr.append(el('td',(r.ts||'').replace('T',' ').slice(0,19)),el('td',r.type),ipCell(r.ip));const {ts,type,ip,...rest}=r;tr.append(el('td',JSON.stringify(rest)));return tr})));
}catch(e){out.append(el('p',e.message,'err'))}}
$('go').onclick=()=>{key=$('key').value.trim();sessionStorage.setItem('k',key);load()};
if(key){load()}`;
    const hash = crypto.createHash('sha256').update(script).digest('base64');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Security</title><style>body{font-family:system-ui,sans-serif;background:#0e1621;color:#e6edf3;margin:0;padding:12px}h1{font-size:18px}h2{font-size:15px;margin:18px 0 6px;color:#8cc8ff}input{padding:8px;border-radius:8px;border:1px solid #334;background:#17212b;color:#fff;width:60%}button{padding:8px 14px;border-radius:8px;border:0;background:#2aabee;color:#fff;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:12px;display:block;overflow-x:auto}th,td{border-bottom:1px solid #243;padding:5px 7px;text-align:left;vertical-align:top;word-break:break-all}th{color:#8aa}a{color:#6cf}.cards{display:flex;flex-wrap:wrap;gap:8px}.card{background:#17212b;border-radius:10px;padding:8px 12px;min-width:90px}.card b{display:block;font-size:20px}.card span{font-size:11px;color:#8aa}.err{color:#f66}</style></head><body><h1>🛡 Chatgram Security</h1><p><input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="off"> <button id="go">Open</button></p><div id="out"></div><script>${script}</script></body></html>`;
    return { html, csp: `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` };
  })();
  // true = handled
  function adminRoute(req, res, ip, p) {
    if (!p.startsWith('/_sec')) return false;
    const sec = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': ADMIN_HTML.csp };
    if (!ADMIN_ON) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return true; }
    if (p === '/_sec' || p === '/_sec/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...sec }); res.end(ADMIN_HTML.html); return true; }
    const keyOk = safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY);
    if (!keyOk) { counters.adminFail++; strike(ip, 5, 'admin-key-fail', { path: p, ua: req.headers['user-agent'] || '' }); res.writeHead(401, { 'Content-Type': 'application/json', ...sec }); res.end('{"error":"auth"}'); return true; }
    if (p === '/_sec/api/report' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json', ...sec }); res.end(JSON.stringify(report())); return true; }
    if (p === '/_sec/api/unban' && req.method === 'POST') {
      readBody(req, 512, b => {
        let target = ''; try { target = String(JSON.parse(b).ip || ''); } catch {}
        const had = bans.delete(target); strikes.delete(target); saveBans(); event('unban', ip, { target });
        res.writeHead(200, { 'Content-Type': 'application/json', ...sec }); res.end(JSON.stringify({ ok: had }));
      });
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'application/json', ...sec }); res.end('{}'); return true;
  }

  const api = { onBan: null, isBanned, ban, strike, event, honeypot, adminRoute, httpOpen, httpClose, wsOpen, wsClose, looksMalicious, counters, report, exempt, adminOn: ADMIN_ON, isLoopback };
  return api;
}

module.exports = { create };
