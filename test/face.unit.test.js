process.env.NODE_ENV = 'test';
const test = require('node:test'); const assert = require('node:assert/strict');
const { evaluate } = require('../src/face');

const desc = (k = 0) => Array.from({ length: 128 }, (_, i) => (i === 0 ? k : 0));
const fr = (o = {}) => ({ faces: 1, crowded: false, size: 0.2, score: 0.99, female: 0.9, age: 26, descriptor: desc(), yaw: 0, pitch: 0.5, ...o });
const steps = ['center', 'left', 'right', 'up', 'down'];
const good = () => [fr(), fr({ yaw: -0.35 }), fr({ yaw: 0.35 }), fr({ pitch: 0.58 }), fr({ pitch: 0.42 })];

test('accepts a real head turn and reports gender and age', () => {
  const r = evaluate(steps, good()); assert.equal(r.ok, true); assert.equal(r.gender, 'Woman'); assert.equal(r.age, 26);
});
test('male result', () => { const r = evaluate(steps, good().map((f) => ({ ...f, female: 0.05, age: 41 }))); assert.equal(r.gender, 'Man'); assert.equal(r.age, 41); });
test('rejects a still photo shown five times (no head movement)', () => { const r = evaluate(steps, [fr(), fr(), fr(), fr(), fr()]); assert.equal(r.ok, false); assert.equal(r.reason, 'liveness'); });
test('rejects when both sides turn the same way', () => { const f = good(); f[2] = fr({ yaw: -0.4 }); assert.equal(evaluate(steps, f).reason, 'liveness'); });
test('rejects when up and down are the same', () => { const f = good(); f[4] = fr({ pitch: 0.58 }); assert.equal(evaluate(steps, f).reason, 'liveness'); });
test('rejects different people', () => { const f = good(); f[3] = fr({ pitch: 0.58, descriptor: desc(2) }); assert.equal(evaluate(steps, f).reason, 'different_person'); });
test('rejects missing face, two faces and a face that is too small', () => {
  let f = good(); f[1] = { faces: 0 }; assert.equal(evaluate(steps, f).reason, 'no_face');
  f = good(); f[0] = fr({ crowded: true }); assert.equal(evaluate(steps, f).reason, 'multiple');
  f = good(); f[0] = fr({ size: 0.01 }); assert.equal(evaluate(steps, f).reason, 'too_far');
});
test('unsure gender asks for a retry, very young age is rejected', () => {
  assert.equal(evaluate(steps, good().map((f) => ({ ...f, female: 0.55 }))).reason, 'unsure');
  const r = evaluate(steps, good().map((f) => ({ ...f, age: 12 }))); assert.equal(r.reason, 'underage'); assert.equal(r.status, 'rejected');
});
test('works with any step order the server picked', () => {
  const s = ['center', 'down', 'up', 'right', 'left']; const f = [fr(), fr({ pitch: 0.42 }), fr({ pitch: 0.58 }), fr({ yaw: 0.35 }), fr({ yaw: -0.35 })];
  assert.equal(evaluate(s, f).ok, true);
});
test('pose check can be switched off for tests only', () => { assert.equal(evaluate(steps, [fr(), fr(), fr(), fr(), fr()], { poseCheck: false }).ok, true); });
