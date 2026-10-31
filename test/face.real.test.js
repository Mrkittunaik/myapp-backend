// Optional: runs the real face model on photos you provide. Set FACE_FIXTURES to a folder containing
// one-face JPEGs named woman.jpg and man.jpg (your own test photos), then: FACE_FIXTURES=./fixtures npm test
process.env.NODE_ENV = 'test'; process.env.DEV_RETURN_CODES = '1'; process.env.JWT_SECRET = 'test-secret';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const fx = process.env.FACE_FIXTURES;
const skip = !fx || !fs.existsSync(path.join(fx, 'woman.jpg')) || !fs.existsSync(path.join(fx, 'man.jpg'));
const face = require('../src/face');

test('real model: finds one face, estimates gender and age', { skip, timeout: 120000 }, async () => {
  const w = await face.analyze(fs.readFileSync(path.join(fx, 'woman.jpg'))); const m = await face.analyze(fs.readFileSync(path.join(fx, 'man.jpg')));
  assert.equal(w.faces >= 1, true); assert.ok(w.female > 0.5, 'woman.jpg female=' + w.female); assert.ok(m.female < 0.5, 'man.jpg female=' + m.female);
  assert.ok(w.age > 10 && w.age < 90); assert.equal(w.descriptor.length, 128);
  // Same still photo five times: identity and gender pass, but the head-turn check must fail.
  const steps = ['center', 'left', 'right', 'up', 'down']; const five = [w, w, w, w, w];
  assert.ok(['center', 'liveness'].includes(face.evaluate(steps, five).reason)); // never passes without real movement
  const relaxed = face.evaluate(steps, five, { poseCheck: false }); assert.equal(relaxed.ok, true); assert.equal(relaxed.gender, 'Woman');
});
test('real model over HTTP with pose check off (dev switch)', { skip, timeout: 120000 }, async () => {
  process.env.FACE_POSE_CHECK = 'off'; delete require.cache[require.resolve('../src/config')];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearby-real-')); process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/app')]; const { createApp } = require('../src/app'); const a = createApp(dir);
  const server = await new Promise((r) => { const s = a.app.listen(0, () => r(s)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = async (m, p, o = {}) => { const r = await fetch(base + p, { method: m, headers: { ...(o.t ? { Authorization: 'Bearer ' + o.t } : {}), ...(o.b ? { 'Content-Type': 'application/json' } : {}) }, body: o.f || (o.b ? JSON.stringify(o.b) : undefined) }); return { status: r.status, ...(await r.json()) }; };
    for (const [file, gender] of [['woman.jpg', 'Woman'], ['man.jpg', 'Man']]) {
      const s = await j('POST', '/auth/signup', { b: { email: file + '@x.com', password: 'secret123' } }); await j('POST', '/auth/verify', { t: s.token, b: { code: s.devCode } });
      const st = await j('POST', '/face/start', { t: s.token }); const f = new FormData(); f.append('sessionId', st.sessionId);
      for (const _ of st.steps) f.append('frames', new Blob([fs.readFileSync(path.join(fx, file))]), 'f.jpg');
      const v = await j('POST', '/face/verify', { t: s.token, f }); assert.equal(v.status, 200, JSON.stringify(v)); assert.equal(v.face.gender, gender);
    }
  } finally { server.close(); a.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
