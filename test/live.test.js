process.env.NODE_ENV = 'test'; process.env.DEV_RETURN_CODES = '1'; process.env.JWT_SECRET = 'test-secret'; process.env.ADMIN_TOKEN = 'admin-test-token-123';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-live-')); process.env.DATA_DIR = dir; process.env.PUBLIC_URL = 'http://test.local';
const face = require('../src/face'); face.analyze = async (buf) => JSON.parse(buf.toString());
const { createApp } = require('../src/app');
let base, server, db, rt, retention;
test.before(async () => { const a = createApp(dir); db = a.db; rt = a.rt; retention = a.retention; await new Promise((r) => { server = a.app.listen(0, r); }); rt.attach(server, a.store); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections?.(); server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const call = async (method, p, { token, body, form } = {}) => {
  const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};
const fr = (o = {}) => ({ faces: 1, crowded: false, size: 0.2, score: 0.99, female: 0.9, age: 26, descriptor: Array(128).fill(0), yaw: 0, pitch: 0.5, ...o });
const scan = async (token, who) => {
  const s = await call('POST', '/face/start', { token }); const f = new FormData(); f.append('sessionId', s.sessionId);
  for (const step of s.steps) f.append('frames', new Blob([JSON.stringify(fr({ ...who, yaw: step === 'left' ? -0.35 : step === 'right' ? 0.35 : 0, pitch: step === 'up' ? 0.58 : step === 'down' ? 0.42 : 0.5 }))]), 'f.jpg');
  return call('POST', '/face/verify', { token, form: f });
};
async function makeUser(email, who, name) {
  const s = await call('POST', '/auth/signup', { body: { email, password: 'secret123' } });
  await call('POST', '/auth/verify', { token: s.token, body: { code: s.devCode } });
  assert.equal((await scan(s.token, who)).status, 200);
  await call('PUT', '/me', { token: s.token, body: { name, dob: '1998-05-01', interests: ['music'], intentions: ['friendship'] } });
  return { token: s.token, id: s.me.id };
}
// Opens a socket and collects hints. Resolves once the server says "ready".
function listen(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws'); const got = [];
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'ready') resolve({ ws, got }); else if (m.t !== 'hb') got.push(m.t); };
    ws.onclose = (e) => reject(new Error('closed ' + e.code)); ws.onerror = () => {};
  });
}
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
let A, B;

test('live: a bad token is refused, a good one is accepted', async () => {
  A = await makeUser('a@live.com', { female: 0.03, age: 30 }, 'Alan'); B = await makeUser('b@live.com', { female: 0.95, age: 27 }, 'Beth');
  await assert.rejects(listen('nope'), /closed 4003/);
  const a = await listen(A.token); a.ws.onclose = null; a.ws.close();
});

test('live: request, accept, message and delete reach the other phone without polling', async () => {
  const a = await listen(A.token), b = await listen(B.token); a.ws.onclose = b.ws.onclose = null;
  await call('POST', `/connections/${B.id}/request`, { token: A.token, body: {} });
  assert.ok(await until(() => b.got.includes('sync')), 'B hears about the request');
  b.got.length = 0; a.got.length = 0;
  await call('POST', `/connections/${A.id}/accept`, { token: B.token, body: {} });
  assert.ok(await until(() => a.got.includes('sync')), 'A hears about the accept');
  b.got.length = 0;
  const m = await call('POST', `/messages/${B.id}`, { token: A.token, body: { id: 'msg_live_0001', text: 'hi' } }); assert.equal(m.status, 201);
  assert.ok(await until(() => b.got.includes('sync')), 'B hears about the message');
  b.got.length = 0;
  await call('DELETE', `/messages/${B.id}/msg_live_0001`, { token: A.token });
  assert.ok(await until(() => b.got.includes('sync')), 'B hears about the delete');
  a.ws.close(); b.ws.close();
});

