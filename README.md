# Nearby backend

Node 20+ · Express · SQLite (better-sqlite3) · face-api (TensorFlow.js WASM, runs on your own server).

    cd backend && npm install && cp .env.example .env     # set JWT_SECRET, PUBLIC_URL, SMTP_URL
    npm start                                             # http://0.0.0.0:4000
    npm test                                              # 18 tests (+2 that use the real face model when FACE_FIXTURES is set)

In the app folder set `EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000` (or your https URL) and run `npx expo start -c`.
With that variable set, all demo people, demo chat and demo codes are gone.

## What it does
- **Auth**: email + password (bcrypt), 6-digit email codes for verify / reset / change email, JWT sessions (changing password signs out other devices).
- **Face scan** (`POST /face/start`, `POST /face/verify`): the server picks a random order of left/right/up/down. The app sends one photo per step. The server checks
  one face per photo, same person in every photo, head really turned each way, then estimates **gender and age**. Photos are processed in memory and never saved; only the result is stored.
  Until verified, `/nearby`, `/location`, requests and messages return 403 `face_required`. Others see the **verified** gender (he/she) and age, not what the person typed.
- **Nearby**: exact distance (m) and bearing from the server, never anyone's coordinates. Respects visibility, Show me, blocks, reports, 3-minute staleness.
- **Connections, chat, block, report, wave, notifications, photo upload, export my data, delete account**. The app keeps a live WebSocket (`/ws`) open: the server sends a tiny `sync` / `nearby` hint the instant something changes, and the app fetches the data at once. Polling stays as a slow safety net (30 s live, 2-5 s if the socket is down).
- **Temporary chat**: messages are deleted 3 hours after they are sent, and only the newest 10 per conversation are kept (`messageTtlMs`, `messageKeep` in `src/config.js`; the app mirrors them in `services/config.ts`).
- **Push**: Expo push for requests, messages and "someone is nearby" (needs a development build + EAS projectId).

## Before going live
- Host with a **persistent disk** and set `DATA_DIR` (SQLite file + uploaded photos live there). Back it up.
- Put it behind HTTPS. Set `NODE_ENV=production`, a long `JWT_SECRET`, `PUBLIC_URL`, and real `SMTP_URL` (without SMTP nobody receives codes).
- Run one server instance (SQLite). To scale out, move to Postgres and S3 for photos.
- Face estimates are statistical: gender can be wrong and age is usually off by several years. Treat it as a safety filter, not proof of identity. Tune `TURN`, `PITCH_DELTA` in `src/face.js` with real phones.
- Profile photos are served by unguessable URL (not login-protected). Add moderation for photos and reports.
- Have a lawyer review biometric / face-data rules for your country (India DPDP Act, GDPR, etc.) and update the privacy policy.

## Moderation and backups
- Set `ADMIN_TOKEN` in `.env`, open `https://your-server/admin`, paste the token. You see reported people, can ban / unban, remove photos and dismiss reports. A ban logs the person out at once and hides them everywhere.
- `npm run backup` writes a safe copy of the database to `data/backups/` (keeps the newest 14). Run it daily with cron and copy it off the server. Photos are in `data/uploads/`.
- Typing and read signals travel over the live WebSocket only to a connected, unblocked peer and are never stored.
