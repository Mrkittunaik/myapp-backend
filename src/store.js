// Domain helpers shared by the routes: users, public/private profile shapes, links, notifications, codes.
const crypto = require('crypto');
const cfg = require('./config');
const { pair } = require('./db');
const { ageFromDob, newId } = require('./util');
const { sendPush } = require('./push');

const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const abs = (p) => (p ? (/^https?:\/\//.test(p) ? p : cfg.publicUrl + p) : '');
const isQuiet = (prefs) => { if (!prefs?.quietHours) return false; const local = new Date(Date.now() - (Number(prefs.tz) || 0) * 60000); const hr = local.getUTCHours(); return hr >= 22 || hr < 7; };

module.exports = function makeStore(db, rt = { emit() {}, emitMany() {}, nearbyChanged() {}, kick() {}, broadcast() {} }) {
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    getLink: db.prepare('SELECT * FROM links WHERE a = ? AND b = ?'),
    putLink: db.prepare('INSERT INTO links(a,b,state,requester,at) VALUES (?,?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET state=excluded.state, requester=excluded.requester, at=excluded.at'),
    delLink: db.prepare('DELETE FROM links WHERE a = ? AND b = ?'),
    myLinks: db.prepare('SELECT * FROM links WHERE a = ? OR b = ?'),
    isBlocked: db.prepare('SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)'),
    insNotif: db.prepare('INSERT INTO notifications(user_id,kind,icon,text,target,at,pushed) VALUES (?,?,?,?,?,?,?)'),
  };
  const getUser = (id) => { const u = q.userById.get(id); return u && !u.deleted ? u : null; };
  const userByEmail = (e) => q.userByEmail.get(e) || null;

  const faceVerified = (u) => u.face_status === 'verified';
  const dobAge = (u) => ageFromDob(u.dob);
  const shownGender = (u) => (faceVerified(u) ? u.face_gender : u.gender_claimed || '');
  const shownAge = (u) => (faceVerified(u) && u.face_age ? u.face_age : dobAge(u) ?? undefined);
  const photosOf = (u) => J(u.photos, []).map(abs);

  // What other people may see. Never contains coordinates, email, date of birth or face data other than the result.
  const toPublic = (u) => {
    const photos = photosOf(u); const g = shownGender(u); const v = faceVerified(u);
    return {
      id: u.id, name: u.name || 'Someone', age: shownAge(u), ageEstimated: v, gender: g || undefined, verified: v,
      pronoun: v ? (g === 'Woman' ? 'she' : 'he') : undefined,
      bio: u.bio || '', photo: photos[0] || '', photos, interests: J(u.interests, []), intentions: J(u.intentions, []),
      languages: J(u.languages, []), socials: J(u.socials, []).filter((s) => s.visible),
    };
  };
  // What the owner sees about themselves.
  const toMe = (u) => ({
    id: u.id, email: u.email, emailVerified: !!u.email_verified, pendingEmail: u.pending_email || null,
    name: u.name, dob: u.dob, gender: shownGender(u) || '', bio: u.bio, photo: photosOf(u)[0] || '', photos: photosOf(u),
    interests: J(u.interests, []), intentions: J(u.intentions, []), languages: J(u.languages, []), socials: J(u.socials, []),
    visibility: u.visibility, interestedIn: u.interested_in, visible: !!u.visible, prefs: J(u.prefs, {}),
    face: { status: u.face_status, gender: u.face_gender || null, age: u.face_age || null, verifiedAt: u.face_at || null },
  });

  const relationFor = (viewer, other) => { const [a, b] = pair(viewer, other); const l = q.getLink.get(a, b); if (!l) return 'none'; if (l.state === 'connected') return 'connected'; return l.requester === viewer ? 'sent' : 'incoming'; };
  const blockedEither = (x, y) => !!q.isBlocked.get(x, y, y, x);

  function notify(userId, kind, icon, text, target, pushTitle) {
    const u = getUser(userId); if (!u) return;
    const prefs = J(u.prefs, {});
    if (kind !== 'system' && prefs[kind] === false) return; // person turned this kind off
    q.insNotif.run(userId, kind, icon, text, target, Date.now(), 0);
    const seq = db.prepare('SELECT last_insert_rowid() AS s').get().s;
    rt.emit(userId, 'sync'); // live: the open app fetches it at once
    if (u.push_token && !isQuiet(prefs)) {
      sendPush(u.push_token, { title: pushTitle || 'Nearby', body: text, channelId: kind, to: target })
        .then((ok) => { if (ok) db.prepare('UPDATE notifications SET pushed = 1 WHERE seq = ?').run(seq); }).catch(() => {});
    }
  }

  // Email codes: 6 digits, hashed at rest, 10 minutes, 5 wrong tries.
  const hashCode = (code, email, purpose) => crypto.createHmac('sha256', cfg.jwtSecret).update(`${code}|${email}|${purpose}`).digest('hex');
  function issueCode(email, purpose, userId) {
    db.prepare('DELETE FROM codes WHERE email = ? AND purpose = ?').run(email, purpose);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('INSERT INTO codes(email,purpose,hash,expires,user_id) VALUES (?,?,?,?,?)').run(email, purpose, hashCode(code, email, purpose), Date.now() + cfg.codeMinutes * 60000, userId || null);
    return code;
  }
  // consume=false lets the reset flow check a code on one screen and use it on the next.
  function checkCode(email, purpose, code, consume = true) {
    const row = db.prepare('SELECT * FROM codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(email, purpose);
    if (!row || row.expires < Date.now() || row.attempts >= 5) return false;
    const a = Buffer.from(row.hash), b = Buffer.from(hashCode(String(code || ''), email, purpose));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) { db.prepare('UPDATE codes SET attempts = attempts + 1 WHERE id = ?').run(row.id); return false; }
    if (consume) db.prepare('DELETE FROM codes WHERE id = ?').run(row.id);
    return true;
  }

  function deleteAccount(id) {
    const fs = require('fs'); const path = require('path');
    for (const f of db.prepare('SELECT name FROM uploads WHERE owner = ?').all(id)) fs.rm(path.join(cfg.dataDir, 'uploads', f.name), { force: true }, () => {});
    db.transaction(() => {
      db.prepare('DELETE FROM help_requests WHERE user_id = ? OR post_id IN (SELECT id FROM help_posts WHERE owner = ?)').run(id, id); db.prepare('DELETE FROM help_posts WHERE owner = ?').run(id);
      for (const t of ['links:a', 'links:b', 'blocks:blocker', 'blocks:blocked', 'reports:reporter', 'reports:target', 'messages:sender', 'messages:receiver', 'chat_state:user_id', 'chat_state:peer', 'notifications:user_id', 'uploads:owner', 'face_sessions:user_id', 'waves:a', 'waves:b', 'passes:viewer', 'passes:target', 'feedback:user_id', 'codes:user_id'].map((x) => x.split(':')))
        db.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} = ?`).run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
  }

  return { q, getUser, userByEmail, toPublic, toMe, relationFor, blockedEither, notify, issueCode, checkCode, deleteAccount, faceVerified, dobAge, shownGender, J, abs, newId };
};
