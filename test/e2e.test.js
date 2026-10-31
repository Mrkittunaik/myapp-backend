process.env.NODE_ENV = 'test'; process.env.DEV_RETURN_CODES = '1'; process.env.JWT_SECRET = 'test-secret';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const jpeg = require('jpeg-js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-')); process.env.DATA_DIR = dir; process.env.PUBLIC_URL = 'http://test.local';
const face = require('../src/face');
// Fake the ML step: each "photo" is a JSON blob carrying what the model would have measured.
face.analyze = async (buf) => JSON.parse(buf.toString());
const { createApp } = require('../src/app');

let base, server, db;
test.before(async () => { const a = createApp(dir); db = a.db; await new Promise((r) => { server = a.app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, p, { token, body, form } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const json = await res.json().catch(() => ({})); return { status: res.status, ...json };
};
const fr = (o = {}) => ({ faces: 1, crowded: false, size: 0.2, score: 0.99, female: 0.9, age: 26, descriptor: Array(128).fill(0), yaw: 0, pitch: 0.5, ...o });
const scan = async (token, who) => {
  const s = await call('POST', '/face/start', { token }); assert.equal(s.status, 200); assert.equal(s.steps[0], 'center');
  const f = new FormData(); f.append('sessionId', s.sessionId);
  for (const step of s.steps) f.append('frames', new Blob([JSON.stringify(fr({ ...who, yaw: step === 'left' ? -0.35 : step === 'right' ? 0.35 : 0, pitch: step === 'up' ? 0.58 : step === 'down' ? 0.42 : 0.5 }))]), 'f.jpg');
  return call('POST', '/face/verify', { token, form: f });
};
async function makeUser(email, who, name) {
  const s = await call('POST', '/auth/signup', { body: { email, password: 'secret123' } }); assert.equal(s.status, 201);
  assert.equal((await call('POST', '/auth/verify', { token: s.token, body: { code: s.devCode } })).status, 200);
  const v = await scan(s.token, who); assert.equal(v.status, 200, JSON.stringify(v));
  const p = await call('PUT', '/me', { token: s.token, body: { name, dob: '1998-05-01', interests: ['music'], intentions: ['friendship'] } }); assert.equal(p.status, 200);
  return { token: s.token, id: s.me.id };
}
let A, B;

test('health and auth basics', async () => {
  assert.equal((await call('GET', '/health')).ok, true);
  assert.equal((await call('POST', '/auth/signup', { body: { email: 'bad', password: 'secret123' } })).status, 400);
  assert.equal((await call('POST', '/auth/signup', { body: { email: 'x@y.com', password: 'short' } })).status, 400);
  const s = await call('POST', '/auth/signup', { body: { email: 'dup@x.com', password: 'secret123' } }); assert.equal(s.status, 201);
  assert.equal((await call('POST', '/auth/signup', { body: { email: 'DUP@x.com', password: 'secret123' } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'dup@x.com', password: 'wrongpass1' } })).status, 401);
  assert.equal((await call('POST', '/auth/verify', { token: s.token, body: { code: '000000' } })).status, 400);
  assert.equal((await call('GET', '/me')).status, 401);
});

test('email and face are required before nearby, messages and requests', async () => {
  const s = await call('POST', '/auth/signup', { body: { email: 'gate@x.com', password: 'secret123' } });
  assert.equal((await call('GET', '/nearby', { token: s.token })).code, 'email_required');
  await call('POST', '/auth/verify', { token: s.token, body: { code: s.devCode } });
  assert.equal((await call('GET', '/nearby', { token: s.token })).code, 'face_required');
  assert.equal((await call('POST', '/location', { token: s.token, body: { lat: 1, lng: 1 } })).code, 'face_required');
  assert.equal((await call('GET', '/me', { token: s.token })).me.face.status, 'none');
});

test('face scan: liveness, single use, verified result becomes the public gender and age', async () => {
  const s = await call('POST', '/auth/signup', { body: { email: 'live@x.com', password: 'secret123' } });
  await call('POST', '/auth/verify', { token: s.token, body: { code: s.devCode } });
  // A still photo shown five times must fail.
  const st = await call('POST', '/face/start', { token: s.token }); const f = new FormData(); f.append('sessionId', st.sessionId);
  for (let i = 0; i < 5; i++) f.append('frames', new Blob([JSON.stringify(fr())]), 'f.jpg');
  const bad = await call('POST', '/face/verify', { token: s.token, form: f }); assert.equal(bad.status, 422); assert.equal(bad.code, 'liveness');
  const again = new FormData(); again.append('sessionId', st.sessionId); for (let i = 0; i < 5; i++) again.append('frames', new Blob([JSON.stringify(fr())]), 'f.jpg');
  assert.equal((await call('POST', '/face/verify', { token: s.token, form: again })).code, 'session'); // session is single use
  const ok = await scan(s.token, { female: 0.03, age: 34 }); assert.equal(ok.status, 200);
  assert.deepEqual([ok.face.status, ok.face.gender, ok.face.age], ['verified', 'Man', 34]);
  // The person claimed "Woman" on the profile, but others see the verified result.
  await call('PUT', '/me', { token: s.token, body: { name: 'Sam', gender: 'Woman', dob: '1990-01-01' } });
  const me = (await call('GET', '/me', { token: s.token })).me; assert.equal(me.gender, 'Man');
});

test('profile rules: 18+ check, dob locked, photos must be uploaded first', async () => {
  const s = await call('POST', '/auth/signup', { body: { email: 'kid@x.com', password: 'secret123' } });
  const year = new Date().getUTCFullYear() - 15;
  assert.equal((await call('PUT', '/me', { token: s.token, body: { dob: `${year}-01-01` } })).code, 'underage');
  await call('PUT', '/me', { token: s.token, body: { dob: '1995-02-02', name: 'Ok Person' } });
  await call('PUT', '/me', { token: s.token, body: { dob: '2000-02-02' } });
  assert.equal((await call('GET', '/me', { token: s.token })).me.dob, '1995-02-02');
  assert.equal((await call('PUT', '/me', { token: s.token, body: { photos: ['http://evil.example/x.jpg'] } })).status, 400);
  const img = jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 80).data;
  const f = new FormData(); f.append('file', new Blob([img]), 'p.jpg'); const up = await call('POST', '/upload', { token: s.token, form: f });
  assert.equal(up.status, 201); assert.match(up.url, /^http:\/\/test\.local\/uploads\/[a-f0-9]{32}\.jpg$/);
  const bad = new FormData(); bad.append('file', new Blob(['<html>not an image</html>']), 'x.jpg'); assert.equal((await call('POST', '/upload', { token: s.token, form: bad })).status, 400);
  const saved = await call('PUT', '/me', { token: s.token, body: { photos: [up.url] } }); assert.equal(saved.me.photo, up.url);
  assert.equal((await fetch(up.url.replace('http://test.local', base))).status, 200);
});

test('nearby: exact distance and bearing, verified he/she and age, no coordinates leaked', async () => {
  A = await makeUser('a@x.com', { female: 0.95, age: 25 }, 'Alice'); B = await makeUser('b@x.com', { female: 0.04, age: 31 }, 'Bob');
  await call('POST', '/location', { token: B.token, body: { lat: 17.4000, lng: 78.4000 } });
  await call('POST', '/location', { token: A.token, body: { lat: 17.4001, lng: 78.4000 } }); // ~11 m north of B
  const n = await call('GET', '/nearby?radius=500', { token: A.token }); assert.equal(n.people.length, 1);
  const p = n.people[0]; assert.equal(p.name, 'Bob'); assert.equal(p.gender, 'Man'); assert.equal(p.pronoun, 'he'); assert.equal(p.age, 31); assert.equal(p.verified, true);
  assert.ok(p.distance > 9 && p.distance < 13, 'distance ' + p.distance); assert.ok(p.bearing > 170 && p.bearing < 190, 'bearing ' + p.bearing);
  assert.equal(p.lat, undefined); assert.equal(p.email, undefined); assert.equal(p.dob, undefined);
  assert.equal((await call('GET', '/nearby?radius=5', { token: A.token })).people.length, 0); // outside radius
  // Show me: Women filters Bob out
  await call('PUT', '/me', { token: A.token, body: { interestedIn: 'Women' } }); assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 0);
  await call('PUT', '/me', { token: A.token, body: { interestedIn: 'Everyone' } });
  // Hidden people disappear
  await call('POST', '/visibility', { token: B.token, body: { visible: false } }); assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 0);
  await call('POST', '/visibility', { token: B.token, body: { visible: true } }); assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 1);
  await call('PUT', '/me', { token: B.token, body: { visibility: 'nobody' } }); assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 0);
  await call('PUT', '/me', { token: B.token, body: { visibility: 'everyone' } });
});

