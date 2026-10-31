process.env.NODE_ENV = 'test'; process.env.DEV_RETURN_CODES = '1'; process.env.JWT_SECRET = 'test-secret'; process.env.ADMIN_TOKEN = 'admin-test-token-123';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-help-')); process.env.DATA_DIR = dir; process.env.PUBLIC_URL = 'http://test.local';
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
const mk = async (tag, who, name) => makeUser(`${tag}@help.com`, who, name);
const body = { category: 'companion', title: 'Need a friend for a wedding', body: 'Looking for a friendly person to come along to a family wedding on Saturday evening.', offer: 1500, pref: 'Anyone' };
let W, M1, M2, X;

test('help board: post rules, hidden poster, 2 free posts a month then coins coming soon', async () => {
  W = await mk('w', { female: 0.95, age: 26 }, 'Wendy'); M1 = await mk('m1', { female: 0.03, age: 30 }, 'Manu'); M2 = await mk('m2', { female: 0.03, age: 33 }, 'Mike'); X = await mk('x', { female: 0.95, age: 24 }, 'Xena');
  assert.equal((await call('POST', '/help', { token: W.token, body: { ...body, body: 'Call me on 98765 43210 for a fun time' } })).code, 'post_contact');
  assert.equal((await call('POST', '/help', { token: W.token, body: { ...body, title: 'Escort wanted tonight' } })).code, 'post_rules');
  const p1 = await call('POST', '/help', { token: W.token, body }); assert.equal(p1.status, 201); assert.equal(p1.quota.used, 1);
  assert.equal((await call('POST', '/help', { token: W.token, body: { ...body, category: 'rent', title: 'Room to share', offer: 0 } })).status, 201);
  const third = await call('POST', '/help', { token: W.token, body }); assert.equal(third.status, 402); assert.equal(third.code, 'post_limit'); assert.match(third.error, /Coins are coming soon/);
  const feed = await call('GET', '/help', { token: M1.token }); assert.equal(feed.posts.length, 2);
  const card = feed.posts.find((p) => p.category === 'companion'); const text = JSON.stringify(card);
  assert.ok(!text.includes(W.id) && !text.includes('Wendy') && !text.includes('photo'), 'poster identity stays hidden'); assert.deepEqual(card.poster, { gender: 'Woman', ageBand: '20s' });
  assert.equal((await call('GET', '/help', { token: W.token })).posts.length, 0, 'own posts are not in the feed');
  assert.equal((await call('GET', '/help?cat=rent', { token: M1.token })).posts.length, 1);
  W.postId = card.id;
});

test('help board: join requests, poster reviews profiles, accepting reveals her to that one person and opens chat', async () => {
  assert.equal((await call('POST', `/help/${W.postId}/request`, { token: M1.token, body: { note: 'Happy to help, I am free Saturday.' } })).status, 201);
  assert.equal((await call('POST', `/help/${W.postId}/request`, { token: M1.token, body: {} })).state, 'pending', 'a second request is not duplicated');
  assert.equal((await call('POST', `/help/${W.postId}/request`, { token: M2.token, body: { note: 'Call 9876543210' } })).code, 'post_contact');
  assert.equal((await call('POST', `/help/${W.postId}/request`, { token: M2.token, body: { note: 'I can come.' } })).status, 201);
  assert.equal((await call('POST', `/help/${W.postId}/request`, { token: W.token, body: {} })).status, 404, 'cannot ask for your own post');
  const mine = await call('GET', '/help/mine', { token: W.token }); assert.equal(mine.posts.find((p) => p.id === W.postId).pending, 2); assert.equal(mine.quota.used, 2);
  const list = await call('GET', `/help/mine/${W.postId}/requests`, { token: W.token }); assert.equal(list.requests.length, 2); assert.equal(list.requests[0].profile.name !== undefined, true);
  assert.equal((await call('GET', `/help/mine/${W.postId}/requests`, { token: M1.token })).status, 403, 'only the poster sees who asked');
  const before = await call('GET', '/help/requests', { token: M1.token }); assert.equal(before.requests[0].status, 'pending'); assert.equal(before.requests[0].poster, null, 'no reveal before accepting');
  const w = await listen(M1.token); w.ws.onclose = null;
  assert.equal((await call('POST', `/help/${W.postId}/accept`, { token: W.token, body: { userId: M1.id } })).state, 'connected');
  assert.ok(await until(() => w.got.includes('help') && w.got.includes('sync')), 'accepted person hears at once'); w.ws.close();
  const after = await call('GET', '/help/requests', { token: M1.token }); assert.equal(after.requests[0].status, 'accepted'); assert.equal(after.requests[0].poster.id, W.id); assert.equal(after.requests[0].poster.name, 'Wendy');
  const other = await call('GET', '/help/requests', { token: M2.token }); assert.equal(other.requests[0].status, 'closed'); assert.equal(other.requests[0].poster, null, 'others never see her');
  assert.equal((await call('POST', `/messages/${W.id}`, { token: M1.token, body: { text: 'Hi Wendy!' } })).status, 201, 'they can chat now');
  assert.equal((await call('POST', `/help/${W.postId}/accept`, { token: W.token, body: { userId: M2.id } })).status, 409, 'only one person is chosen');
  assert.equal((await call('GET', '/help', { token: M2.token })).posts.some((p) => p.id === W.postId), false, 'filled posts leave the feed');
});

test('help board: gender preference, decline, delete, report and ban', async () => {
  const onlyWomen = await call('POST', '/help', { token: X.token, body: { ...body, title: 'Shopping buddy', body: 'Want a female friend to go shopping with me on Sunday.', pref: 'Women' } }); assert.equal(onlyWomen.status, 201);
  assert.equal((await call('GET', '/help', { token: M1.token })).posts.some((p) => p.id === onlyWomen.post.id), false, 'men do not see women-only posts');
  assert.equal((await call('POST', `/help/${onlyWomen.post.id}/request`, { token: M1.token, body: {} })).status, 404);
  assert.equal((await call('GET', '/help', { token: W.token })).posts.some((p) => p.id === onlyWomen.post.id), true);
  await call('POST', `/help/${onlyWomen.post.id}/request`, { token: W.token, body: {} });
  assert.equal((await call('POST', `/help/${onlyWomen.post.id}/decline`, { token: X.token, body: { userId: W.id } })).ok, true);
  assert.equal((await call('POST', `/help/${onlyWomen.post.id}/request`, { token: W.token, body: {} })).status, 409, 'declined: no second try');
  assert.equal((await call('POST', `/help/${onlyWomen.post.id}/report`, { token: W.token, body: { reason: 'Fake profile or spam' } })).ok, true);
  assert.equal((await call('GET', '/help', { token: W.token })).posts.length, 0, 'a reported poster is hidden from the reporter');
  assert.equal((await call('DELETE', `/help/${onlyWomen.post.id}`, { token: X.token })).ok, true);
  assert.equal((await call('GET', '/help/mine', { token: X.token })).posts.length, 0);
  assert.equal((await call('POST', '/help', { token: X.token, body: { ...body, title: 'Another one', body: 'Second post of the month is fine to make.' } })).status, 201);
  assert.equal((await call('POST', '/help', { token: X.token, body })).status, 402, 'deleted posts still count this month');
});
