const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const cfg = require('../config');
const face = require('../face');
const { h, HttpError, hit } = require('../util');

const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };

module.exports = function faceRoutes({ db, store, auth }) {
  const r = express.Router();
  // Photos are held in memory only. Nothing is written to disk or the database; only the result is kept.
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 5 } });

  r.get('/face/status', auth, h(async (req, res) => { const m = store.toMe(req.user); res.json({ face: m.face }); }));

  r.post('/face/start', auth, h(async (req, res) => {
    const u = req.user;
    if (!u.email_verified) throw new HttpError(403, 'Verify your email first.', 'email_required');
    const recent = db.prepare('SELECT COUNT(*) c FROM face_sessions WHERE user_id = ? AND at > ?').get(u.id, Date.now() - 3600e3).c;
    if (recent >= 8) throw new HttpError(429, 'Too many face scans. Try again in an hour.');
    if (req.body && req.body.consent === true) db.prepare('UPDATE users SET face_consent_at = ? WHERE id = ?').run(Date.now(), u.id); // the person agreed on the consent screen
    const id = crypto.randomBytes(12).toString('hex'); const steps = ['center', ...shuffle(['left', 'right', 'up', 'down'])];
    db.prepare('INSERT INTO face_sessions(id,user_id,steps,expires,at) VALUES (?,?,?,?,?)').run(id, u.id, JSON.stringify(steps), Date.now() + 4 * 60000, Date.now());
    face.init().catch((e) => console.error('[face] model load failed', e)); // warm up while the person is getting ready
    res.json({ sessionId: id, steps, expiresInSec: 240 });
  }));

  r.post('/face/verify', auth, up.array('frames', 5), h(async (req, res) => {
    const u = req.user; const s = db.prepare('SELECT * FROM face_sessions WHERE id = ? AND user_id = ?').get(String(req.body.sessionId || ''), u.id);
    if (!s || s.used || s.expires < Date.now()) throw new HttpError(400, 'This scan expired. Start again.', 'session');
    db.prepare('UPDATE face_sessions SET used = 1 WHERE id = ?').run(s.id); // one try per session
    const steps = JSON.parse(s.steps); const files = req.files || [];
    if (files.length !== steps.length) throw new HttpError(400, 'We need one photo for every step.', 'frames');
    let frames;
    try { frames = []; for (const f of files) frames.push(await face.analyze(f.buffer)); }
    catch (e) { console.error('[face] analyze failed', e.message); throw new HttpError(422, 'We could not read the photos. Try again.', 'bad_image'); }
    req.files = null; files.length = 0; // drop the buffers right away
    const out = face.evaluate(steps, frames, { poseCheck: cfg.facePoseCheck });
    if (!out.ok) {
      if (out.status === 'rejected') db.prepare("UPDATE users SET face_status = 'rejected', face_at = ? WHERE id = ?").run(Date.now(), u.id);
      throw new HttpError(422, out.message, out.reason);
    }
    db.prepare("UPDATE users SET face_status = 'verified', face_gender = ?, face_age = ?, face_confidence = ?, face_at = ? WHERE id = ?").run(out.gender, out.age, out.confidence, Date.now(), u.id);
    res.json({ ok: true, face: store.toMe(store.getUser(u.id)).face });
  }));
  return r;
};
