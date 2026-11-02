/**
 * flower.js — 指尖花 / Gesture Bloom
 *
 * A single `THREE.Points` cloud (~22k particles on "high") that lives as a
 * bioluminescent rose:
 *
 *   - closed  -> a tight, breathing teardrop bud
 *   - open    -> layered radial rose petals with a warm gold stamen core
 *
 * The bud -> bloom transition is fully GPU driven: every particle stores both
 * a bud position and a bloom position plus its own transition delay, so the
 * morph can be staggered / overshoot without touching the CPU per frame.
 * Colour, size, shimmer, orbital drift, breathing and fingertip interaction are
 * all evaluated in the vertex shader. `update()` only writes a handful of
 * uniforms, advances a 64-sample fingertip history for the comet trail and
 * eases the flower transform.
 *
 * Coordinate model (all positions below are the flower's *local* space):
 *
 *   - `+Z` is the flower normal (where the bloom faces). The whole frame is
 *     baked with a ~31° tilt so the open rose leans towards the camera and the
 *     teardrop bud leans up/forward — one shared orientation for both states.
 *   - `+X/+Y` span the bloom plane.
 *   - The bud is a surface of revolution around local Z, so it is literally
 *     the "closed" version of the same flower.
 *
 * Hand coordinates arrive normalized (0..1, already mirrored). This module
 * owns the normalized -> world -> local mapping; main.js never converts.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/* ------------------------------------------------------------------------- *
 * Palette
 * Stored as display-referred sRGB triplets: the custom shader writes straight
 * to the framebuffer, so these values are what the eye sees (no colour-space
 * conversion needed for a raw ShaderMaterial). Deep rose / copper petals, warm
 * gold core, mint-cyan highlights.
 * ------------------------------------------------------------------------- */

