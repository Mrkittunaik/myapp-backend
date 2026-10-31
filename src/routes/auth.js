const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { h, HttpError, validEmail, validPassword, normEmail, newId, hit } = require('../util');
const { sendMail } = require('../mailer');

module.exports = function authRoutes({ db, store, auth }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } });
  r.use(limiter);
  const sign = (u) => jwt.sign({ sub: u.id, tv: u.token_version }, cfg.jwtSecret, { expiresIn: `${cfg.tokenDays}d` });
  const session = (u, extra = {}) => ({ token: sign(u), me: store.toMe(u), ...extra });
  const send = async (email, purpose, userId, subject, intro) => {
    const code = store.issueCode(email, purpose, userId);
    await sendMail(email, subject, `${intro}\n\nYour code is ${code}. It expires in ${cfg.codeMinutes} minutes.\nIf you did not ask for this, you can ignore this email.`).catch((e) => console.error('[mail] failed', e.message));
    return cfg.devReturnCodes ? { devCode: code } : {};
  };

  r.post('/signup', h(async (req, res) => {
    const email = normEmail(req.body.email), password = req.body.password;
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!validPassword(password)) throw new HttpError(400, 'Use at least 8 characters including a number.');
    if (store.userByEmail(email)) throw new HttpError(409, 'This email is already registered. Try logging in.');
    const id = newId('u_');
    db.prepare('INSERT INTO users(id,email,pass_hash,created_at) VALUES (?,?,?,?)').run(id, email, bcrypt.hashSync(password, 10), Date.now());
    const u = store.getUser(id);
    const extra = await send(email, 'verify', id, 'Verify your Nearby email', 'Welcome to Nearby.');
    res.status(201).json(session(u, extra));
  }));

  r.post('/login', h(async (req, res) => {
    const email = normEmail(req.body.email); const u = store.userByEmail(email);
    // Same message for "no such email" and "wrong password" so accounts cannot be probed.
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) throw new HttpError(401, 'Incorrect email or password.');
    if (u.banned) throw new HttpError(403, 'This account has been suspended.', 'banned');
    res.json(session(u));
  }));

  r.post('/verify', auth, h(async (req, res) => {
    const u = req.user; const code = String(req.body.code || '');
    if (!u.email_verified) {
      if (!store.checkCode(u.email, 'verify', code)) throw new HttpError(400, 'That code is not right or has expired.');
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(u.id);
    } else if (u.pending_email) {
      if (!store.checkCode(u.pending_email, 'email-change', code)) throw new HttpError(400, 'That code is not right or has expired.');
      if (store.userByEmail(u.pending_email)) throw new HttpError(409, 'This email is already registered.');
      db.prepare('UPDATE users SET email = ?, pending_email = NULL WHERE id = ?').run(u.pending_email, u.id);
    } else throw new HttpError(400, 'Nothing to verify.');
    res.json({ me: store.toMe(store.getUser(u.id)) });
  }));

  r.post('/resend', auth, h(async (req, res) => {
    const u = req.user; if (!hit('resend:' + u.id, 3, 10 * 60 * 1000)) throw new HttpError(429, 'Please wait a few minutes before asking for another code.');
    const target = u.email_verified ? u.pending_email : u.email; if (!target) throw new HttpError(400, 'Nothing to verify.');
    const extra = await send(target, u.email_verified ? 'email-change' : 'verify', u.id, 'Your Nearby code', 'Here is your new code.');
    res.json({ ok: true, ...extra });
  }));

  r.post('/forgot', h(async (req, res) => {
    const email = normEmail(req.body.email); const u = validEmail(email) ? store.userByEmail(email) : null; let extra = {};
    if (u && hit('forgot:' + email, 3, 15 * 60 * 1000)) extra = await send(email, 'reset', u.id, 'Reset your Nearby password', 'We got a request to reset your password.');
    res.json({ ok: true, ...extra }); // always the same answer
  }));
  r.post('/reset-check', h(async (req, res) => {
    const email = normEmail(req.body.email);
    if (!store.checkCode(email, 'reset', req.body.code, false)) throw new HttpError(400, 'That code is not right or has expired.');
    res.json({ ok: true });
  }));
  r.post('/reset', h(async (req, res) => {
    const email = normEmail(req.body.email); const u = store.userByEmail(email);
    if (!validPassword(req.body.password)) throw new HttpError(400, 'Use at least 8 characters including a number.');
    if (!u || !store.checkCode(email, 'reset', req.body.code)) throw new HttpError(400, 'That code has expired. Start again.');
    db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1, email_verified = 1 WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), u.id); // a reset code proves the inbox, so it also verifies the email
    res.json({ ok: true });
  }));

  r.post('/change-password', auth, h(async (req, res) => {
    const u = req.user;
    if (!bcrypt.compareSync(String(req.body.current || ''), u.pass_hash)) throw new HttpError(400, 'Current password is incorrect.');
    if (!validPassword(req.body.next)) throw new HttpError(400, 'Use at least 8 characters including a number.');
    if (req.body.current === req.body.next) throw new HttpError(400, 'Choose a password you have not used just now.');
    db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(bcrypt.hashSync(req.body.next, 10), u.id);
    res.json(session(store.getUser(u.id))); // fresh token: this phone stays logged in, every other session is signed out
  }));

  r.post('/change-email', auth, h(async (req, res) => {
    const u = req.user; const email = normEmail(req.body.email);
    if (!bcrypt.compareSync(String(req.body.password || ''), u.pass_hash)) throw new HttpError(400, 'Password is incorrect.');
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (store.userByEmail(email)) throw new HttpError(409, 'This email is already registered.');
    db.prepare('UPDATE users SET pending_email = ? WHERE id = ?').run(email, u.id);
    const extra = await send(email, 'email-change', u.id, 'Confirm your new Nearby email', 'Confirm this address for your Nearby account.');
    res.json({ ok: true, ...extra });
  }));

  r.post('/logout-all', auth, h(async (req, res) => { db.prepare('UPDATE users SET token_version = token_version + 1, push_token = NULL WHERE id = ?').run(req.user.id); res.json({ ok: true }); }));
  return r;
};
