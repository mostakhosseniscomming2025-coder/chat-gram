# Chatgram — Security guide

## Ki ki ache (code-e)
- **DDoS / flood**: per-IP connection limit, rate limit, slow-request timeout, strike→auto-ban (60 min, bar bar korle 7 din porjonto), tarpit.
- **SQL injection**: sob query prepared statement; ID field-e injection pattern dhorle reject + strike.
- **XSS**: sob user text escape; CSP te inline script hash-only (unsafe-inline nai), base-uri/object-src/frame-ancestors lock.
- **File theft**: server.js/store.js/DB/.env URL diye pawa jay na; upload-e magic-byte check, .exe/.html block.
- **Data at rest**: `DATA_KEY` set korle DB AES-256-GCM encrypted.
- **Honeypot (fad)**: /.env /wp-login.php /phpmyadmin /.git /admin ityadi fake page; hacker dhorle IP, User-Agent, kon path try korse — log hoy, auto-ban. Password-e attacker ja type kore tar value save hoy na (mask).
  Report dekhte: `https://<tomar-site>/_sec` (ADMIN_KEY env set korte hobe, min 24 char; page-e key chaibe, key-ta URL-e dite hoy na). Okhane IP lookup link ar unban button ache.
- **Password**: scrypt, weak password refuse, login brute-force limit.

## Code obfuscation/encryption — lagbe?
Na. server.js kokhono browser-e jay na, tai hacker dekhte pay na. Browser-er JS lukano jay na (obfuscate korleo chole) — ar obfuscate korle bug/slow hoy. Asol protection = server-side check + DATA_KEY encryption. Tai ami eta kori ni.

## Live jawar age (tomar kaj)
1. Host-e env set: `DATA_KEY`, `ADMIN_KEY` (kono chat/GitHub-e dio na).
2. Domain Cloudflare (free) e rakho, proxy ON (orange cloud), SSL Full. Eta volumetric DDoS thamay — server nijer theke eta pare na.
3. `FORCE_HTTPS=true`, `ALLOWED_HOSTS=tomar-domain`.
4. Persistent disk/volume `/data`-te lagao, backup nao.
5. RAM kom pokkhe 1 GB (70k user data memory-te thake ~400MB heap).

## Sotti kotha
- "Kono hackei hack korte parbe na" — eta kono software-e guarantee dewa jay na. Eta onek boro risk komay.
- Sandbox-e test: 70k user/200k message data, 4800 socket, 400 msg/s ok. Real host/phone/network-e test hoy ni.
- Signup code ekhon DEMO mode (screen-e dekhay). Real SMS/email-er jonno `VERIFY_WEBHOOK_URL` lagbe. Google/Apple login-er jonno provider key lagbe — nai.
- Media file (photo/video) encrypted noy, shudhu DB encrypted.
- Message 24 ghonta por delete hoy (CHAT_RETENTION_HOURS) — chaile baro.
