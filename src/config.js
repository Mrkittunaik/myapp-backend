require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';
let secret = process.env.JWT_SECRET || '';
if (!secret) {
  if (isProd) { console.error('FATAL: JWT_SECRET is required when NODE_ENV=production'); process.exit(1); }
  secret = crypto.randomBytes(32).toString('hex'); // dev only: sessions reset on every restart
  console.warn('[config] JWT_SECRET not set. Using a temporary secret (everyone is logged out on restart).');
}
const port = Number(process.env.PORT) || 4000;
module.exports = {
  isProd,
  port,
  jwtSecret: secret,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Nearby <no-reply@localhost>',
  devReturnCodes: !isProd && process.env.DEV_RETURN_CODES === '1',
  facePoseCheck: isProd ? true : process.env.FACE_POSE_CHECK !== 'off',
  staleMs: 3 * 60 * 1000,            // people not heard from for 3 minutes disappear from Nearby
  messageTtlMs: 3 * 3600e3,         // chat messages are deleted 3 hours after they were sent
  messageKeep: 10,                  // and only the newest 10 per conversation are kept
  adminToken: process.env.ADMIN_TOKEN || '', // set it to turn on the /admin moderation page (use a long random string)
  tokenDays: 60,
  codeMinutes: 10,
  minAge: 18,
};
