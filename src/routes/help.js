// Help board: a person posts what she needs (company for an event, a room, an errand...) and may offer to pay.
// Everyone eligible sees the post WITHOUT her name, photo or id. People send a join request; she sees who asked (with their profiles) and accepts one.
// Only then are the two connected and her profile shown to that one person. 2 free posts per calendar month; more will need coins (coming soon).
const express = require('express');
const cfg = require('../config');
const { pair } = require('../db');
const { h, HttpError, hit, newId } = require('../util');

const CATS = ['help', 'companion', 'rent', 'task', 'other'];
const PREFS = ['Anyone', 'Women', 'Men'];
const REASONS = ['Fake profile or spam', 'Inappropriate photos or content', 'Harassment or hate', 'Underage user', 'Something else'];
const FREE_POSTS = 2, VISIBLE_DAYS = 30;
// The board is for friendly, non-sexual help only, and contact details are shared after accepting, not in the post.
const BAD = /\b(sex|sexual|sexy|escort|nude|nudes|porn|hook\s?up|sugar\s?(daddy|baby|mommy)|massage|happy ending|erotic|nsfw|onlyfans|adult service|call girl|gigolo|one night)\b/i;
const CONTACT = /(\+?\d[\d\s().-]{7,}\d)|@\w{3,}|https?:\/\/|www\.|[\w.+-]+@[\w-]+\.\w+/i;