test('live: moving tells people nearby, a still heartbeat does not', async () => {
  const b = await listen(B.token); b.ws.onclose = null;
  await call('POST', '/location', { token: B.token, body: { lat: 12.9716, lng: 77.5946 } });
  b.got.length = 0;
  await call('POST', '/location', { token: A.token, body: { lat: 12.9717, lng: 77.5946 } });
  assert.ok(await until(() => b.got.includes('nearby')), 'B hears that A appeared');
  b.got.length = 0; await new Promise((r) => setTimeout(r, 750));
  await call('POST', '/location', { token: A.token, body: { lat: 12.9717, lng: 77.5946 } });
  await new Promise((r) => setTimeout(r, 200)); assert.deepEqual(b.got, [], 'same spot: no hint');
  await call('POST', '/location', { token: A.token, body: { lat: 12.9719, lng: 77.5946 } });
  assert.ok(await until(() => b.got.includes('nearby')), 'moving 20 m: hint');
  b.ws.close();
});

test('messages: only the newest 10 are kept and anything older than 3 hours is deleted', async () => {
  db.prepare('DELETE FROM messages').run();
  for (let i = 0; i < 13; i++) assert.equal((await call('POST', `/messages/${B.id}`, { token: A.token, body: { id: 'keep_msg_' + String(i).padStart(2, '0'), text: 'm' + i } })).status, 201);
  let rows = db.prepare('SELECT text FROM messages ORDER BY at, rev').all(); assert.equal(rows.length, 10); assert.equal(rows[0].text, 'm3'); assert.equal(rows[9].text, 'm12');
  const s = await call('GET', '/sync?msgRev=0&notifSeq=0', { token: B.token }); assert.equal(s.messages.length, 10);
  db.prepare('UPDATE messages SET at = ? WHERE text IN (?, ?, ?)').run(Date.now() - 3 * 3600e3 - 1000, 'm3', 'm4', 'm5');
  assert.equal((await call('GET', '/sync?msgRev=0&notifSeq=0', { token: B.token })).messages.length, 7, 'expired ones are not served even before the sweep');
  assert.equal(retention.purge(), 3); assert.equal(db.prepare('SELECT COUNT(*) c FROM messages').get().c, 7);
  // Message notification texts are removed with the messages, and delete markers are purged after 10 minutes.
  db.prepare("UPDATE notifications SET at = ? WHERE kind = 'messages'").run(Date.now() - 3 * 3600e3 - 1000); retention.purge();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind = 'messages'").get().c, 0);
  // Deleted messages do not use a slot.
  await call('DELETE', `/messages/${B.id}/keep_msg_12`, { token: A.token });
  for (let i = 0; i < 4; i++) await call('POST', `/messages/${B.id}`, { token: A.token, body: { id: 'more_msg_' + i, text: 'n' + i } });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE deleted = 0').get().c, 10);
  const del = db.prepare("SELECT id FROM messages WHERE deleted = 1").get(); assert.ok(del);
  db.prepare('UPDATE messages SET deleted_at = ? WHERE deleted = 1').run(Date.now() - 11 * 60e3); retention.purge();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE deleted = 1').get().c, 0);
});

