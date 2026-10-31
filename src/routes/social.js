const express = require('express');
const cfg = require('../config');
const { pair } = require('../db');
const { h, HttpError, hit, distanceM, bearingDeg, newId } = require('../util');

const REASONS = ['Fake profile or spam', 'Inappropriate photos or content', 'Harassment or hate', 'Underage user', 'Something else'];

module.exports = function socialRoutes({ db, store, auth, requireFace, rt, retention }) {
  const r = express.Router(); const { q } = store;
  const alerted = new Map(); // "a|b" -> last nearby push (anti-spam)

  const other = (id) => { const o = store.getUser(String(id)); if (!o || o.banned) throw new HttpError(404, 'This person is no longer available.'); return o; };
  const setLink = (x, y, state, requester) => { const [a, b] = pair(x, y); q.putLink.run(a, b, state, requester, Date.now()); rt.emitMany([x, y], 'sync'); };
  const dropLink = (x, y) => { const [a, b] = pair(x, y); q.delLink.run(a, b); rt.emitMany([x, y], 'sync'); };

  // Who may appear in someone's Nearby list.
  function visibleTo(viewer, t) {
    if (t.id === viewer.id || t.banned || !store.faceVerified(t) || !t.email_verified || !t.visible || !t.loc_at || Date.now() - t.loc_at > cfg.staleMs) return false;
    if (t.visibility === 'nobody') return false;
    if (store.blockedEither(viewer.id, t.id)) return false;
    if (t.visibility === 'connections' && store.relationFor(viewer.id, t.id) !== 'connected') return false;
    if (db.prepare('SELECT 1 FROM reports WHERE reporter = ? AND target = ?').get(viewer.id, t.id)) return false;
    const want = viewer.interested_in === 'Women' ? 'Woman' : viewer.interested_in === 'Men' ? 'Man' : null;
    return !want || store.shownGender(t) === want;
  }

  r.post('/location', auth, requireFace, h(async (req, res) => {
    const { lat, lng, accuracy } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Bad coordinates.');
    const me = req.user;
    // Tell people nearby only when I really moved (or just came back); a still phone's heartbeat is not news.
    const moved = me.lat == null || !me.loc_at || Date.now() - me.loc_at > cfg.staleMs || distanceM({ lat: me.lat, lng: me.lng }, { lat, lng }) > 2;
    db.prepare('UPDATE users SET lat = ?, lng = ?, accuracy = ?, loc_at = ? WHERE id = ?').run(lat, lng, typeof accuracy === 'number' ? accuracy : null, Date.now(), me.id);
    res.json({ ok: true });
    if (moved) rt.nearbyChanged(store.getUser(me.id));
    try { nearbyAlerts(store.getUser(me.id)); } catch (e) { console.error('[alerts]', e.message); }
  }));

  function nearbyAlerts(me) {
    if (!me.visible || me.visibility === 'nobody') return;
    const box = 0.0075; // ~800 m, cheap pre-filter before exact distance
    const rows = db.prepare('SELECT * FROM users WHERE id != ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').all(me.id, me.lat - box, me.lat + box, me.lng - box * 1.5, me.lng + box * 1.5);
    for (const o of rows) {
      if (!visibleTo(o, me)) continue; // would they see me in their own list?
      const d = distanceM({ lat: me.lat, lng: me.lng }, { lat: o.lat, lng: o.lng }); if (d > 500 || !o.loc_at || Date.now() - o.loc_at > cfg.staleMs) continue;
      const key = pair(me.id, o.id).join('|'); if (Date.now() - (alerted.get(key) || 0) < 30 * 60000) continue;
      alerted.set(key, Date.now());
      store.notify(o.id, 'nearby', 'navigate', `${me.name || 'Someone'} is ${Math.round(d)} m away`, '/(tabs)/nearby', 'Someone is nearby');
    }
  }

  // Everyone live within `radius` metres: exact distance and bearing from me. Other people's coordinates are never sent.
  r.get('/nearby', auth, requireFace, h(async (req, res) => {
    const me = req.user; const radius = Math.min(Math.max(Number(req.query.radius) || 500, 10), 20000);
    if (me.lat == null) return res.json({ people: [], serverTime: Date.now() });
    const dLat = radius / 111320, dLng = radius / (111320 * Math.max(Math.cos((me.lat * Math.PI) / 180), 0.01));
    const rows = db.prepare('SELECT * FROM users WHERE id != ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').all(me.id, me.lat - dLat, me.lat + dLat, me.lng - dLng, me.lng + dLng);
    const a = { lat: me.lat, lng: me.lng };
    const people = rows.filter((u) => visibleTo(me, u)).map((u) => ({ u, d: distanceM(a, { lat: u.lat, lng: u.lng }), b: bearingDeg(a, { lat: u.lat, lng: u.lng }) }))
      .filter((x) => x.d <= radius).sort((x, y) => x.d - y.d).slice(0, 200)
      .map(({ u, d, b }) => ({ ...store.toPublic(u), distance: Math.round(d * 10) / 10, bearing: Math.round(b * 10) / 10, accuracy: u.accuracy, updatedAt: u.loc_at }));
    res.json({ people, serverTime: Date.now() });
  }));

  r.get('/people/:id', auth, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id);
    if (store.blockedEither(me.id, o.id)) throw new HttpError(404, 'This person is no longer available.');
    const rel = store.relationFor(me.id, o.id);
    if (rel === 'none' && !visibleTo(me, o)) throw new HttpError(404, 'This person is no longer available.');
    res.json({ person: store.toPublic(o), state: rel });
  }));

  // ---- connections ----
  // A connection request is also the "chat request": once the other person accepts, the two can message. Used by the Connect button and by the heart on a Discover card.
  function sendRequest(me, o) {
    if (o.id === me.id || store.blockedEither(me.id, o.id)) throw new HttpError(403, 'You cannot connect with this person.');
    if (!hit('req:' + me.id, 30, 24 * 3600e3)) throw new HttpError(429, 'You have sent a lot of requests today. Try again tomorrow.');
    const rel = store.relationFor(me.id, o.id);
    if (rel === 'connected' || rel === 'sent') return { state: rel, match: false };
    if (rel === 'incoming') { setLink(me.id, o.id, 'connected', o.id); store.notify(o.id, 'requests', 'checkmark-circle', `${me.name || 'Someone'} accepted your request`, '/(tabs)/messages'); return { state: 'connected', match: true }; }
    setLink(me.id, o.id, 'pending', me.id);
    store.notify(o.id, 'requests', 'person-add', `${me.name || 'Someone'} wants to connect`, '/(tabs)/connections', 'Connection request');
    return { state: 'sent', match: false };
  }
  r.post('/connections/:id/request', auth, requireFace, h(async (req, res) => { const { state } = sendRequest(req.user, other(req.params.id)); res.json({ state }); }));

  // ---- Discover: photo cards of people in an age range ----
  // Only verified people who show to everyone. Not people you already connected with, passed in the last 30 days, blocked or reported. People who already asked to connect with you come first.
  r.get('/discover', auth, requireFace, h(async (req, res) => {
    const me = req.user; const lo = Math.min(Math.max(parseInt(req.query.ageMin, 10) || cfg.minAge, cfg.minAge), 100); const hi = Math.max(Math.min(parseInt(req.query.ageMax, 10) || 100, 100), lo);
    const want = me.interested_in === 'Women' ? 'Woman' : me.interested_in === 'Men' ? 'Man' : null;
    const passed = new Set(db.prepare('SELECT target FROM passes WHERE viewer = ? AND at > ?').all(me.id, Date.now() - 30 * 86400e3).map((x) => x.target));
    const reported = db.prepare('SELECT 1 FROM reports WHERE reporter = ? AND target = ?'); const out = [];
    for (const u of db.prepare("SELECT * FROM users WHERE id != ? AND email_verified = 1 AND face_status = 'verified' AND visibility = 'everyone' AND banned = 0 ORDER BY RANDOM() LIMIT 400").all(me.id)) {
      if (passed.has(u.id) || store.blockedEither(me.id, u.id) || reported.get(me.id, u.id)) continue;
      const rel = store.relationFor(me.id, u.id); if (rel === 'connected' || rel === 'sent') continue;
      if (want && store.shownGender(u) !== want) continue;
      const p = store.toPublic(u); if (p.age == null || p.age < lo || p.age > hi) continue;
      // Distance is only a rough whole-kilometre figure, never a position.
      const km = me.lat != null && u.lat != null && u.loc_at && Date.now() - u.loc_at < 7 * 86400e3 ? Math.max(1, Math.round(distanceM({ lat: me.lat, lng: me.lng }, { lat: u.lat, lng: u.lng }) / 1000)) : undefined;
      out.push({ ...p, likedYou: rel === 'incoming', distanceKm: km });
    }
    out.sort((x, y) => Number(y.likedYou) - Number(x.likedYou));
    res.json({ people: out.slice(0, 20) });
  }));
  r.post('/discover/:id/like', auth, requireFace, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id); const out = sendRequest(me, o);
    db.prepare('DELETE FROM passes WHERE viewer = ? AND target = ?').run(me.id, o.id); res.json(out);
  }));
  r.delete('/discover/:id/pass', auth, h(async (req, res) => { db.prepare('DELETE FROM passes WHERE viewer = ? AND target = ?').run(req.user.id, String(req.params.id)); res.json({ ok: true }); }));
  r.post('/discover/:id/pass', auth, requireFace, h(async (req, res) => {
    const o = other(req.params.id); db.prepare('INSERT INTO passes(viewer,target,at) VALUES (?,?,?) ON CONFLICT(viewer,target) DO UPDATE SET at = excluded.at').run(req.user.id, o.id, Date.now()); res.json({ ok: true });
  }));

  r.post('/connections/:id/cancel', auth, h(async (req, res) => { const me = req.user; if (store.relationFor(me.id, req.params.id) === 'sent') dropLink(me.id, req.params.id); res.json({ state: 'none' }); }));
  r.post('/connections/:id/accept', auth, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id);
    if (store.relationFor(me.id, o.id) !== 'incoming') throw new HttpError(409, 'There is no request to accept.');
    setLink(me.id, o.id, 'connected', o.id);
    store.notify(o.id, 'requests', 'checkmark-circle', `${me.name || 'Someone'} accepted your request`, '/(tabs)/messages', 'Connections');
    res.json({ state: 'connected' });
  }));
  r.post('/connections/:id/decline', auth, h(async (req, res) => { const me = req.user; if (store.relationFor(me.id, req.params.id) === 'incoming') dropLink(me.id, req.params.id); res.json({ state: 'none' }); }));
  r.post('/connections/:id/remove', auth, h(async (req, res) => { const me = req.user; if (store.relationFor(me.id, req.params.id) === 'connected') dropLink(me.id, req.params.id); res.json({ state: 'none' }); }));

  r.post('/wave/:id', auth, requireFace, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id); if (store.blockedEither(me.id, o.id)) throw new HttpError(403, 'You cannot do that.');
    const [a, b] = [me.id, o.id]; const prev = db.prepare('SELECT at FROM waves WHERE a = ? AND b = ?').get(a, b);
    if (prev && Date.now() - prev.at < 24 * 3600e3) return res.json({ ok: true });
    db.prepare('INSERT INTO waves(a,b,at) VALUES (?,?,?) ON CONFLICT(a,b) DO UPDATE SET at = excluded.at').run(a, b, Date.now());
    store.notify(o.id, 'nearby', 'hand-left', `${me.name || 'Someone'} said hi`, `/profiles/${me.id}`, 'Someone said hi');
    res.json({ ok: true });
  }));

  // ---- safety ----
  r.post('/blocks/:id', auth, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id); if (o.id === me.id) throw new HttpError(400, 'You cannot block yourself.');
    db.prepare('INSERT OR IGNORE INTO blocks(blocker,blocked,at) VALUES (?,?,?)').run(me.id, o.id, Date.now()); dropLink(me.id, o.id); res.json({ ok: true });
  }));
  r.delete('/blocks/:id', auth, h(async (req, res) => { db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').run(req.user.id, req.params.id); res.json({ ok: true }); }));
  r.post('/reports', auth, h(async (req, res) => {
    const me = req.user; const o = other(req.body.target); const reason = REASONS.includes(req.body.reason) ? req.body.reason : 'Something else';
    if (!hit('rep:' + me.id, 20, 24 * 3600e3)) throw new HttpError(429, 'Too many reports today.');
    db.prepare('INSERT INTO reports(reporter,target,reason,at) VALUES (?,?,?,?)').run(me.id, o.id, reason, Date.now()); dropLink(me.id, o.id); res.json({ ok: true });
  }));

  // ---- chat ----
  const isMine = (u, url) => { const name = String(url).split('?')[0].split('/').pop(); return /^[a-f0-9]+\.(jpg|png|webp)$/.test(name) && !!db.prepare('SELECT 1 FROM uploads WHERE name = ? AND owner = ?').get(name, u.id); };
  r.post('/messages/:id', auth, requireFace, h(async (req, res) => {
    const me = req.user; const o = other(req.params.id);
    if (store.relationFor(me.id, o.id) !== 'connected' || store.blockedEither(me.id, o.id)) throw new HttpError(403, 'You can message people after a connection request is accepted.');
    if (!hit('msg:' + me.id, 60, 60000)) throw new HttpError(429, 'You are sending messages too fast.');
    const text = String(req.body.text || '').trim().slice(0, 1000); const image = req.body.image ? String(req.body.image) : '';
    if (!text && !image) throw new HttpError(400, 'Write a message first.');
    if (image && !isMine(me, image)) throw new HttpError(400, 'The photo was not uploaded yet.');
    const cid = /^[A-Za-z0-9_-]{8,48}$/.test(req.body.id || '') ? req.body.id : newId('m_');
    const dup = db.prepare('SELECT * FROM messages WHERE id = ?').get(cid);
    const row = dup && dup.sender === me.id ? dup : null;
    if (dup && !row) throw new HttpError(409, 'Duplicate id.');
    const m = row || (() => { const rev = db.nextRev(); const at = Date.now(); db.prepare('INSERT INTO messages(id,sender,receiver,text,image,at,rev) VALUES (?,?,?,?,?,?,?)').run(cid, me.id, o.id, text, image ? '/uploads/' + image.split('?')[0].split('/').pop() : '', at, rev); return db.prepare('SELECT * FROM messages WHERE id = ?').get(cid); })();
    if (!row) { retention.trimPair(me.id, o.id); rt.emitMany([me.id, o.id], 'sync'); }
    if (!row) store.notify(o.id, 'messages', 'chatbubble', `${me.name || 'Someone'}: ${text || 'Photo'}`.slice(0, 120), `/chat/${me.id}`, 'New message');
    res.status(201).json({ message: shapeMsg(m, me.id) });
  }));
  const shapeMsg = (m, meId) => ({ id: m.id, peer: m.sender === meId ? m.receiver : m.sender, mine: m.sender === meId, text: m.text, image: store.abs(m.image), at: m.at, deleted: !!m.deleted, rev: m.rev });
  r.delete('/messages/:peer/:mid', auth, h(async (req, res) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ? AND sender = ?').get(req.params.mid, req.user.id); if (!m) throw new HttpError(404, 'Message not found.');
    db.prepare("UPDATE messages SET deleted = 1, deleted_at = ?, text = '', image = '', rev = ? WHERE id = ?").run(Date.now(), db.nextRev(), m.id); retention.dropImage(String(m.image).split('/').pop()); res.json({ ok: true });
    rt.emitMany([req.user.id, m.receiver], 'sync');
  }));
  r.post('/chats/:peer/clear', auth, h(async (req, res) => {
    db.prepare('INSERT INTO chat_state(user_id,peer,cleared_at) VALUES (?,?,?) ON CONFLICT(user_id,peer) DO UPDATE SET cleared_at = excluded.cleared_at').run(req.user.id, req.params.peer, Date.now()); res.json({ ok: true }); rt.emit(req.user.id, 'sync');
  }));

  // ---- one call the app polls: relations, blocked, reports, new messages and notifications ----
  r.get('/sync', auth, h(async (req, res) => {
    const me = req.user; const msgRev = Number(req.query.msgRev) || 0, notifSeq = Number(req.query.notifSeq) || 0;
    const relations = [];
    for (const l of q.myLinks.all(me.id, me.id)) {
      const oid = l.a === me.id ? l.b : l.a; const o = store.getUser(oid); if (!o || o.banned || store.blockedEither(me.id, oid)) continue;
      relations.push({ id: oid, state: l.state === 'connected' ? 'connected' : l.requester === me.id ? 'sent' : 'incoming', profile: store.toPublic(o) });
    }
    const blocked = db.prepare('SELECT blocked FROM blocks WHERE blocker = ?').all(me.id).map((x) => store.getUser(x.blocked)).filter(Boolean).map((o) => ({ id: o.id, name: o.name || 'Someone', photo: store.toPublic(o).photo }));
    const reports = db.prepare('SELECT target AS id, reason, at FROM reports WHERE reporter = ?').all(me.id);
    const cleared = Object.fromEntries(db.prepare('SELECT peer, cleared_at FROM chat_state WHERE user_id = ?').all(me.id).map((x) => [x.peer, x.cleared_at]));
    const rows = db.prepare('SELECT * FROM messages WHERE rev > ? AND at > ? AND (sender = ? OR receiver = ?) ORDER BY rev ASC LIMIT 400').all(msgRev, Date.now() - cfg.messageTtlMs, me.id, me.id);
    const messages = rows.filter((m) => m.at > (cleared[m.sender === me.id ? m.receiver : m.sender] || 0)).map((m) => shapeMsg(m, me.id));
    const nrows = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT 100').all(me.id, notifSeq);
    res.json({
      serverTime: Date.now(), me: store.toMe(me), relations, blocked, reports, cleared, messages, more: rows.length === 400,
      msgRev: rows.length ? rows[rows.length - 1].rev : msgRev,
      notifications: nrows.map((n) => ({ seq: n.seq, kind: n.kind, icon: n.icon, t: n.text, to: n.target, at: n.at, pushed: !!n.pushed })),
      notifSeq: nrows.length ? nrows[nrows.length - 1].seq : notifSeq,
    });
  }));
  return r;
};
