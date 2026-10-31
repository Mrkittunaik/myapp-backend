const nodemailer = require('nodemailer');
const cfg = require('./config');
let transport = null;
if (cfg.smtpUrl) transport = nodemailer.createTransport(cfg.smtpUrl);
else console.warn('[mail] SMTP_URL not set. Email codes will be printed in this console (development only).');

async function sendMail(to, subject, text) {
  if (!transport) { console.log(`[mail:dev] to=${to} | ${subject} | ${text}`); return { sent: false }; }
  await transport.sendMail({ from: cfg.mailFrom, to, subject, text });
  return { sent: true };
}
module.exports = { sendMail, hasSmtp: !!transport };
