// Moderation page for the owner. Off unless ADMIN_TOKEN is set. Open https://your-server/admin and paste the token.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { h, HttpError, hit } = require('../util');

module.exports = function adminRoutes({ db, store, rt }) {
  const r = express.Router();
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const gate = (req, res, next) => {
    if (!cfg.adminToken) return next(new HttpError(404, 'Not found'));
    if (!hit('adm:' + req.ip, 60, 60000)) return next(new HttpError(429, 'Slow down.'));
    if (!same(req.headers['x-admin-token'] || '', cfg.adminToken)) return next(new HttpError(401, 'Wrong admin token.'));
    next();
  };
  const page = (file, type) => (req, res, next) => { if (!cfg.adminToken) return next(new HttpError(404, 'Not found')); res.type(type).send(fs.readFileSync(path.join(__dirname, '..', 'admin', file), 'utf8')); };
  r.get('/', page('index.html', 'html')); r.get('/admin.js', page('admin.js', 'js'));

  const card = (u) => ({ id: u.id, name: u.name, email: u.email, age: store.toPublic(u).age, photos: store.toPublic(u).photos, bio: u.bio, banned: !!u.banned, banReason: u.ban_reason || '', createdAt: u.created_at });
  // Everyone who was reported, most reports first.
  r.get('/api/reports', gate, h(async (req, res) => {
    const rows = db.prepare('SELECT target, COUNT(*) n, MAX(at) last FROM reports GROUP BY target ORDER BY n DESC, last DESC LIMIT 200').all(); const out = [];
    for (const x of rows) {
      const u = store.q.userById.get(x.target); if (!u) continue;
      out.push({ ...card(u), reports: x.n, last: x.last, reasons: db.prepare('SELECT reason, COUNT(*) n FROM reports WHERE target = ? GROUP BY reason').all(x.target) });
    }
    res.json({ people: out, totalUsers: db.prepare('SELECT COUNT(*) c FROM users').get().c, banned: db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c });
  }));
  r.get('/api/users', gate, h(async (req, res) => {
    const q = '%' + String(req.query.q || '').trim().toLowerCase() + '%';
    res.json({ people: db.prepare('SELECT * FROM users WHERE lower(email) LIKE ? OR lower(name) LIKE ? OR id = ? ORDER BY created_at DESC LIMIT 50').all(q, q, String(req.query.q || '')).map(card) });
  }));
  const target = (id) => { const u = store.q.userById.get(String(id)); if (!u) throw new HttpError(404, 'No such user.'); return u; };
  r.post('/api/users/:id/ban', gate, h(async (req, res) => {
    const u = target(req.params.id); db.prepare('UPDATE users SET banned = 1, ban_reason = ?, token_version = token_version + 1, push_token = NULL WHERE id = ?').run(String(req.body.reason || '').slice(0, 200), u.id);
    rt.kick(u.id); rt.nearbyChanged(u); rt.emitMany(store.q.myLinks.all(u.id, u.id).map((l) => (l.a === u.id ? l.b : l.a)), 'sync'); res.json({ ok: true });
  }));
  r.post('/api/users/:id/unban', gate, h(async (req, res) => { const u = target(req.params.id); db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(u.id); res.json({ ok: true }); }));
  r.post('/api/users/:id/clear-photos', gate, h(async (req, res) => {
    const u = target(req.params.id); db.prepare("UPDATE users SET photos = '[]' WHERE id = ?").run(u.id);
    for (const f of db.prepare('SELECT name FROM uploads WHERE owner = ?').all(u.id)) { db.prepare('DELETE FROM uploads WHERE name = ?').run(f.name); fs.rm(path.join(cfg.dataDir, 'uploads', f.name), { force: true }, () => {}); }
    rt.emit(u.id, 'sync'); res.json({ ok: true });
  }));
  r.post('/api/reports/:id/dismiss', gate, h(async (req, res) => { db.prepare('DELETE FROM reports WHERE target = ?').run(String(req.params.id)); res.json({ ok: true }); }));
  return r;
};