test('discover: age range, like sends the chat request, mutual like is a match, pass hides the card', async () => {
  const C = await makeUser('c@live.com', { female: 0.03, age: 27 }, 'Chris'), D = await makeUser('d@live.com', { female: 0.95, age: 29 }, 'Dina');
  const E = await makeUser('e@live.com', { female: 0.95, age: 45 }, 'Edna'), F = await makeUser('f@live.com', { female: 0.95, age: 30 }, 'Fay');
  const ids = async (u, q = 'ageMin=25&ageMax=35') => (await call('GET', '/discover?' + q, { token: u.token })).people.map((p) => p.id);
  let list = await ids(C); assert.ok(list.includes(D.id) && list.includes(F.id)); assert.ok(!list.includes(E.id), 'outside the age range'); assert.ok(!list.includes(C.id));
  assert.ok((await ids(C, 'ageMin=40&ageMax=50')).includes(E.id));
  const people = (await call('GET', '/discover?ageMin=25&ageMax=35', { token: C.token })).people; assert.equal(people[0].lat, undefined); assert.equal(people[0].email, undefined);
  const d = await listen(D.token); d.ws.onclose = null;
  const like = await call('POST', `/discover/${D.id}/like`, { token: C.token, body: {} }); assert.deepEqual([like.state, like.match], ['sent', false]);
  assert.ok(await until(() => d.got.includes('sync')), 'Dina is told at once');
  assert.ok(!(await ids(C)).includes(D.id), 'a liked person leaves the deck');
  const back = (await call('GET', '/discover?ageMin=25&ageMax=35', { token: D.token })).people; assert.equal(back[0].id, C.id); assert.equal(back[0].likedYou, true);
  const m = await call('POST', `/discover/${C.id}/like`, { token: D.token, body: {} }); assert.deepEqual([m.state, m.match], ['connected', true]);
  assert.equal((await call('POST', `/messages/${C.id}`, { token: D.token, body: { text: 'hey' } })).status, 201);
  assert.equal((await call('POST', `/discover/${F.id}/pass`, { token: C.token, body: {} })).ok, true); assert.ok(!(await ids(C)).includes(F.id));
  d.ws.close();
});

test('typing and read signals reach a connected peer only', async () => {
  const a = await listen(A.token), b = await listen(B.token); a.ws.onclose = b.ws.onclose = null;
  a.ws.onmessage = null; const seen = []; b.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'typing' || m.t === 'read') seen.push(m); };
  a.ws.send(JSON.stringify({ t: 'typing', to: B.id })); a.ws.send(JSON.stringify({ t: 'read', to: B.id }));
  assert.ok(await until(() => seen.length === 2)); assert.equal(seen[0].from, A.id);
  const G = await makeUser('g@live.com', { female: 0.95, age: 28 }, 'Gia'); const g = await listen(G.token); g.ws.onclose = null; const leak = []; g.ws.onmessage = (e) => leak.push(e.data);
  a.ws.send(JSON.stringify({ t: 'typing', to: G.id })); await new Promise((r) => setTimeout(r, 300)); assert.equal(leak.filter((x) => /typing/.test(x)).length, 0, 'not connected: no signal');
  a.ws.close(); b.ws.close(); g.ws.close();
});

test('admin: needs the token, reports are listed, a ban locks the person out everywhere', async () => {
  const adm = (m, p, body, tok = 'admin-test-token-123') => fetch(base + '/admin/api' + p, { method: m, headers: { 'x-admin-token': tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
  const H = await makeUser('h@live.com', { female: 0.95, age: 28 }, 'Hana');
  assert.equal((await adm('GET', '/reports', null, 'wrong')).status, 401);
  await call('POST', '/reports', { token: A.token, body: { target: H.id, reason: 'Fake profile or spam' } });
  const rep = await adm('GET', '/reports'); assert.equal(rep.status, 200); assert.equal(rep.people[0].id, H.id); assert.equal(rep.people[0].reports, 1);
  assert.equal((await fetch(base + '/admin')).status, 200);
  const hs = await listen(H.token); let closed = false; hs.ws.onclose = () => { closed = true; };
  assert.equal((await adm('POST', `/users/${H.id}/ban`, { reason: 'test' })).status, 200);
  assert.ok(await until(() => closed), 'live connection is cut');
  assert.equal((await call('GET', '/me', { token: H.token })).status, 401, 'old session is dead');
  assert.equal((await call('POST', '/auth/login', { body: { email: 'h@live.com', password: 'secret123' } })).code, 'banned');
  const C2 = await makeUser('c2@live.com', { female: 0.03, age: 28 }, 'Cal'); assert.ok(!(await call('GET', '/discover?ageMin=18&ageMax=60', { token: C2.token })).people.some((p) => p.id === H.id), 'banned people are not discoverable');
  assert.equal((await adm('POST', `/users/${H.id}/unban`)).status, 200); assert.equal((await call('POST', '/auth/login', { body: { email: 'h@live.com', password: 'secret123' } })).status, 200, 'unbanned: can log in again');
});