module.exports = function helpRoutes({ db, store, auth, requireFace, rt }) {
  const r = express.Router(); const { q } = store;
  const band = (age) => (age ? Math.floor(age / 10) * 10 + 's' : '');
  const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const nextMonth = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
  const quota = (uid) => ({ used: db.prepare('SELECT COUNT(*) c FROM help_posts WHERE owner = ? AND created_at >= ?').get(uid, monthStart()).c, limit: FREE_POSTS, resetsAt: nextMonth() });
  const post = (id) => { const p = db.prepare('SELECT * FROM help_posts WHERE id = ?').get(String(id)); if (!p) throw new HttpError(404, 'This post is no longer available.'); return p; };
  const base = (p) => ({ id: p.id, category: p.category, title: p.title, body: p.body, offer: p.offer, pref: p.pref, createdAt: p.created_at });
  const screen = (...parts) => {
    const t = parts.join(' ');
    if (BAD.test(t)) throw new HttpError(400, 'Nearby is for friendly, non-sexual help only. Please change your post.', 'post_rules');
    if (CONTACT.test(t)) throw new HttpError(400, 'Please do not put phone numbers, links or handles here. You can share them after you accept someone.', 'post_contact');
  };
  const eligible = (me, p) => { const g = store.shownGender(me); return !((p.pref === 'Women' && g !== 'Woman') || (p.pref === 'Men' && g !== 'Man')); };

  // What everyone sees: no name, no photo, no id of the poster.
  r.get('/help', auth, requireFace, h(async (req, res) => {
    const me = req.user; const cat = CATS.includes(req.query.cat) ? req.query.cat : null; const now = Date.now();
    const mine = new Map(db.prepare('SELECT post_id, status FROM help_requests WHERE user_id = ?').all(me.id).map((x) => [x.post_id, x.status]));
    const reported = new Set(db.prepare('SELECT target FROM reports WHERE reporter = ?').all(me.id).map((x) => x.target));
    const out = [];
    for (const p of db.prepare("SELECT * FROM help_posts WHERE status = 'open' AND expires > ? AND owner != ? ORDER BY created_at DESC LIMIT 300").all(now, me.id)) {
      if (cat && p.category !== cat) continue;
      const o = store.getUser(p.owner); if (!o || o.banned || reported.has(o.id) || store.blockedEither(me.id, o.id) || !eligible(me, p)) continue;
      out.push({ ...base(p), poster: { gender: store.shownGender(o) || undefined, ageBand: band(store.toPublic(o).age) }, myRequest: mine.get(p.id) || null });
      if (out.length >= 50) break;
    }
    res.json({ posts: out });
  }));

  r.post('/help', auth, requireFace, h(async (req, res) => {
    const me = req.user; const b = req.body || {};
    const category = CATS.includes(b.category) ? b.category : 'help'; const title = String(b.title || '').trim().slice(0, 80); const body = String(b.body || '').trim().slice(0, 500);
    if (title.length < 3) throw new HttpError(400, 'Give your post a short title.'); if (body.length < 10) throw new HttpError(400, 'Describe what you need in at least 10 characters.');
    screen(title, body);
    const offer = Math.min(Math.max(parseInt(b.offer, 10) || 0, 0), 100000); const pref = PREFS.includes(b.pref) ? b.pref : 'Anyone';
    if (quota(me.id).used >= FREE_POSTS) throw new HttpError(402, 'You have used your 2 free posts this month. Coins are coming soon.', 'post_limit');
    if (!hit('post:' + me.id, 5, 3600e3)) throw new HttpError(429, 'You are posting too fast. Try again later.');
    const id = newId('h_'); const now = Date.now();
    db.prepare('INSERT INTO help_posts(id,owner,category,title,body,offer,pref,status,created_at,expires) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, me.id, category, title, body, offer, pref, 'open', now, now + VISIBLE_DAYS * 86400e3);
    res.status(201).json({ post: { ...base(post(id)), status: 'open', pending: 0, total: 0, expiresAt: now + VISIBLE_DAYS * 86400e3 }, quota: quota(me.id) });
    rt.broadcast('help');
  }));

  // My own posts, with how many people asked.
  r.get('/help/mine', auth, requireFace, h(async (req, res) => {
    const me = req.user; const cnt = db.prepare("SELECT COUNT(*) c, SUM(status = 'pending') p FROM help_requests WHERE post_id = ?");
    const posts = db.prepare("SELECT * FROM help_posts WHERE owner = ? AND status != 'closed' ORDER BY created_at DESC LIMIT 100").all(me.id).map((p) => { const c = cnt.get(p.id); return { ...base(p), status: p.status, expiresAt: p.expires, pending: c.p || 0, total: c.c || 0 }; });
    res.json({ posts, quota: quota(me.id) });
  }));
  // Who asked to join my post, with their profiles.
  r.get('/help/mine/:id/requests', auth, h(async (req, res) => {
    const me = req.user; const p = post(req.params.id); if (p.owner !== me.id) throw new HttpError(403, 'This is not your post.');
    const out = [];
    for (const x of db.prepare('SELECT * FROM help_requests WHERE post_id = ? ORDER BY at DESC').all(p.id)) {
      const u = store.getUser(x.user_id); if (!u || u.banned || store.blockedEither(me.id, u.id)) continue;
      out.push({ userId: u.id, note: x.note, status: x.status, at: x.at, profile: store.toPublic(u) });
    }
    res.json({ post: { ...base(p), status: p.status }, requests: out });
  }));
  // My join requests. The poster's profile appears only once she accepted me.
  r.get('/help/requests', auth, requireFace, h(async (req, res) => {
    const me = req.user; const out = [];
    for (const x of db.prepare('SELECT * FROM help_requests WHERE user_id = ? ORDER BY at DESC LIMIT 100').all(me.id)) {
      const p = db.prepare('SELECT * FROM help_posts WHERE id = ?').get(x.post_id); if (!p) continue;
      const o = store.getUser(p.owner); const ok = x.status === 'accepted' && o && !o.banned && !store.blockedEither(me.id, o.id);
      out.push({ post: { ...base(p), status: p.status }, status: x.status, at: x.at, poster: ok ? store.toPublic(o) : null });
    }
    res.json({ requests: out });
  }));

  r.post('/help/:id/request', auth, requireFace, h(async (req, res) => {
    const me = req.user; const p = post(req.params.id); const o = store.getUser(p.owner);
    if (!o || o.banned || p.owner === me.id || p.status !== 'open' || p.expires < Date.now() || store.blockedEither(me.id, o.id) || !eligible(me, p)) throw new HttpError(404, 'This post is no longer available.');
    const prev = db.prepare('SELECT status FROM help_requests WHERE post_id = ? AND user_id = ?').get(p.id, me.id);
    if (prev) { if (prev.status === 'pending') return res.json({ state: 'pending' }); throw new HttpError(409, 'You cannot send another request for this post.'); }
    const note = String(req.body.note || '').trim().slice(0, 200); screen(note);
    if (!hit('hreq:' + me.id, 30, 86400e3)) throw new HttpError(429, 'You have sent a lot of requests today. Try again tomorrow.');
    db.prepare('INSERT INTO help_requests(post_id,user_id,note,status,at) VALUES (?,?,?,?,?)').run(p.id, me.id, note, 'pending', Date.now());
    store.notify(o.id, 'requests', 'hand-left', `${me.name || 'Someone'} wants to join your post "${p.title}"`.slice(0, 120), '/board?tab=mine', 'New join request');
    rt.emit(o.id, 'help'); res.status(201).json({ state: 'pending' });
  }));

  const ownerPost = (req) => { const p = post(req.params.id); if (p.owner !== req.user.id) throw new HttpError(403, 'This is not your post.'); return p; };
  r.post('/help/:id/accept', auth, requireFace, h(async (req, res) => {
    const me = req.user; const p = ownerPost(req); const uid = String(req.body.userId || '');
    const reqRow = db.prepare("SELECT * FROM help_requests WHERE post_id = ? AND user_id = ? AND status = 'pending'").get(p.id, uid);
    const u = store.getUser(uid);
    if (p.status !== 'open') throw new HttpError(409, 'You already chose someone for this post.');
    if (!reqRow || !u || u.banned || store.blockedEither(me.id, uid)) throw new HttpError(404, 'This request is no longer available.');
    const others = db.prepare("SELECT user_id FROM help_requests WHERE post_id = ? AND user_id != ?").all(p.id, uid).map((x) => x.user_id);
    db.transaction(() => {
      db.prepare("UPDATE help_requests SET status = 'accepted' WHERE post_id = ? AND user_id = ?").run(p.id, uid);
      db.prepare("UPDATE help_requests SET status = 'closed' WHERE post_id = ? AND user_id != ? AND status = 'pending'").run(p.id, uid);
      db.prepare("UPDATE help_posts SET status = 'filled', accepted = ? WHERE id = ?").run(uid, p.id);
      const [a, b] = pair(me.id, uid); q.putLink.run(a, b, 'connected', uid, Date.now()); // now they can chat
    })();
    store.notify(uid, 'requests', 'checkmark-circle', `${me.name || 'Someone'} accepted your join request for "${p.title}"`.slice(0, 120), '/board?tab=requests', 'Request accepted');
    rt.emitMany([me.id, uid, ...others], 'sync'); rt.emitMany([me.id, uid, ...others], 'help');
    res.json({ ok: true, state: 'connected' });
  }));
  r.post('/help/:id/decline', auth, h(async (req, res) => {
    const p = ownerPost(req); const uid = String(req.body.userId || '');
    db.prepare("UPDATE help_requests SET status = 'declined' WHERE post_id = ? AND user_id = ? AND status = 'pending'").run(p.id, uid);
    rt.emitMany([req.user.id, uid], 'help'); res.json({ ok: true });
  }));
  // Taking a post down still counts toward this month's 2 free posts.
  r.delete('/help/:id', auth, h(async (req, res) => {
    const p = ownerPost(req); const ids = db.prepare("SELECT user_id FROM help_requests WHERE post_id = ? AND status = 'pending'").all(p.id).map((x) => x.user_id);
    db.prepare("UPDATE help_posts SET status = 'closed' WHERE id = ?").run(p.id); db.prepare("UPDATE help_requests SET status = 'closed' WHERE post_id = ? AND status = 'pending'").run(p.id);
    rt.emitMany(ids, 'help'); rt.broadcast('help'); res.json({ ok: true });
  }));
  r.post('/help/:id/report', auth, h(async (req, res) => {
    const me = req.user; const p = post(req.params.id); if (p.owner === me.id) throw new HttpError(400, 'This is your own post.');
    if (!hit('rep:' + me.id, 20, 24 * 3600e3)) throw new HttpError(429, 'Too many reports today.');
    const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'Something else';
    db.prepare('INSERT INTO reports(reporter,target,reason,at) VALUES (?,?,?,?)').run(me.id, p.owner, 'Help post: ' + reason, Date.now()); res.json({ ok: true });
  }));
  return r;
};
