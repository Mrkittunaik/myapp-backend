// Face verification: liveness (head turned left/right/up/down on request) + estimated gender and age.
// Runs fully on this server with face-api (TensorFlow.js WASM). Photos are processed in memory and never written to disk.
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const cfg = require('./config');

let faceapi = null, ready = null;
function init() {
  if (ready) return ready;
  ready = (async () => {
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    require('@tensorflow/tfjs');
    faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    wasm.setWasmPaths(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/dist/tf-backend-wasm.js')) + path.sep);
    await faceapi.tf.setBackend('wasm'); await faceapi.tf.ready();
    const dir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
    await Promise.all([faceapi.nets.ssdMobilenetv1, faceapi.nets.faceLandmark68Net, faceapi.nets.ageGenderNet, faceapi.nets.faceRecognitionNet].map((n) => n.loadFromDisk(dir)));
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// One image at a time: keeps CPU and memory predictable on a small server.
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

function decode(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) { const r = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 }); return { data: r.data, width: r.width, height: r.height, channels: 3 }; }
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) { const r = PNG.sync.read(buf); return { data: r.data, width: r.width, height: r.height, channels: 4 }; }
  throw new Error('unsupported image');
}

// Head pose from the 68 landmarks. Not exact degrees, but stable enough to tell "turned" from "straight".
//  yaw   : 0 facing the camera, about +-0.3 when turned ~30 degrees (sign depends on camera mirroring, so only the opposite-sign rule is used)
//  pitch : nose position between eye line and chin, compared with the straight-on frame
function poseOf(pts) {
  const x = (i) => pts[i].x, y = (i) => pts[i].y;
  const jaw = x(16) - x(0) || 1; const yaw = ((x(30) - x(0)) / jaw - 0.5) * 2;
  const eyeY = (y(36) + y(45)) / 2; const pitch = (y(30) - eyeY) / ((y(8) - eyeY) || 1);
  return { yaw, pitch };
}

async function analyze(buf) {
  await init();
  return serial(async () => {
    const img = decode(buf); const tf = faceapi.tf;
    const rgb = img.channels === 3 ? img.data : Uint8Array.from({ length: img.width * img.height * 3 }, (_, i) => img.data[Math.floor(i / 3) * 4 + (i % 3)]);
    let t = tf.tensor3d(rgb, [img.height, img.width, 3], 'int32');
    const maxSide = Math.max(img.width, img.height);
    if (maxSide > 640) { const k = 640 / maxSide; const r = tf.image.resizeBilinear(t, [Math.round(img.height * k), Math.round(img.width * k)]).toInt(); t.dispose(); t = r; }
    try {
      const all = await faceapi.detectAllFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 })).withFaceLandmarks().withAgeAndGender().withFaceDescriptors();
      if (!all.length) return { faces: 0 };
      const area = (f) => f.detection.box.width * f.detection.box.height;
      all.sort((a, b) => area(b) - area(a));
      const main = all[0];
      const imageArea = t.shape[0] * t.shape[1];
      return {
        faces: all.length, crowded: all.length > 1 && area(all[1]) > area(main) * 0.35,
        score: main.detection.score, size: area(main) / imageArea,
        female: main.gender === 'female' ? main.genderProbability : 1 - main.genderProbability, age: main.age,
        descriptor: Array.from(main.descriptor), ...poseOf(main.landmarks.positions),
      };
    } finally { t.dispose(); }
  });
}

const dist = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
const TURN = 0.16, STRAIGHT = 0.22, PITCH_DELTA = 0.045;

// Pure decision logic (unit tested). `steps` is the order the person was asked to follow, `frames[i]` the analysis of step i.
function evaluate(steps, frames, { poseCheck = true } = {}) {
  const fail = (reason, message) => ({ ok: false, reason, message });
  if (frames.length !== steps.length) return fail('frames', 'We need one photo for every step.');
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f || !f.faces) return fail('no_face', 'We could not see your face clearly. Use good light and keep your whole face in the circle.');
    if (f.crowded) return fail('multiple', 'Only one face should be in the camera.');
    if (f.size < 0.04) return fail('too_far', 'Move a little closer to the camera.');
  }
  const idx = (s) => steps.indexOf(s); const F = (s) => frames[idx(s)];
  const center = F('center'); if (!center) return fail('frames', 'Missing front photo.');
  if (poseCheck) {
    if (Math.abs(center.yaw) > STRAIGHT) return fail('center', 'Look straight at the camera for the first photo.');
    const l = F('left'), r = F('right'), u = F('up'), d = F('down');
    if (!l || !r || !u || !d) return fail('frames', 'Missing head-turn photos.');
    if (Math.abs(l.yaw) < TURN || Math.abs(r.yaw) < TURN || Math.sign(l.yaw) === Math.sign(r.yaw)) return fail('liveness', 'We could not see you turn your head left and right. Try again.');
    const du = u.pitch - center.pitch, dd = d.pitch - center.pitch;
    if (Math.abs(du) < PITCH_DELTA || Math.abs(dd) < PITCH_DELTA || Math.sign(du) === Math.sign(dd)) return fail('liveness', 'We could not see you look up and down. Try again.');
  }
  for (const f of frames) if (dist(f.descriptor, center.descriptor) > 0.7) return fail('different_person', 'The photos do not look like the same person. Try again alone, in good light.');
  // Straight-on frames carry the most weight: they are what the model was trained on.
  let wSum = 0, fSum = 0, aSum = 0;
  frames.forEach((f, i) => { const w = steps[i] === 'center' ? 3 : 1; wSum += w; fSum += w * f.female; aSum += w * f.age; });
  const female = fSum / wSum, age = Math.round(aSum / wSum);
  const confidence = Math.max(female, 1 - female);
  if (age < 16) return { ok: false, reason: 'underage', status: 'rejected', message: 'We could not confirm you meet the age requirement.' };
  if (confidence < 0.65) return fail('unsure', 'We could not tell clearly. Try again in better, even light without glasses or a hat.');
  return { ok: true, gender: female >= 0.5 ? 'Woman' : 'Man', age: Math.max(16, Math.min(80, age)), confidence: Math.round(confidence * 100) / 100 };
}

module.exports = { init, analyze, evaluate, poseOf };
