# ChatGram v3.2 — embedded SQLite + 24-hour chat retention

ChatGram uses Node.js WebSockets and a local embedded SQLite database. It does not require PostgreSQL, Firebase, or a separately hosted database service. SQLite is stored inside the configured data directory as `chatgram.sqlite` (with WAL sidecar files while running).

## Run

Requires Node.js **22.13 or newer** (uses Node's built-in `node:sqlite`).

```sh
npm install
npm start
```

Open `http://localhost:3000`.

## Storage and migration

- `DATA_DIR` selects the persistent storage directory (default: `./data`).
- The SQLite database is stored at `DATA_DIR/chatgram.sqlite`; uploaded media stays at `DATA_DIR/uploads/`.
- On the first launch, if `data/db.json` exists and no SQLite state exists yet, ChatGram imports that JSON data into SQLite automatically. The old JSON file is preserved as a backup and is not deleted.
- On Docker/Railway, mount persistent storage at `/data` and set `DATA_DIR=/data`. Without a persistent volume, data may be lost when the host replaces the container/filesystem.
- Back up the entire data directory, including `chatgram.sqlite`, any SQLite `-wal`/`-shm` files while the app is running, and `uploads/`. Prefer stopping the app or using SQLite's online backup tooling for consistent backups.

## 24-hour chat expiration

At startup and every 15 minutes, the server removes messages that are at least 24 hours old based on each message's creation timestamp. It also removes associated uploaded media only when no retained message still references that media. This covers text, voice, video, images, files, and message-linked metadata stored in the message record.

The cleanup does **not** delete user accounts, password hashes, sessions, profiles, contacts, blocks, push settings, room definitions, or room membership. Records with missing/invalid timestamps are kept to avoid accidental data loss. Users do not need to be online for cleanup to run.

## Capacity and limits

SQLite provides an embedded transactional database without a separate database server. However, this version preserves the app's existing in-memory data model and writes a serialized state snapshot to SQLite; this is a safer local persistence step, **not** a complete normalized high-scale database redesign. It does not prove support for 2,000 concurrent users or 100,000 messages/day. Those targets require load testing and likely a refactor to indexed per-entity tables, efficient paginated queries, and possibly shared pub/sub/storage if running multiple instances. Do not run multiple server instances against this single-process state model and assume they synchronize.

## Voice/video calls

Microphone/camera access requires HTTPS outside localhost. WebRTC may require a properly configured TURN relay for users behind restrictive NATs/firewalls. Use real provider credentials and do not expose permanent TURN secrets in frontend code. The ZIP does not claim live two-device call verification unless separately tested.


## v3.2 notes
- Messages live in a SQLite `messages` table (fast for ~100k msgs/day); accounts/contacts stay in the snapshot. Avatars are files, not base64.
- Load test here (1 CPU sandbox): 2000 users, 100,000 messages in ~14s, ~230MB RAM, 24h purge of 100k messages OK. Real-world speed depends on your host; run ONE instance only.
- Free hosts with no persistent disk lose accounts on restart: attach a volume at DATA_DIR.
- Calls: STUN alone fails on many mobile networks ("connecting" but no sound). Set one TURN option in `.env.example` (Metered free tier is easiest).
- Tailwind/FontAwesome are self-hosted (`public/app.css`); after editing classes in index.html run `node tools/build-css.mjs` (needs tailwindcss v4).
- Push notifications need HTTPS (iPhone: add to Home Screen first).

## Group voice/video chat (rooms)
Room-er header-e 🎧 button. Voice, camera, screen share (PC browser-e; phone browser-e screen share nai). Max 8 jon (`GROUP_CALL_MAX`). Mesh WebRTC: prottek jon sobar sathe sorasori connect hoy, tai TURN lagbe (see Calls) ar beshi manush hole phone/net slow hobe.

## Menu features (v3.2)
Channels (shudhu owner post kore), Groups, Contacts, Recent Calls (24h), Devices (session list + terminate), Chat Folders (device-e save), multi-account switcher (device-e save). Telegram-er QR/phone number nai.

## Emoji / Stickers / GIFs
Emoji: category + search + recent. Stickers: boro emoji-sticker (alada message). GIF: device theke GIF pathano (online GIF search nai, karon external service/key lage).

## Chat wallpapers
`public/wallpapers.css` (nijer-er toiri vector art, copyright-free) + Gallery theke nijer chhobi. Settings > Chat wallpaper.

## Custom Stickers + Sticker Bot (v3.3)
- Chat list-e **Sticker Bot** ache. Ekta chhobi (PNG/WebP/JPG/GIF) pathan, tarpor ekta emoji (jemon 😂) — sticker add hoye jabe.
- Je-i chat-e keu oi emoji likhbe (shudhu emoji, onno text chhara), oi sticker suggest hobe; tap korle pathiye dey.
- Emoji panel → Stickers → ⭐ tab-e shob custom sticker. Drawer → **My Stickers** theke delete kora jay.
- Files `DATA_DIR/stickers`-e thake (24h purge-e pore na). Env: `STICKER_MAX_PER_USER`, `STICKER_UPLOAD_ADMINS_ONLY`, `STICKER_ADMINS`.
- Dhorun by default je kew upload korte pare — public site hole `STICKER_UPLOAD_ADMINS_ONLY=true` dewa bhalo.

## App Lock (v3.4)
- Drawer → **App Lock**: 4-digit PIN, optional biometric (fingerprint/face via device passkey), auto-lock (Immediately / 1 min / 5 min / 1 hour), "Lock now".
- App background-e gele (timeout onujayi) abar kholle lock screen ashe. 5 bar vul PIN dile kichukkhon wait korte hoy.
- PIN bhule gele "Forgot PIN? Log out" — logout hole lock muche jay.
- Lock shudhu ei device/browser-e (localStorage-e salted PBKDF2 hash). Eta screen-gate; server-side security na.

## Chatgram AI redesign (v3.5)
- Notun welcome screen ("Best Personal AI Assistant", robot mascot, **Start a new chat**), dark/lime chat skin, suggestion chips, header-e New chat button.
- Ekhono fake/local reply — kono real API nai.

## Personal Chat Layout (v3.6)
- Drawer → **Chat Layout**: bubble shape (Rounded/Pill/Tail/Leaf/Sharp), font size (12–22px), message spacing, toolbar position (Bottom/Top/Floating), live preview, Reset.
- Setting per-user, ei device-er localStorage-e save hoy (onno user/device-e jay na).

## Privacy (v3.7)
- Drawer → **Privacy**: Last Seen & Online / Profile Photos / Bio / Birthday — Everybody / My Contacts / Nobody.
- **Specific people**: kono ekjon-er jonno alada "What can they see?" toggle (chat-er info theke-o kholа jay). Server-e enforce kora (client-e lukano na).
- Edit Profile-e optional **Birthday** field.

## v4.0 — Scale + Security + notun Login/Signup
- 70k user / 200k+ msg/din: SQLite storage, lazy message load, batched flush.
- Security: SECURITY.md dekho. Honeypot + auto-ban + admin report.
- Notun onboarding: Welcome → Sign Up options → Phone/Email → 5-digit code → Profile → Account Created. Purono "Log In" ager moto kaj kore.

## v4.1 — Free host-e data haray na (GitHub backup)
Render free-te disk permanent na. Tai server 3 minute por por + bondho howar somoy database GitHub-er private repo-te backup rakhe, ar notun start-e (disk khali hole) ferot ane. Setup: `.env.example` er sheshe dekho. Start command: `node boot.js` (npm start).
Shima: shudhu database backup hoy (account, message). Upload kora photo/file/sticker file restart-e jete pare. Sudden crash-e shesh ~3 minute-er data harate pare.