test('connections, chat, notifications and sync', async () => {
  assert.equal((await call('POST', `/messages/${B.id}`, { token: A.token, body: { text: 'hi' } })).status, 403); // not connected yet
  assert.equal((await call('POST', `/connections/${B.id}/request`, { token: A.token })).state, 'sent');
  let sb = await call('GET', '/sync', { token: B.token });
  assert.equal(sb.relations.find((r) => r.id === A.id).state, 'incoming'); assert.ok(sb.notifications.some((x) => x.kind === 'requests' && /wants to connect/.test(x.t)));
  assert.equal((await call('GET', '/sync', { token: A.token })).relations.find((r) => r.id === B.id).state, 'sent');
  assert.equal((await call('POST', `/connections/${A.id}/accept`, { token: B.token })).state, 'connected');
  const m1 = await call('POST', `/messages/${B.id}`, { token: A.token, body: { id: 'client_id_0001', text: 'hello Bob' } }); assert.equal(m1.status, 201);
  assert.equal((await call('POST', `/messages/${B.id}`, { token: A.token, body: { id: 'client_id_0001', text: 'hello Bob' } })).message.id, 'client_id_0001'); // retry is idempotent
  sb = await call('GET', '/sync?msgRev=0&notifSeq=0', { token: B.token });
  assert.equal(sb.messages.length, 1); assert.equal(sb.messages[0].mine, false); assert.equal(sb.messages[0].peer, A.id); assert.equal(sb.messages[0].text, 'hello Bob');
  const next = await call('GET', `/sync?msgRev=${sb.msgRev}&notifSeq=${sb.notifSeq}`, { token: B.token }); assert.equal(next.messages.length, 0); assert.equal(next.notifications.length, 0);
  assert.equal((await call('DELETE', `/messages/${A.id}/client_id_0001`, { token: B.token })).status, 404); // only the sender can delete for everyone
  assert.equal((await call('DELETE', `/messages/${B.id}/client_id_0001`, { token: A.token })).status, 200);
  const after = await call('GET', `/sync?msgRev=${sb.msgRev}`, { token: B.token }); assert.equal(after.messages[0].deleted, true); assert.equal(after.messages[0].text, '');
  await call('POST', `/messages/${A.id}`, { token: B.token, body: { text: 'second' } });
  await call('POST', `/chats/${B.id}/clear`, { token: A.token }); assert.equal((await call('GET', '/sync', { token: A.token })).messages.length, 0);
  assert.equal((await call('GET', '/sync', { token: B.token })).messages.filter((m) => !m.deleted).length, 1); // the other person keeps their copy
  // block removes the connection and stops messages
  assert.equal((await call('POST', `/blocks/${A.id}`, { token: B.token })).status, 200);
  assert.equal((await call('POST', `/messages/${A.id}`, { token: B.token, body: { text: 'x' } })).status, 403);
  assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 0);
  const sa = await call('GET', '/sync', { token: A.token }); assert.equal(sa.relations.length, 0);
  assert.equal((await call('GET', '/sync', { token: B.token })).blocked[0].id, A.id);
  await call('DELETE', `/blocks/${A.id}`, { token: B.token }); assert.equal((await call('GET', '/sync', { token: B.token })).blocked.length, 0);
  assert.equal((await call('POST', '/reports', { token: A.token, body: { target: B.id, reason: 'Harassment or hate' } })).status, 200);
  assert.equal((await call('GET', '/nearby?radius=500', { token: A.token })).people.length, 0); // reported people stay hidden from the reporter
});

