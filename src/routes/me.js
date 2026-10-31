const express = require('express');
const path = require('path');
const { h, HttpError, strArr, isIsoDate, ageFromDob } = require('../util');
const cfg = require('../config');

const GENDERS = ['Woman', 'Man', 'Non-binary', 'Prefer not to say'];
const INTENTS = ['friendship', 'new_friends', 'meaningful', 'dating', 'exploring'];
const VIS = ['everyone', 'connections', 'nobody'];
const SHOW = ['Everyone', 'Women', 'Men'];
const SOCIAL_KEYS = ['instagram', 'facebook', 'youtube', 'linkedin'];

module.exports = function meRoutes({ db, store, auth, rt }) {
  const r = express.Router();

  r.get('/me', auth, h(async (req, res) => res.json({ me: store.toMe(req.user) })));

  r.put('/me', auth, h(async (req, res) => {
    const u = req.user; const b = req.body || {}; const set = {};
    if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 30); if (n.length < 2) throw new HttpError(400, 'Name must be at least 2 characters.'); set.name = n; }
    if (b.dob !== undefined && !u.dob) { // date of birth is locked once saved, so the 18+ check cannot be edited away
      if (!isIsoDate(b.dob)) throw new HttpError(400, 'Enter a valid date of birth.');
      const age = ageFromDob(b.dob); if (age === null || age > 100) throw new HttpError(400, 'Enter a real date.');
      if (age < cfg.minAge) throw new HttpError(403, 'You must be 18 or older to use Nearby.', 'underage');
      set.dob = b.dob;
    }
    if (b.bio !== undefined) set.bio = String(b.bio).slice(0, 160);
    if (b.photos !== undefined) {
      if (!Array.isArray(b.photos) || b.photos.length > 6) throw new HttpError(400, 'You can add up to 6 photos.');
      const mine = new Set(db.prepare('SELECT name FROM uploads WHERE owner = ?').all(u.id).map((x) => x.name)); const out = [];
      for (const p of b.photos) {
        const name = path.posix.basename(String(p).split('?')[0]);
        if (!/\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/.test(String(p).split('?')[0]) || !mine.has(name)) throw new HttpError(400, 'One of the photos was not uploaded yet.');
        out.push('/uploads/' + name);
      }
      set.photos = JSON.stringify(out);
    }
    const interests = strArr(b.interests, 20, 40); if (interests) set.interests = JSON.stringify(interests);
    const intentions = strArr(b.intentions, 5, 20); if (intentions) set.intentions = JSON.stringify(intentions.filter((x) => INTENTS.includes(x)));
    const languages = strArr(b.languages, 8, 20); if (languages) set.languages = JSON.stringify(languages);
    if (Array.isArray(b.socials)) set.socials = JSON.stringify(b.socials.filter((s) => s && SOCIAL_KEYS.includes(s.key) && typeof s.handle === 'string').slice(0, 4).map((s) => ({ key: s.key, handle: s.handle.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40), visible: !!s.visible })));
    if (VIS.includes(b.visibility)) set.visibility = b.visibility;
    if (SHOW.includes(b.interestedIn)) set.interested_in = b.interestedIn;
    if (GENDERS.includes(b.gender)) set.gender_claimed = b.gender;       // only a fallback: the face scan result is what others see
    if (b.prefs && typeof b.prefs === 'object') set.prefs = JSON.stringify({ nearby: b.prefs.nearby !== false, requests: b.prefs.requests !== false, messages: b.prefs.messages !== false, quietHours: !!b.prefs.quietHours, tz: Number(b.prefs.tz) || 0 });
    const cols = Object.keys(set);
    if (cols.length) db.prepare(`UPDATE users SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c]), u.id);
    const fresh = store.getUser(u.id);
    res.json({ me: store.toMe(fresh) });
    if (cols.length) { // live: my other phone, my connections and people near me see the change without refreshing
      rt.emit(u.id, 'sync'); rt.emitMany(store.q.myLinks.all(u.id, u.id).map((l) => (l.a === u.id ? l.b : l.a)), 'sync'); rt.nearbyChanged(fresh);
    }
  }));

  r.post('/visibility', auth, h(async (req, res) => {
    const v = req.body.visible ? 1 : 0; const changed = req.user.visible !== v;
    db.prepare('UPDATE users SET visible = ? WHERE id = ?').run(v, req.user.id); res.json({ ok: true });
    if (changed) rt.nearbyChanged(store.getUser(req.user.id));
  }));
  r.post('/push-token', auth, h(async (req, res) => {
    const t = String(req.body.token || ''); if (!/^Expo(nent)?PushToken\[[^\]]+\]$/.test(t)) throw new HttpError(400, 'Bad push token.');
    db.prepare('UPDATE users SET push_token = NULL WHERE push_token = ?').run(t); // one phone, one account
    db.prepare('UPDATE users SET push_token = ? WHERE id = ?').run(t, req.user.id); res.json({ ok: true });
  }));
  r.delete('/push-token', auth, h(async (req, res) => { db.prepare('UPDATE users SET push_token = NULL WHERE id = ?').run(req.user.id); res.json({ ok: true }); }));

  r.delete('/me', auth, h(async (req, res) => {
    const u = req.user; const peers = store.q.myLinks.all(u.id, u.id).map((l) => (l.a === u.id ? l.b : l.a));
    store.deleteAccount(u.id); res.json({ ok: true }); rt.emitMany(peers, 'sync'); rt.nearbyChanged(u);
  }));

  r.post('/feedback', auth, h(async (req, res) => {
    const t = String(req.body.text || '').trim().slice(0, 2000); if (t.length < 3) throw new HttpError(400, 'Write a few words first.');
    if (!require('../util').hit('fb:' + req.user.id, 5, 3600e3)) throw new HttpError(429, 'Thanks. Please try again later.');
    db.prepare('INSERT INTO feedback(user_id,text,at) VALUES (?,?,?)').run(req.user.id, t, Date.now()); res.json({ ok: true });
  }));

  // "Download my data": everything stored about the person, except other people's private data.
  r.get('/export', auth, h(async (req, res) => {
    const u = req.user; const id = u.id;
    res.json({
      exportedAt: new Date().toISOString(), profile: store.toMe(u),
      connections: db.prepare('SELECT a,b,state,requester,at FROM links WHERE a = ? OR b = ?').all(id, id),
      blocks: db.prepare('SELECT blocked, at FROM blocks WHERE blocker = ?').all(id),
      reports: db.prepare('SELECT target, reason, at FROM reports WHERE reporter = ?').all(id),
      messages: db.prepare('SELECT id, sender, receiver, text, image, at FROM messages WHERE (sender = ? OR receiver = ?) AND deleted = 0').all(id, id),
      note: 'Face photos are never stored. Only the result of the face check (gender, estimated age, date) is kept.',
    });
  }));
  return r;
};