function sRGB(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

const PAL = {
  budDeep: sRGB(0x8a2550),
  budRose: sRGB(0xe46a92),
  budCopper: sRGB(0xefa06e),
  petalRose: sRGB(0xff6d95),
  petalCopper: sRGB(0xff9152),
  petalCream: sRGB(0xffdfbf),
  tipMint: sRGB(0x8dffdc),
  tipCyan: sRGB(0x66e4ff),
  coreGold: sRGB(0xffb43a),
  coreHot: sRGB(0xffe0a0),
  pollenGold: sRGB(0xffd98a),
  pollenMint: sRGB(0xaef7d8),
  dustTeal: sRGB(0x63d8c2),
  dustGold: sRGB(0xdcb678),
};

/* ------------------------------------------------------------------------- *
 * Tuning knobs
 * Everything here is safe to tweak. Rendering-side knobs that need to change
 * per frame are exposed as `field.uniforms` (see class).
 * ------------------------------------------------------------------------- */

const TUNING = {
  fov: 42,
  cameraNear: 0.1,
  cameraFar: 90,
  /** Outer bloom radius in world units (bud length is roughly the same). */
  flowerRadius: 2.62,
  /** Flower diameter as a fraction of the smaller viewport side. */
  fitDiameter: { wide: 0.74, mid: 0.78, narrow: 0.88 },
  /** Global additive brightness. Lower = more contrast, higher = more glow. */
  exposure: 1.55,
  /** Fingertip influence radius in world units. */
  tipRadius: 1.02,
  /** Bloom easing rate (1/s) and idle bloom oscillation. */
  bloomSmooth: 4.0,
  idleBloom: 0.37,
  idleBreath: 0.055,
  /** Whole-flower parallax towards the palm. */
  parallax: { yaw: 0.55, pitch: 0.4, shift: 0.3 },
  /**
   * Extra X tilt applied while the flower is closed: rotates the bud upright
   * so it reads as a teardrop instead of a foreshortened ball, then eases to
   * face the camera as it opens.
   */
  awakenTilt: 0.55,
  /** Comet trail peak opacity. */
  trailOpacity: 0.9,
};

/**
 * Quality tiers. `high`/`balanced` must stay >= 12k particles; `low` is the
 * mobile / weak-GPU fallback. DPR is capped per tier (hard cap 2 per contract).
 */
const TIERS = {
  high: { particles: 22000, trail: 72, dprCap: 2 },
  balanced: { particles: 14000, trail: 56, dprCap: 1.5 },
  low: { particles: 6000, trail: 36, dprCap: 1 },
};

/** Baseline particle count used to compensate point size on smaller tiers. */
const REFERENCE_PARTICLES = 22000;

/**
 * Rose whorls, outermost first. Particles are allocated by `share`; each whorl
 * spins by `offset` and drifts by `twist` along the petal, which is what makes
 * the layers read as a rose rather than a dartboard.
 */
const WHORLS = [
  { share: 0.3, petals: 8, rIn: 1.55, rOut: 2.55, z: -0.26, cup: 0.44, offset: 0.0, twist: 0.34 },
  { share: 0.25, petals: 7, rIn: 1.05, rOut: 1.98, z: 0.0, cup: 0.58, offset: 0.55, twist: 0.28 },
  { share: 0.19, petals: 6, rIn: 0.66, rOut: 1.45, z: 0.28, cup: 0.72, offset: 0.22, twist: 0.24 },
  { share: 0.13, petals: 5, rIn: 0.36, rOut: 1.0, z: 0.52, cup: 0.86, offset: 0.8, twist: 0.19 },
  { share: 0.08, petals: 4, rIn: 0.1, rOut: 0.62, z: 0.74, cup: 0.97, offset: 0.42, twist: 0.15 },
];

/** Teardrop bud profile: [s (0 base .. 1 tip), radius]. */
const BUD_PROFILE = [
  [0.0, 0.3], [0.07, 0.52], [0.16, 0.72], [0.28, 0.88], [0.42, 0.96],
  [0.56, 0.95], [0.68, 0.86], [0.78, 0.7], [0.87, 0.48], [0.94, 0.25],
  [0.985, 0.09], [1.0, 0.02],
];
const BUD_BASE = -1.45;
const BUD_LENGTH = 3.6;
/** Slim the teardrop profile so the bud stays slender after foreshortening. */
const BUD_RADIUS_SCALE = 0.86;

/** Frame tilt that turns the flower normal into an up-and-towards-camera axis. */
const ORIENT_ANGLE = -0.55;
const ORIENT_COS = Math.cos(ORIENT_ANGLE);
const ORIENT_SIN = Math.sin(ORIENT_ANGLE);

/* ------------------------------------------------------------------------- *
 * Small math helpers (pure, allocation free)
 * ------------------------------------------------------------------------- */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, v) {
  const t = clamp01((v - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic PRNG so the flower is identical on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setColor(out, rgb) {
  out[0] = rgb[0];
  out[1] = rgb[1];
  out[2] = rgb[2];
}

function mixColor(out, a, b, t) {
  const k = clamp01(t);
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
}

/** Radius of the teardrop bud at normalized height s (smooth profile lerp). */
function budRadiusAt(s) {
  const t = clamp01(s);
  for (let i = 1; i < BUD_PROFILE.length; i++) {
    const b = BUD_PROFILE[i];
    if (t <= b[0]) {
      const a = BUD_PROFILE[i - 1];
      const k = (t - a[0]) / Math.max(1e-5, b[0] - a[0]);
      const e = k * k * (3 - 2 * k);
      return (a[1] + (b[1] - a[1]) * e) * BUD_RADIUS_SCALE;
    }
  }
  return BUD_PROFILE[BUD_PROFILE.length - 1][1] * BUD_RADIUS_SCALE;
}

/**
 * Bake the shared flower-frame tilt. Local +Z (flower normal / bud axis) ends
 * up pointing up and towards the viewer, which is the flattering hero angle.
 */
function orient(x, y, z, out) {
  out[0] = x;
  out[1] = y * ORIENT_COS - z * ORIENT_SIN;
  out[2] = y * ORIENT_SIN + z * ORIENT_COS;
  return out;
}

/* ------------------------------------------------------------------------- *
 * Geometry builder
 *
 * Writes interleaved-by-attribute typed arrays once at construction. No
 * per-frame CPU particle work ever happens after this.
 * ------------------------------------------------------------------------- */

function buildParticleField(totalParticles) {
  const count = Math.max(2400, Math.round(totalParticles) || TIERS.balanced.particles);
  const rng = mulberry32(0x5eed1f);

  const dustCount = Math.min(Math.round(count * 0.02), 520);
  const pollenCount = Math.round(count * 0.06);
  const stamenCount = Math.round(count * 0.09);
  const petalCount = count - dustCount - pollenCount - stamenCount;

  // Fewer particles per tier -> slightly larger sprites so the flower keeps
  // the same visual density instead of turning sparse on mobile.
  const sizeScale = Math.sqrt(REFERENCE_PARTICLES / count);

  const positions = new Float32Array(count * 3);
  const bloomPositions = new Float32Array(count * 3);
  const colorA = new Float32Array(count * 3); // bud colours
  const colorB = new Float32Array(count * 3); // bloom colours
  const params = new Float32Array(count * 4); // size, delay, seed, kind
  const misc = new Float32Array(count * 2); // azimuth, alpha

  // Scratch state reused by every particle (no per-particle allocations).
  const bud = [0, 0, 0];
  const open = [0, 0, 0];
  const cA = [0, 0, 0];
  const cB = [0, 0, 0];
  const out = { size: 0, delay: 0, seed: 0, kind: 0, phi: 0, alpha: 0 };
  let cursor = 0;

  function commit() {
    const i = cursor++;
    const p3 = i * 3;
    positions[p3] = bud[0];
    positions[p3 + 1] = bud[1];
    positions[p3 + 2] = bud[2];
    bloomPositions[p3] = open[0];
    bloomPositions[p3 + 1] = open[1];
    bloomPositions[p3 + 2] = open[2];
    colorA[p3] = cA[0];
    colorA[p3 + 1] = cA[1];
    colorA[p3 + 2] = cA[2];
    colorB[p3] = cB[0];
    colorB[p3 + 1] = cB[1];
    colorB[p3 + 2] = cB[2];
    const p4 = i * 4;
    params[p4] = out.size;
    params[p4 + 1] = out.delay;
    params[p4 + 2] = out.seed;
    params[p4 + 3] = out.kind;
    const m2 = i * 2;
    misc[m2] = out.phi;
    misc[m2 + 1] = out.alpha;
  }

  /* ---- petals ---------------------------------------------------------- */
  // One descriptor per individual petal: a little random length / width / curl
  // so the bloom never looks procedurally perfect.
  const whorlPetals = WHORLS.map((whorl) => {
    const sector = TAU / whorl.petals;
    const petals = [];
    for (let k = 0; k < whorl.petals; k++) {
      petals.push({
        ang: k * sector + whorl.offset + (rng() - 0.5) * sector * 0.12,
        len: 1 + (rng() - 0.5) * 0.12,
        width: 1 + (rng() - 0.5) * 0.18,
        curl: (rng() - 0.5) * 0.07,
        zJit: (rng() - 0.5) * 0.06,
        tint: rng(),
      });
    }
    return petals;
  });

  const petalCounts = new Array(WHORLS.length).fill(0);
  const shareSum = WHORLS.reduce((acc, whorl) => acc + whorl.share, 0);
  let remaining = petalCount;
  for (let layer = 0; layer < WHORLS.length; layer++) {
    if (layer === WHORLS.length - 1) {
      petalCounts[layer] = remaining;
    } else {
      const n = Math.round((petalCount * WHORLS[layer].share) / shareSum);
      petalCounts[layer] = n;
      remaining -= n;
    }
  }

  for (let layer = 0; layer < WHORLS.length; layer++) {
    const whorl = WHORLS[layer];
    const petals = whorlPetals[layer];
    const n = petalCounts[layer];
    const sector = TAU / whorl.petals;
    const cup = whorl.cup;

    for (let m = 0; m < n; m++) {
      const petal = petals[(rng() * petals.length) | 0];

      // s: 0 at the petal root, ~0.96 at the (slightly blunted) tip.
      const s = 0.965 * Math.pow(rng(), 0.86);
      const v = rng() * 2 - 1; // -1..1 across the petal
      const outline = Math.pow(Math.sin(Math.PI * Math.min(1, s / 0.98)), 0.45);
      const halfAng = sector * 0.48 * petal.width * outline;

      const phi = petal.ang + v * halfAng + whorl.twist * s;
      const radius = (whorl.rIn + (whorl.rOut - whorl.rIn) * s) * petal.len;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      // Petal surface: cup the cross-section towards the viewer, reflex the tip
      // away, and add a soft ruffle along the edge.
      const z =
        whorl.z +
        petal.zJit +
        cup * 0.34 * (v * v) * (0.35 + 0.65 * s) -
        cup * 0.3 * Math.pow(s, 2.2) +
        cup * 0.09 * Math.sin(v * Math.PI * 2) * s +
        petal.curl * s;

      const jitterR = 1 + (rng() - 0.5) * 0.035;
      orient(
        cosPhi * radius * jitterR,
        sinPhi * radius * jitterR,
        z + (rng() - 0.5) * 0.035,
        open,
      );

      // The matching bud position: petal azimuth preserved so petals "unwrap"
      // from the bud instead of flying around it.
      const budS = clamp01(0.24 + layer * 0.09 + s * (0.76 - layer * 0.06));
      const budAng = phi + (rng() - 0.5) * 0.22;
      const budR = budRadiusAt(budS) * (0.66 + 0.34 * Math.sqrt(rng()));
      const ridge =
        1 + 0.07 * Math.cos(4 * (budAng - budS * 1.1)) + 0.04 * Math.cos(7 * budAng + budS * 3);
      const budZ = BUD_BASE + BUD_LENGTH * budS + (rng() - 0.5) * 0.03;
      orient(
        Math.cos(budAng) * budR * ridge,
        Math.sin(budAng) * budR * ridge,
        budZ,
        bud,
      );

      /* colours: saturated rose/copper silk, bright rims, mint tips */
      const edge = Math.abs(v);
      // Mint/cream accents belong to the outer petals; the innermost whorls stay
      // warm so the heart does not turn into a white ring.
      const accent = layer <= 1 ? 1 : layer === 2 ? 0.8 : 0.4;
      mixColor(
        cB,
        PAL.petalRose,
        PAL.petalCopper,
        clamp01(0.12 + 0.42 * s + (petal.tint - 0.5) * 0.55),
      );
      // Bright rim just inside the edge plus a slightly deeper extreme edge:
      // that bright/dark pair draws a crisp petal outline in additive light.
      const rim = smoothstep(0.7, 0.93, edge) * (0.55 + 0.45 * s) * accent;
      mixColor(cB, cB, PAL.petalCream, rim * 0.45);
      const edgeDeep = smoothstep(0.94, 1, edge) * (0.2 + 0.3 * s);
      mixColor(cB, cB, PAL.budDeep, edgeDeep);
      const mintAmount =
        smoothstep(0.66, 1, s) * (0.5 + 0.5 * edge) * (petal.tint > 0.5 ? 1 : 0.4) * accent;
      mixColor(cB, cB, petal.tint > 0.72 ? PAL.tipCyan : PAL.tipMint, mintAmount * 0.9);
      if (edge < 0.18) mixColor(cB, cB, PAL.petalCream, 0.16); // midrib
      // Slightly deeper petal roots so each whorl reads against the next.
      mixColor(cB, cB, PAL.budDeep, (1 - smoothstep(0.02, 0.28, s)) * 0.32);

      mixColor(cA, PAL.budDeep, PAL.budRose, 0.12 + 0.72 * s);
      mixColor(cA, cA, PAL.budCopper, Math.pow(s, 1.7) * 0.62 * clamp01(petal.tint + 0.2));
      // Keep the bud nose rose-copper: only a rare warm spark, never a white cap.
      if (s > 0.95 && petal.tint > 0.86) mixColor(cA, cA, PAL.coreGold, 0.25);
      mixColor(cA, cA, PAL.budDeep, smoothstep(0.985, 1, s) * 0.25);

      // Longitudinal bud seams: the ridge pattern also modulates alpha so the
      // closed bud shows wrapped-petal structure instead of a smooth ball.
      const ridgeAlpha = 0.9 + 0.22 * Math.cos(4 * budAng + budS * 6);
      out.size =
        (0.036 + 0.042 * s + rim * 0.008 + mintAmount * 0.006) *
        (0.85 + 0.3 * rng()) *
        sizeScale;
      out.delay = clamp(0.05 + layer * 0.1 + (1 - s) * 0.05 + rng() * 0.14, 0, 0.8);
      out.seed = rng();
      out.kind = 0;
      out.phi = ((phi % TAU) + TAU) % TAU;
      out.alpha = clamp01(
        (0.22 + 0.34 * s + rim * 0.14 + (edge > 0.94 ? 0.05 : 0) + (edge < 0.18 ? 0.04 : 0)) *
          ridgeAlpha,
      );
      commit();
    }
  }

  /* ---- stamen / core --------------------------------------------------- */
  for (let m = 0; m < stamenCount; m++) {
    // Dense golden dome in the middle, plus a few longer filaments. It sits in
    // front of the innermost petals so the warm heart always reads.
    const filament = rng() < 0.14;
    const rr = filament ? 0.32 + rng() * 0.3 : 0.44 * Math.pow(rng(), 0.6);
    const th = rng() * TAU;
    const dome = Math.sqrt(Math.max(0, 1 - Math.pow(rr / 0.46, 2)));
    const z = filament
      ? 1.0 + (rng() - 0.5) * 0.22
      : 0.82 + 0.26 * dome + (rng() - 0.5) * 0.05;
    orient(Math.cos(th) * rr, Math.sin(th) * rr, z, open);

    const budS = 0.45 + rng() * 0.45;
    const budR = budRadiusAt(budS) * (0.15 + 0.35 * rng());
    const bth = rng() * TAU;
    orient(
      Math.cos(bth) * budR,
      Math.sin(bth) * budR,
      BUD_BASE + BUD_LENGTH * budS,
      bud,
    );

    const hot = clamp01(1 - rr / 0.46);
    mixColor(cB, PAL.coreGold, PAL.coreHot, 0.02 + 0.18 * hot + (rng() - 0.5) * 0.06);
    mixColor(cA, PAL.budCopper, PAL.coreGold, 0.35 + 0.45 * hot);

    out.size = (0.014 + 0.014 * rng() + 0.006 * hot) * sizeScale;
    out.delay = 0.32 + rng() * 0.34;
    out.seed = rng();
    out.kind = 1;
    out.phi = th;
    out.alpha = 0.34 + 0.16 * hot;
    commit();
  }

  /* ---- pollen / bright specks ----------------------------------------- */
  for (let m = 0; m < pollenCount; m++) {
    const central = rng() < 0.24;
    const rr = central ? 0.15 + rng() * 0.6 : 0.5 + Math.pow(rng(), 0.65) * 2.3;
    const th = rng() * TAU;
    const z = central ? 0.7 + rng() * 0.5 : 0.0 + rng() * 1.3;
    orient(Math.cos(th) * rr, Math.sin(th) * rr, z, open);

    const budS = 0.3 + rng() * 0.65;
    const budR = budRadiusAt(budS) * (0.15 + 0.7 * rng());
    const bth = rng() * TAU;
    orient(
      Math.cos(bth) * budR,
      Math.sin(bth) * budR,
      BUD_BASE + BUD_LENGTH * budS,
      bud,
    );

    const bright = rng() < 0.07;
    const minty = rng() < 0.45;
    const target = minty ? PAL.pollenMint : PAL.pollenGold;
    mixColor(cB, PAL.pollenGold, target, 0.35 + rng() * 0.65);
    mixColor(cA, PAL.budCopper, PAL.coreGold, 0.3 + rng() * 0.5);

    out.size = (bright ? 0.042 + rng() * 0.024 : 0.014 + Math.pow(rng(), 1.5) * 0.032) * sizeScale;
    out.delay = 0.32 + rng() * 0.44;
    out.seed = rng();
    out.kind = 2;
    out.phi = th;
    out.alpha = bright ? 0.72 : 0.42 + rng() * 0.32;
    commit();
  }

  /* ---- ambient dust / bokeh ------------------------------------------- */
  // Shares the same draw call as the flower: additive blending makes the order
  // irrelevant, so the dust can live in the same vertex buffer for free.
  for (let m = 0; m < dustCount; m++) {
    const radius = 3.0 + Math.pow(rng(), 0.55) * 6.0;
    const th = rng() * TAU;
    const elev = rng() * 2 - 1;
    const planar = Math.sqrt(Math.max(0, 1 - elev * elev));
    const x = Math.cos(th) * radius * planar;
    const y = elev * radius * 0.55;
    const z = Math.sin(th) * radius * planar - 1.2;
    open[0] = x;
    open[1] = y;
    open[2] = z;
    bud[0] = x;
    bud[1] = y;
    bud[2] = z;

    const gold = rng() < 0.38;
    mixColor(cA, gold ? PAL.dustGold : PAL.dustTeal, PAL.pollenGold, 0.12 + rng() * 0.2);
    setColor(cB, cA);

    out.size = (0.007 + Math.pow(rng(), 1.9) * 0.026) * (0.85 + 0.15 * sizeScale);
    out.delay = 0;
    out.seed = rng();
    out.kind = 3;
    out.phi = th;
    out.alpha = 0.02 + rng() * 0.05;
    commit();
  }

  // `commit` must have written exactly `count` particles.
  if (cursor !== count) throw new Error(`FlowerField: particle count mismatch (${cursor}/${count})`);

  return { count, positions, bloomPositions, colorA, colorB, params, misc };
}

/* ------------------------------------------------------------------------- *
 * Shaders
 * ------------------------------------------------------------------------- */

const FLOWER_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uPixelScale;
  uniform vec3  uTipPos;
  uniform float uTipActive;
  uniform float uTipEnergy;
  uniform float uTipRadius;
  uniform float uSpark;

  attribute vec3 aBloomPos;
  attribute vec3 aColorA;
  attribute vec3 aColorB;
  attribute vec4 aParams;   // x: base size, y: morph delay, z: seed, w: kind
  attribute vec2 aMisc;     // x: azimuth, y: alpha

  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  const float PI = 3.141592653589793;

  void main() {
    float seed = aParams.z;
    float kind = aParams.w;
    float delay = aParams.y;
    float ph = seed * PI * 2.0;

    // ---- staggered bud -> bloom morph -------------------------------
    // Each particle waits for its own delay, then eases over the remainder of
    // the bloom range. sin(PI * t) gives a free radial overshoot bump.
    float t = clamp((uBloom - delay) / max(0.02, 1.0 - delay), 0.0, 1.0);
    float isDust = step(2.5, kind);
    t *= 1.0 - isDust;
    float e = t * t * (3.0 - 2.0 * t);
    float over = sin(PI * t);

    vec3 p = mix(position, aBloomPos, e);
    p.xy *= 1.0 + over * 0.055 * (0.4 + seed);
    p.y += over * 0.06 * (seed - 0.5);

    // ---- living motion (pure GPU, no CPU particle updates) ----------
    float breathe = 1.0 + 0.013 * sin(uTime * 0.72 + ph)
                          + 0.010 * uBloom * sin(uTime * 2.05);
    p.xy *= breathe;

    float flutter = sin(uTime * 1.25 + ph * 3.1 + length(p.xy) * 2.4);
    p.z += flutter * 0.020 * (0.35 + e);
    p.y += sin(uTime * 0.83 + ph * 2.0) * 0.010;

    // loose pollen and dust wander more widely than petals
    float wander = mix(0.022, 0.20, smoothstep(1.5, 2.5, kind));
    float wa = uTime * 0.34 + ph;
    p.xy += vec2(cos(wa), sin(wa * 1.27)) * wander * (0.4 + 0.6 * e);
    p.z += sin(wa * 0.93) * wander * 0.8;

    // ---- fingertip influence ----------------------------------------
    vec2 dxy = p.xy - uTipPos.xy;
    float dTip = length(dxy);
    vec2 dir = dxy / max(dTip, 1e-3);
    float near = 1.0 - smoothstep(uTipRadius * 0.24, uTipRadius, dTip);
    near *= uTipActive * (1.0 - isDust);

    // petals lean towards the fingertip, with a little swirl...
    p.xy -= dir * near * 0.16 * uTipEnergy;
    p.xy += vec2(-dir.y, dir.x) * near * 0.070 * uTipEnergy;
    p.z += near * 0.18 * uTipEnergy;
    // ...and a soft push right under it so the petal never collapses onto it
    float core = (1.0 - smoothstep(0.0, uTipRadius * 0.30, dTip)) * uTipActive * (1.0 - isDust);
    p.xy += dir * core * 0.10;
    p.z += core * 0.04;

    float shimmer = near * (0.55 + 0.45 * sin(uTime * 10.5 + ph * 9.0 + aMisc.x * 2.0));

    // ---- colour ------------------------------------------------------
    vec3 col = mix(aColorA, aColorB, e);
    float twinkle = 0.80 + 0.20 * sin(uTime * (0.9 + seed * 1.9) + ph * 12.0);
    col *= twinkle;
    col *= 1.0 + 0.55 * shimmer + 0.30 * uSpark;
    col *= mix(0.78, 1.15, uBloom);
    col *= 0.95 + 0.08 * sin(length(p.xy) * 1.6 - uTime * 1.05 + aMisc.x);
    vHot = shimmer;
    vColor = col;

    // ---- point size ---------------------------------------------------
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float viewDist = max(0.35, -mv.z);
    float size = aParams.x * (0.78 + 0.44 * seed);
    size *= 1.0 + 0.42 * shimmer + 0.22 * uSpark;
    size = clamp(size, 0.006, 0.16);
    gl_PointSize = clamp(size * uPixelScale / viewDist, 1.0, 72.0);
    gl_Position = projectionMatrix * mv;

    vAlpha = aMisc.y * mix(1.0, 1.2, e) * (0.78 + 0.22 * twinkle) * (1.0 + 0.55 * shimmer);
  }
`;

const FLOWER_FRAGMENT = /* glsl */ `
  uniform float uExposure;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d2 = dot(q, q);
    if (d2 > 0.25) discard;              // soft round sprite, no texture needed
    float r = sqrt(clamp(d2 * 4.0, 0.0, 1.0));
    float glow = pow(max(0.0, 1.0 - r), 1.8);
    float core = pow(max(0.0, 1.0 - r), 6.0);
    // Additive glow over a transparent canvas: output straight colour with the
    // intensity as alpha. The browser then composites premultiplied
    // (rgb + background * (1 - alpha)), so dim particles stay translucent
    // instead of punching dark holes into the CSS backdrop.
    float a = min(1.0, (glow * 0.85 + core * 0.55) * vAlpha * uExposure);
    vec3 col = vColor * (0.82 + 0.22 * core + 0.08 * vHot);
    gl_FragColor = vec4(col, a);
  }
`;

const TRAIL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelScale;
  uniform float uOpacity;
  uniform float uSpeed;

  attribute float aAge;    // 0 at the fingertip, 1 at the tail
  attribute float aSeed;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float viewDist = max(0.4, -mv.z);
    float size = mix(0.20, 0.012, pow(aAge, 0.55));
    size *= 1.0 + uSpeed * 0.35;
    gl_PointSize = clamp(size * uPixelScale / viewDist, 1.0, 90.0);
    gl_Position = projectionMatrix * mv;

    float fade = pow(max(0.0, 1.0 - aAge), 1.9);
    float flicker = 0.72 + 0.28 * sin(uTime * 7.0 + aSeed * 6.283 + aAge * 8.0);
    vAlpha = fade * uOpacity * flicker;
    vColor = mix(vec3(1.00, 0.74, 0.40), vec3(0.44, 0.94, 0.82), pow(aAge, 0.65));
  }
`;

const TRAIL_FRAGMENT = /* glsl */ `
  uniform float uExposure;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d2 = dot(q, q);
    if (d2 > 0.25) discard;
    float r = sqrt(clamp(d2 * 4.0, 0.0, 1.0));
    float a = min(1.0, pow(max(0.0, 1.0 - r), 2.8) * vAlpha * uExposure);
    gl_FragColor = vec4(vColor, a);
  }
`;

/* ------------------------------------------------------------------------- *
 * Quality selection
 * ------------------------------------------------------------------------- */

function detectQuality() {
  let userAgent = '';
  let cores = 4;
  let memory = 8;
  try {
    if (typeof navigator !== 'undefined') {
      userAgent = navigator.userAgent || '';
      cores = navigator.hardwareConcurrency || cores;
      memory = navigator.deviceMemory || memory;
    }
  } catch (_) {
    /* navigator can be unavailable in exotic embeddings — fall back below */
  }
  const mobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobile|Silk|Kindle/i.test(userAgent);
  if (mobile || cores <= 2 || memory <= 2) return 'low';
  if (cores >= 8 && memory >= 8) return 'high';
  return 'balanced';
}

function resolveQuality(requested) {
  if (requested === 'high' || requested === 'balanced' || requested === 'low') return requested;
  return detectQuality();
}

/* ------------------------------------------------------------------------- *
 * FlowerField
 * ------------------------------------------------------------------------- */

export class FlowerField {
  /**
   * @param {HTMLCanvasElement} canvas full viewport canvas (#scene)
   * @param {{quality?: 'high'|'balanced'|'low'}} [options]
   */
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('FlowerField: a <canvas> element is required');

    this._canvas = canvas;
    this._disposed = false;
    this._quality = resolveQuality(options.quality);
    const tier = TIERS[this._quality];
    this._dprCap = tier.dprCap;
    this._particleCount = tier.particles;
    this._trailCount = tier.trail;
    this._historyLength = this._trailCount + 12;

    /* --- renderer / scene / camera ---------------------------------- */
    this._renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // additive points + DPR 2 do not need MSAA
      alpha: true, // let the CSS aurora / vignette show through
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this._renderer.setClearColor(0x000000, 0);
    this._renderer.setPixelRatio(1);
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;

    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(TUNING.fov, 1, TUNING.cameraNear, TUNING.cameraFar);
    this._camera.position.set(0, 0.6, 10);
    this._camera.lookAt(0, 0, 0);

    this._group = new THREE.Group();
    this._scene.add(this._group);

    /* --- flower geometry -------------------------------------------- */
    const field = buildParticleField(this._particleCount);
    this._particleCount = field.count;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(field.positions, 3));
    geometry.setAttribute('aBloomPos', new THREE.BufferAttribute(field.bloomPositions, 3));
    geometry.setAttribute('aColorA', new THREE.BufferAttribute(field.colorA, 3));
    geometry.setAttribute('aColorB', new THREE.BufferAttribute(field.colorB, 3));
    geometry.setAttribute('aParams', new THREE.BufferAttribute(field.params, 4));
    geometry.setAttribute('aMisc', new THREE.BufferAttribute(field.misc, 2));
    this._flowerGeometry = geometry;

    this._uniforms = {
      uTime: { value: 0 },
      uBloom: { value: TUNING.idleBloom },
      uPixelScale: { value: 1 },
      uTipPos: { value: new THREE.Vector3(0, 0, 0) },
      uTipActive: { value: 0 },
      uTipEnergy: { value: 0 },
      uTipRadius: { value: TUNING.tipRadius },
      uSpark: { value: 0 },
      uExposure: { value: TUNING.exposure },
    };

    this._flowerMaterial = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: FLOWER_VERTEX,
      fragmentShader: FLOWER_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    this._flower = new THREE.Points(geometry, this._flowerMaterial);
    this._flower.frustumCulled = false; // bloom reaches far outside the bud bounds
    this._flower.renderOrder = 1;
    this._group.add(this._flower);

    /* --- fingertip comet trail (second, tiny draw call) -------------- */
    this._trailGeometry = new THREE.BufferGeometry();
    this._trailPositions = new Float32Array(this._trailCount * 3);
    const trailAge = new Float32Array(this._trailCount);
    const trailSeed = new Float32Array(this._trailCount);
    for (let i = 0; i < this._trailCount; i++) {
      trailAge[i] = this._trailCount > 1 ? i / (this._trailCount - 1) : 0;
      trailSeed[i] = Math.random();
    }
    const trailPosAttr = new THREE.BufferAttribute(this._trailPositions, 3);
    trailPosAttr.setUsage(THREE.DynamicDrawUsage);
    this._trailGeometry.setAttribute('position', trailPosAttr);
    this._trailGeometry.setAttribute('aAge', new THREE.BufferAttribute(trailAge, 1));
    this._trailGeometry.setAttribute('aSeed', new THREE.BufferAttribute(trailSeed, 1));

    this._trailUniforms = {
      uTime: { value: 0 },
      uPixelScale: { value: 1 },
      uOpacity: { value: 0 },
      uSpeed: { value: 0 },
      uExposure: { value: TUNING.exposure },
    };
    this._trailMaterial = new THREE.ShaderMaterial({
      uniforms: this._trailUniforms,
      vertexShader: TRAIL_VERTEX,
      fragmentShader: TRAIL_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this._trail = new THREE.Points(this._trailGeometry, this._trailMaterial);
    this._trail.frustumCulled = false;
    this._trail.renderOrder = 2;
    this._scene.add(this._trail);

    /* --- animation state -------------------------------------------- */
    this._clock = 0;
    this._bloom = TUNING.idleBloom;
    this._spark = 0;
    this._tipActive = 0;
    this._tipEnergy = 0;
    this._speed = 0;
    this._trailOpacity = 0;
    this._hasTip = false;
    this._hasPrevTips = false;

    this._tipWorld = new THREE.Vector3(0, 0, 0.7);
    this._tipSmooth = new THREE.Vector3(0, 0, 0.7);
    this._tipLocal = new THREE.Vector3(0, 0, 0);
    this._prevTips = new Float32Array(10);

    this._history = new Float32Array(this._historyLength * 3);
    this._historyHead = 0;
    this._historyFilled = 0;

    this._rotX = 0;
    this._rotY = 0;
    this._rotZ = 0;
    this._posX = 0;
    this._posY = 0;

    /* --- size -------------------------------------------------------- */
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const dpr = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
    this.resize(cssWidth, cssHeight, dpr);

    // Public read-only-ish surface for the Lead/QA: live uniforms for tuning.
    this.uniforms = this._uniforms;
    this.trailUniforms = this._trailUniforms;
  }

  /* ---------------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------------- */

  /** Resize renderer/camera and point-size uniform. Called by main on resize. */
  resize(width, height, dpr) {
    if (this._disposed) return;
    const w = Math.max(1, Math.floor(width || 0));
    const h = Math.max(1, Math.floor(height || 0));
    const ratio = Math.min(this._dprCap, Math.max(1, Number(dpr) || 1));

    this._width = w;
    this._height = h;
    this._aspect = w / h;

    this._renderer.setPixelRatio(ratio);
    this._renderer.setSize(w, h, false); // CSS size stays owned by the page

    this._camera.aspect = this._aspect;
    this._camera.updateProjectionMatrix();
    this._fitCamera();

    // One pixel = this many world units at the flower plane, so point sizes are
    // resolution independent.
    const pixelScale = (h * ratio) / (2 * Math.tan(this._camera.fov * DEG2RAD * 0.5));
    this._uniforms.uPixelScale.value = pixelScale;
    this._trailUniforms.uPixelScale.value = pixelScale;
  }

  /**
   * Advance + render one frame. Called by main every rAF.
   * @param {null | object} hand tracker state (see CONTRACT.md)
   * @param {number} dt seconds
   * @param {number} time total seconds
   */
  update(hand, dt, time) {
    if (this._disposed) return;

    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.05) : 0.016;
    const clock = Number.isFinite(time) ? time : this._clock + step;
    this._clock = clock;

    const present = Boolean(hand && hand.present);
    const hasTip = present && Boolean(hand.indexTip);
    const previousBloom = this._bloom;

    /* ---- 1. bloom target ------------------------------------------- */
    let targetBloom;
    if (present) {
      const openness = clamp01(Number.isFinite(hand.openness) ? hand.openness : 0);
      if (hand.gesture === 'fist') targetBloom = 0.045;
      else if (hand.gesture === 'open') targetBloom = 1;
      else if (hand.gesture === 'pinch') targetBloom = 0.55;
      else targetBloom = clamp01(openness * 1.1 - 0.02);
    } else {
      // Idle: slow, self-sufficient breathing around ~0.30..0.45.
      targetBloom =
        TUNING.idleBloom +
        Math.sin(clock * 0.31) * TUNING.idleBreath +
        Math.sin(clock * 0.117 + 1.7) * 0.02;
    }
    this._bloom += (clamp01(targetBloom) - this._bloom) * (1 - Math.exp(-step * TUNING.bloomSmooth));

    // Short "pollen burst" accent whenever the bloom changes quickly.
    const bloomDelta = this._bloom - previousBloom;
    this._spark = Math.max(
      this._spark * Math.exp(-step * 2.4),
      Math.min(1, Math.abs(bloomDelta) * 5),
    );

    /* ---- 2. fingertip -> world -> flower local --------------------- */
    const cameraDistance = this._camera.position.z;
    const viewHeight = 2 * Math.tan(this._camera.fov * DEG2RAD * 0.5) * cameraDistance;
    const viewWidth = viewHeight * this._aspect;

    const tipNx = hasTip ? clamp01(hand.indexTip.x) : 0.5;
    const tipNy = hasTip ? clamp01(hand.indexTip.y) : 0.5;
    this._tipWorld.set((tipNx - 0.5) * viewWidth, (0.5 - tipNy) * viewHeight, 0.7);

    if (hasTip) {
      if (!this._hasTip) {
        this._tipSmooth.copy(this._tipWorld);
        this._hasTip = true;
      } else {
        this._tipSmooth.lerp(this._tipWorld, 1 - Math.exp(-step * 16));
      }
    }
    const activeTarget = hasTip ? 1 : 0;
    this._tipActive += (activeTarget - this._tipActive) * (1 - Math.exp(-step * 8));
    if (this._tipActive < 0.001 && activeTarget === 0) this._tipActive = 0;

    /* ---- 3. fingertip / palm energy -------------------------------- */
    // Average motion of all five fingertips drives the shimmer + trail size.
    let instantSpeed = 0;
    if (present && hand.tips && hand.tips.length) {
      const tips = hand.tips;
      const tipLength = Math.min(5, tips.length);
      let accumulated = 0;
      let sampled = 0;
      for (let i = 0; i < tipLength; i++) {
        const tip = tips[i];
        if (!tip) continue;
        if (this._hasPrevTips) {
          const dx = tip.x - this._prevTips[i * 2];
          const dy = tip.y - this._prevTips[i * 2 + 1];
          accumulated += Math.sqrt(dx * dx + dy * dy);
        }
        this._prevTips[i * 2] = tip.x;
        this._prevTips[i * 2 + 1] = tip.y;
        sampled++;
      }
      if (sampled > 0) {
        instantSpeed = accumulated / sampled / Math.max(step, 1 / 240);
        this._hasPrevTips = true;
      }
    }
    this._speed += (instantSpeed - this._speed) * (1 - Math.exp(-step * 9));

    let velocityMagnitude = 0;
    if (present && hand.velocity) {
      const vx = Number.isFinite(hand.velocity.x) ? hand.velocity.x : 0;
      const vy = Number.isFinite(hand.velocity.y) ? hand.velocity.y : 0;
      velocityMagnitude = Math.sqrt(vx * vx + vy * vy);
    }
    const energyTarget = hasTip
      ? clamp(0.7 + Math.min(0.9, this._speed * 0.5 + velocityMagnitude * 0.15), 0, 1.8)
      : 0;
    this._tipEnergy += (energyTarget - this._tipEnergy) * (1 - Math.exp(-step * 6));

    /* ---- 4. flower transform: parallax + idle motion --------------- */
    let targetRotX = 0;
    let targetRotY = 0;
    let targetRotZ = 0;
    let targetPosX = 0;
    let targetPosY = 0;

    if (present) {
      const palm = hand.palm || hand.indexTip || null;
      const hx = clamp01(palm ? palm.x : 0.5);
      const hy = clamp01(palm ? palm.y : 0.5);
      const vx = clamp(hand.velocity && Number.isFinite(hand.velocity.x) ? hand.velocity.x : 0, -2.5, 2.5);
      const vy = clamp(hand.velocity && Number.isFinite(hand.velocity.y) ? hand.velocity.y : 0, -2.5, 2.5);

      targetRotY = (hx - 0.5) * TUNING.parallax.yaw + vx * 0.05;
      targetRotX = (hy - 0.5) * TUNING.parallax.pitch + vy * 0.04;
      targetRotZ = (hx - 0.5) * 0.1 + vx * 0.05;
      targetPosX = (hx - 0.5) * TUNING.parallax.shift + vx * 0.05;
      targetPosY = -(hy - 0.5) * TUNING.parallax.shift * 0.75 - vy * 0.035;
    } else {
      // No hand: breathe and rotate gently around the centre.
      targetRotY = Math.sin(clock * 0.13) * 0.1;
      targetRotX = Math.sin(clock * 0.17 + 1.3) * 0.07;
      targetRotZ = Math.sin(clock * 0.11 + 0.6) * 0.06;
      targetPosX = Math.sin(clock * 0.23) * 0.05;
      targetPosY = Math.sin(clock * 0.19 + 2.1) * 0.04;
    }

    const motionBlend = 1 - Math.exp(-step * 3.2);
    this._rotX += (targetRotX - this._rotX) * motionBlend;
    this._rotY += (targetRotY - this._rotY) * motionBlend;
    this._rotZ += (targetRotZ - this._rotZ) * motionBlend;
    this._posX += (targetPosX - this._posX) * motionBlend;
    this._posY += (targetPosY - this._posY) * motionBlend;

    const breathScale = 1 + 0.006 * Math.sin(clock * 0.8) + 0.004 * Math.sin(clock * 1.7);
    // Awakening: the closed bud stands upright (readable teardrop) and leans
    // towards the camera as the petals open.
    const awaken = 1 - smoothstep(0, 0.62, this._bloom);
    this._group.rotation.set(
      this._rotX - TUNING.awakenTilt * awaken,
      this._rotY,
      this._rotZ,
    );
    this._group.position.set(this._posX, this._posY, 0);
    this._group.scale.setScalar(breathScale);
    this._group.updateMatrixWorld(true);

    // The shader compares particle positions against this in flower space, so
    // the interaction follows the flower through its parallax transform.
    this._tipLocal.copy(this._tipSmooth);
    this._group.worldToLocal(this._tipLocal);

    /* ---- 5. comet trail ------------------------------------------- */
    let trailTarget = hasTip ? 1 : 0;
    this._trailOpacity += (trailTarget - this._trailOpacity) * (1 - Math.exp(-step * (hasTip ? 10 : 7)));
    const trailAlpha = this._trailOpacity * TUNING.trailOpacity;
    this._trailUniforms.uOpacity.value = trailAlpha;
    this._trail.visible = trailAlpha > 0.004; // skip the second draw call when idle
    this._trailUniforms.uSpeed.value = Math.min(1.5, this._speed + velocityMagnitude * 0.25);

    if (hasTip) {
      this._pushHistory(this._tipSmooth.x, this._tipSmooth.y, this._tipSmooth.z);
    }
    this._syncTrail();

    /* ---- 6. uniforms + render ------------------------------------- */
    const u = this._uniforms;
    u.uTime.value = clock;
    u.uBloom.value = this._bloom;
    u.uTipPos.value.copy(this._tipLocal);
    u.uTipActive.value = this._tipActive;
    u.uTipEnergy.value = this._tipEnergy;
    u.uSpark.value = this._spark;
    this._trailUniforms.uTime.value = clock;

    this._renderer.render(this._scene, this._camera);
  }

  /** 0..1 actual bloom amount after smoothing. */
  get bloom() {
    return this._bloom;
  }

  /** 'low' | 'balanced' | 'high' — chosen at construction. */
  get quality() {
    return this._quality;
  }

  /** Number of particles in the main flower draw call (incl. ambient dust). */
  get particleCount() {
    return this._particleCount;
  }

  /** Release every GPU resource. Safe to call twice; the canvas is not removed. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._group.remove(this._flower);
    this._scene.remove(this._trail);
    this._scene.remove(this._group);

    this._flowerGeometry.dispose();
    this._flowerMaterial.dispose();
    this._trailGeometry.dispose();
    this._trailMaterial.dispose();

    this._renderer.dispose();
    this._renderer = null;
    this._canvas = null;
    this._flower = null;
    this._trail = null;
    this._group = null;
    this._scene = null;
    this._camera = null;
    this._flowerGeometry = null;
    this._flowerMaterial = null;
    this._trailGeometry = null;
    this._trailMaterial = null;
    this._uniforms = null;
    this._trailUniforms = null;
  }

  /* ---------------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------------- */

  /** Place the camera so the flower fills an attractive share of the view. */
  _fitCamera() {
    const aspect = this._aspect || 1;
    const fitDiameter =
      aspect < 0.85
        ? TUNING.fitDiameter.narrow
        : aspect < 1.2
          ? TUNING.fitDiameter.mid
          : TUNING.fitDiameter.wide;

    // Half of the smaller visible world extent must equal flowerRadius / fit.
    const halfMinWorld = TUNING.flowerRadius / fitDiameter;
    const halfFovTan = Math.tan(this._camera.fov * DEG2RAD * 0.5);
    const distance = halfMinWorld / (halfFovTan * Math.min(1, aspect));

    this._camera.position.set(0, distance * 0.06, distance);
    this._camera.lookAt(0, 0, 0);
    this._camera.updateMatrixWorld(true);
  }

  _pushHistory(x, y, z) {
    const length = this._historyLength;
    this._historyHead = (this._historyHead + 1) % length;
    const offset = this._historyHead * 3;
    this._history[offset] = x;
    this._history[offset + 1] = y;
    this._history[offset + 2] = z;
    if (this._historyFilled < length) this._historyFilled++;
  }

  /** Slide the fixed-age trail particles along the fingertip history ring. */
  _syncTrail() {
    if (this._historyFilled <= 0) return;
    const length = this._historyLength;
    const head = this._historyHead;
    const lastBack = this._historyFilled - 1;
    const positions = this._trailPositions;
    const history = this._history;

    for (let i = 0; i < this._trailCount; i++) {
      const back = i < lastBack ? i : lastBack;
      let sample = head - back;
      if (sample < 0) sample += length;
      const src = sample * 3;
      const dst = i * 3;
      positions[dst] = history[src];
      positions[dst + 1] = history[src + 1];
      positions[dst + 2] = history[src + 2];
    }
    this._trailGeometry.attributes.position.needsUpdate = true;
  }
}

export default FlowerField;
