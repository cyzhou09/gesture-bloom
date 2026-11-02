/**
 * Node-only probe of the hand-tracking maths (no browser, no webcam).
 * Uses synthetic 21-landmark hands to verify the scale-normalised openness /
 * pinch maths, gesture hysteresis, mirrored output, hand-loss grace period,
 * and stop()-before-start() safety.
 *
 *   node qa/qa-hand-math.mjs
 */
import { HandTracker } from '../src/handTracking.js';
import assert from 'node:assert';

const aspect = 16 / 9;

/** Synthetic 21-landmark hand, raw (unmirrored) camera coordinates. */
function makeHand(kind) {
  const p = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  p[0] = { x: 0.5, y: 0.82, z: 0 };   // wrist
  p[5] = { x: 0.44, y: 0.62, z: 0 };  // index MCP
  p[9] = { x: 0.5, y: 0.6, z: 0 };    // middle MCP
  p[13] = { x: 0.56, y: 0.62, z: 0 }; // ring MCP
  p[17] = { x: 0.61, y: 0.66, z: 0 }; // pinky MCP
  p[1] = { x: 0.43, y: 0.78, z: 0 };
  p[2] = { x: 0.38, y: 0.74, z: 0 };
  p[3] = { x: 0.34, y: 0.7, z: 0 };
  p[4] = { x: 0.31, y: 0.67, z: 0 };  // thumb tip
  const straight = [
    [5, 6, 7, 8, 0.44, 0.62], [9, 10, 11, 12, 0.5, 0.6],
    [13, 14, 15, 16, 0.56, 0.62], [17, 18, 19, 20, 0.61, 0.66],
  ];
  const curled = [
    [5, 6, 7, 8, 0.44, 0.62, 0.475, 0.6], [9, 10, 11, 12, 0.5, 0.6, 0.525, 0.58],
    [13, 14, 15, 16, 0.56, 0.62, 0.545, 0.6], [17, 18, 19, 20, 0.61, 0.66, 0.575, 0.64],
  ];
  for (const [base, a, b, tip, bx, by, tx, ty] of (kind === 'open' ? straight : curled)) {
    if (kind === 'open') {
      p[a] = { x: bx, y: by - 0.1, z: 0 };
      p[b] = { x: bx, y: by - 0.19, z: 0 };
      p[tip] = { x: bx, y: by - 0.29, z: 0 };
    } else {
      // Curled: proximal up, then the chain folds back toward the palm.
      p[a] = { x: bx + 0.005, y: by - 0.06, z: 0.02 };
      p[b] = { x: bx + 0.02, y: by - 0.035, z: 0.04 };
      p[tip] = { x: tx, y: ty, z: 0.05 };
    }
  }
  return p;
}

function fakeTracker() {
  const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, pause() {}, srcObject: null };
  const overlay = { getContext: () => null, clientWidth: 0, clientHeight: 0, width: 0, height: 0 };
  return new HandTracker({ video, overlay });
}

const open = fakeTracker();
const fist = fakeTracker();
const openMetrics = open._computeMetrics(makeHand('open'), aspect);
const fistMetrics = fist._computeMetrics(makeHand('fist'), aspect);
console.log(`open openness=${openMetrics.openness.toFixed(3)} pinch=${openMetrics.pinch.toFixed(3)}`);
console.log(`fist openness=${fistMetrics.openness.toFixed(3)} pinch=${fistMetrics.pinch.toFixed(3)}`);
assert.ok(openMetrics.openness > 0.8, 'open palm openness should be > 0.8');
assert.ok(fistMetrics.openness < 0.24, 'fist openness should be < 0.24');
assert.equal(open._nextGesture('none', openMetrics.openness, openMetrics.pinch, open._fingerTarget), 'open');
assert.equal(fist._nextGesture('none', fistMetrics.openness, fistMetrics.pinch, fist._fingerTarget), 'fist');

// Full update() path: ingest and let smoothing settle (~15 frames / 240ms).
for (const tracker of [open, fist]) {
  tracker._running = true;
  tracker._landmarker = { detectForVideo: () => ({}) };
}
const t0 = 1000;
open._ingest(makeHand('open'), { handedness: [[{ categoryName: 'Right' }]] }, t0);
let snapOpen;
for (let i = 1; i <= 15; i += 1) snapOpen = open.update(t0 + i * 16, 0.016);
assert.equal(snapOpen.present, true);
assert.equal(snapOpen.gesture, 'open');
assert.equal(snapOpen.landmarks.length, 21);
assert.equal(snapOpen.tips.length, 5);
assert.ok(Math.abs(snapOpen.indexTip.x - 0.56) < 0.02, 'landmark x must be mirrored');
assert.equal(snapOpen.handedness, 'Right');
console.log(`settled open: gesture=${snapOpen.gesture} openness=${snapOpen.openness.toFixed(2)} indexTip.x=${snapOpen.indexTip.x.toFixed(2)} handedness=${snapOpen.handedness}`);

fist._ingest(makeHand('fist'), { handedness: [[{ categoryName: 'Right' }]] }, t0);
let snapFist;
for (let i = 1; i <= 15; i += 1) snapFist = fist.update(t0 + i * 16, 0.016);
assert.equal(snapFist.gesture, 'fist');
console.log(`settled fist: gesture=${snapFist.gesture} openness=${snapFist.openness.toFixed(2)}`);

// Hand-loss grace: present for <=400ms, released after.
// NOTE: update() intentionally returns the same reused snapshot object each
// frame (CONTRACT: "The object returned by update(); nested refs are stable"),
// so read fields immediately instead of retaining the reference.
const graceSnapshot = open.update(t0 + 300, 0.016);
const gracePresent = graceSnapshot.present;
const lostSnapshot = open.update(t0 + 401, 0.016);
const lostPresent = lostSnapshot.present;
assert.equal(graceSnapshot, lostSnapshot, 'expected the reused snapshot object (documented contract)');
assert.equal(gracePresent, true, 'hand retained during 400ms grace');
assert.equal(lostPresent, false, 'hand released after grace');
console.log(`grace: present@300ms=${gracePresent} present@401ms=${lostPresent} (snapshot object reused)`);

// stop() before start() is safe and idempotent; idle snapshots are contract-shaped.
const fresh = fakeTracker();
fresh.stop();
fresh.stop();
assert.equal(fresh.running, false);
const idle = fresh.update(5000, 0.016);
assert.equal(idle.present, false);
assert.equal(idle.gesture, 'none');
assert.equal(idle.landmarks, null);
console.log('stop-before-start idempotent; idle snapshot contract-shaped');

console.log('HAND_TRACKING_MATH_PROBE: PASS');