test('password reset, change password, change email', async () => {
  const f = await call('POST', '/auth/forgot', { body: { email: 'a@x.com' } }); assert.ok(f.devCode);
  assert.equal((await call('POST', '/auth/forgot', { body: { email: 'nobody@x.com' } })).devCode, undefined); // same answer, no code, for unknown emails
  assert.equal((await call('POST', '/auth/reset-check', { body: { email: 'a@x.com', code: '111111' } })).status, 400);
  assert.equal((await call('POST', '/auth/reset-check', { body: { email: 'a@x.com', code: f.devCode } })).ok, true);
  assert.equal((await call('POST', '/auth/reset', { body: { email: 'a@x.com', code: f.devCode, password: 'newpass456' } })).ok, true);
  assert.equal((await call('POST', '/auth/reset', { body: { email: 'a@x.com', code: f.devCode, password: 'newpass789' } })).status, 400); // code is single use
  assert.equal((await call('GET', '/me', { token: A.token })).status, 401); // old sessions are signed out
  const login = await call('POST', '/auth/login', { body: { email: 'a@x.com', password: 'newpass456' } }); assert.equal(login.status, 200); assert.equal(login.me.face.status, 'verified'); // face result survives reinstall/login
  const cp = await call('POST', '/auth/change-password', { token: login.token, body: { current: 'newpass456', next: 'another789' } }); assert.equal(cp.status, 200);
  assert.equal((await call('GET', '/me', { token: cp.token })).status, 200); assert.equal((await call('GET', '/me', { token: login.token })).status, 401);
  assert.equal((await call('POST', '/auth/change-password', { token: cp.token, body: { current: 'wrongpass1', next: 'another789' } })).status, 400);
  const ce = await call('POST', '/auth/change-email', { token: cp.token, body: { email: 'a2@x.com', password: 'another789' } }); assert.ok(ce.devCode);
  assert.equal((await call('POST', '/auth/verify', { token: cp.token, body: { code: ce.devCode } })).me.email, 'a2@x.com');
  A.token = cp.token;
});

test('export and delete account removes everything', async () => {
  const ex = await call('GET', '/export', { token: B.token }); assert.equal(ex.status, 200); assert.ok(ex.note.includes('Face photos are never stored'));
  assert.equal((await call('DELETE', '/me', { token: B.token })).status, 200);
  assert.equal((await call('GET', '/me', { token: B.token })).status, 401);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'b@x.com', password: 'secret123' } })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE sender = ? OR receiver = ?').get(B.id, B.id).c, 0);
});
