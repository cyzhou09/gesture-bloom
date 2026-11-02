# 指尖花 · Integration Contract

> Read this before writing code. This is a no-build, local-first WebGL project.
> Everything is served from the project folder by a tiny local HTTP server.

## Product

A single-page, cinematic WebGL experience: a bioluminescent flower made of trailing
particles, controlled by a real hand through the webcam.

- Fist → the flower folds into a tight, breathing bud.
- Open palm → it blooms outward in a burst of luminous pollen.
- Moving fingers near the petals → petals lean toward the fingertip, particles
  shimmer and a comet-like fingertip trail appears.
- The flower is alive even before the camera starts (idle breathing).
- A built-in demo mode must work without a camera (`?demo=1` and a button).

Visual language: midnight botanical dream. Deep ink/teal background, rose-copper
petals, warm gold core, mint highlights. Elegant editorial typography, thin lines,
glass panels, restrained UI. Never cyberpunk neon grids, never cartoon.

## Hard technical constraints

- Native ES modules + HTML/CSS. No build step. No framework, no bundler.
- Three.js is vendored at `/vendor/three.module.js` and imported as the bare
  specifier `three` (the page has an import map). Do not use another CDN.
- MediaPipe Tasks Vision is vendored at `/vendor/mediapipe/vision_bundle.mjs`;
  WASM at `/vendor/mediapipe/wasm`; model at
  `/vendor/models/hand_landmarker.task`. No network calls.
- Must work on `http://localhost:<port>` (camera requires a secure context).
- Target 60 fps on a normal laptop; mobile fallback allowed. Cap DPR to 2.
- No external fonts, images, audio, or network requests at runtime.
- Do not modify files outside your assigned write scope.

## File ownership

| File | Owner |
| --- | --- |
| `src/flower.js` | flower-engineer |
| `src/handTracking.js` | hand-engineer |
| `index.html`, `styles.css` | ui-engineer |
| `src/main.js`, `serve.mjs`, `package.json`, `README.md` | Lead |
| `tests/*`, `qa/*` | QA |

## Coordinate conventions

All screen/hand coordinates are **normalized 0..1** and **already mirrored** for a
selfie camera: x = 0 is the viewer's left, x = 1 is the viewer's right, y = 0 is the
top of the camera frame, y = 1 is the bottom. z is MediaPipe relative depth (negative
is closer to camera) and is not trusted much.

The flower sits at the centre of the viewport. Main converts hand coordinates to
world coordinates; modules should use the normalized values and keep mapping logic in
`FlowerField`.

## `src/flower.js` contract

```js
import * as THREE from 'three';

export class FlowerField {
  /**
   * @param {HTMLCanvasElement} canvas  full-viewport canvas (#scene)
   * @param {{quality?: 'high'|'balanced'|'low'}} [options]
   */
  constructor(canvas, options = {});

  /** Resize renderer/camera and point-size uniform. Called by main on resize. */
  resize(width, height, dpr);

  /**
   * Advance + render one frame.
   * @param {null | {
   *   present: boolean,
   *   openness: number,       // 0 closed bud .. 1 full bloom
   *   gesture: string,        // 'fist'|'open'|'pinch'|'half'|'none'
   *   palm: {x:number,y:number,z:number},
   *   indexTip: {x:number,y:number,z:number},
   *   tips: Array<{x:number,y:number,z:number}>, // 5 tips, thumb→pinky
   *   velocity: {x:number,y:number},
   *   pinch: number           // 0..1, 1 = thumb/index touching
   * }} hand
   * @param {number} dt seconds, clamped 0..0.05
   * @param {number} time total seconds
   */
  update(hand, dt, time);

  /** 0..1 actual bloom amount after smoothing (for HUD if needed). */
  get bloom();

  /** optional: 'low'|'balanced'|'high' based on device capability. */
  get quality();

  dispose();
}
```

Requirements:

- A single `THREE.Points` particle flower (>= 12k particles on desktop; reduce on
  low quality). GPU-driven bud↔bloom morph with per-particle delays; no
  per-particle CPU position updates each frame.
- Flower reads as a flower in both states: tight teardrop bud when closed, layered
  radial petals when open. Add a warm-gold stamen/core and a few brighter pollen
  particles.
- Additive glow, soft round sprites (shader `gl_PointCoord` is fine), depthWrite
  off. Avoid a flat white blob: keep contrast and visible petal structure.
- Fingertip interaction: particles near the index fingertip bend/lean and shimmer.
  Add a short comet trail from the fingertip (own Points or sprites) using the
  `tips` history, and a soft glow that follows the index tip. Should be subtle,
  not a flashlight.
- The entire flower gently parallaxes/rotates toward the palm; when no hand, it
  breathes on its own and returns to centre.
- Responsive to `resize`, handles DPR, disposes geometries/materials on `dispose`.
- No console errors when `hand` is null. Must render a beautiful idle scene with
  `update(null, dt, time)`.
- Expose `bloom` getter. If you want extra methods, add them without changing the
  contract.
- `quality`: `high` means 2x DPR + maximum particles; `low` means ~6k particles
  and DPR 1. Choose capability via `navigator.hardwareConcurrency`/mobile check.
- Do not start your own `requestAnimationFrame` loop; main owns the loop and calls
  `update`. Do not attach window resize listeners; main calls `resize`.
- Keep code readable and commented where the geometry math is non-obvious.

## `src/handTracking.js` contract

```js
export const HAND_CONNECTIONS = [[0,1], /* ... 21-point skeleton */];

export class HandTracker {
  /**
   * @param {{
   *   video: HTMLVideoElement,          // #camera-video (muted, playsinline)
   *   overlay: HTMLCanvasElement,       // #landmark-canvas
   *   onStatus?: (status: {
   *     phase: 'camera'|'model'|'ready'|'error',
   *     message: string,
   *     detail?: string,
   *     progress?: number
   *   }) => void
   * }} options
   */
  constructor(options);

  /** Request webcam + load MediaPipe; resolves when READY. Throws on failure. */
  async start();

  /**
   * Call every main-loop frame while running.
   * @param {number} nowMs performance.now()
   * @param {number} dt seconds
   * @returns {{
   *   present: boolean, gesture: string, openness: number, pinch: number,
   *   palm: {x,y,z}, indexTip: {x,y,z}, tips: Array<{x,y,z}>,
   *   velocity: {x,y}, landmarks: Array<{x,y,z}>|null,
   *   handedness: 'Left'|'Right'|null, fps: number
   * }}
   */
  update(nowMs, dt);

  /** Stop tracks, close landmarker, clear overlay. */
  stop();

  get running();
}
```

Requirements:

- `start()`:
  1. Emit `{phase:'camera', message:'正在唤醒摄像头…', progress:0.1}`.
  2. `getUserMedia({video:{facingMode:'user', width:{ideal:1280}, height:{ideal:720}}, audio:false})`.
     Attach to provided video, `await video.play()`. Emit progress 0.38.
  3. Import `/vendor/mediapipe/vision_bundle.mjs` (static import is fine), call
     `FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm')` and
     `HandLandmarker.createFromOptions(vision, {baseOptions:{modelAssetPath:'/vendor/models/hand_landmarker.task', delegate:'GPU'}, runningMode:'VIDEO', numHands:1, minHandDetectionConfidence:0.55, minHandPresenceConfidence:0.55, minTrackingConfidence:0.5})`.
     If GPU init fails, retry with `delegate:'CPU'`. Emit model progress 0.65 / 0.9.
  4. Emit `{phase:'ready', message:'手部追踪已就绪', progress:1}`.
  5. Camera permission/model errors must throw an `Error` with a useful `name`
     (`NotAllowedError` etc.) and Chinese message. Always clean up tracks on failure.
- `update()`:
  - Throttle detection to ~30-40 fps to keep the render loop smooth (skip frames,
    return last smoothed state).
  - Use `performance.now()` as a monotonically increasing timestamp.
  - Detect one hand; compute mirrored landmarks in 0..1 (`x = 1 - lm.x`).
  - Gesture recognition must be robust to hand distance from camera:
    normalize by palm scale (wrist→middle MCP / index MCP→pinky MCP). Combine
    finger straightness (tip-to-MCP direct / chain length) with fingertip distance
    from palm centre. Do not rely on raw distances.
  - Blend with exponential smoothing so `openness` never jitters; fast enough to
    feel live (roughly 100–160 ms). Palm and fingertip positions smoothed too.
  - Compute `pinch` from thumb-tip↔index-tip distance / palm width, 1 = touching.
  - Gesture labels: `fist` (<~0.24), `open` (>~0.62), `pinch` (pinch >0.7 and
    middle/ring extended), `half` between; `none` when no hand. Use hysteresis so
    the label does not flicker at boundaries.
  - Keep returning the last smoothed state (present=false after ~400ms without a
    hand) so the flower can relax.
  - Draw the 21-point skeleton and fingertips onto `overlay` in CSS pixel space,
    correctly aligned with a mirrored `object-fit: cover` video. Bright warm-gold
    index tip; subtle mint skeleton; clear on absence. Use pointer coordinates
    mapped through the actual displayed video crop (`video.videoWidth/Height` and
    the element's client size).
  - No allocations in the hot path where reasonably avoidable; reuse arrays.
- `stop()` must be idempotent and safe before `start()`.
- Do not query DOM outside the two passed elements. Do not attach resize listeners.

## `index.html` / `styles.css` contract (UI)

Main.js will bind to these exact IDs; do not rename them.

```
#scene                    canvas, full viewport, z-index 0
#app                      page wrapper
#header                   top chrome (brand + status pill + help button)
#status-pill              live status text container (main sets data-state)
#status-text              text span
#help-button              button
#help-panel               modal/panel, toggled with .is-open
#help-close               button
#intro                    full-screen intro overlay
#intro-title              hero heading
#intro-subtitle           short paragraph
#enter-camera             primary button
#enter-demo               secondary button
#intro-status             small loading/error text (aria-live="polite")
#intro-progress           progress fill element (main sets style.width)
#intro-note               permission/privacy note
#hud                      live HUD wrapper, visible with body.is-live
#gesture-card             gesture coaching card
#gesture-name             large gesture name
#gesture-desc             small description
#bloom-fill               meter fill (main sets style.width)
#bloom-value              percentage text
#tracker-panel            webcam preview card
#camera-video             <video muted playsinline autoplay>
#landmark-canvas          overlay canvas over video
#tracker-state            tracking status caption
#tracker-toggle           collapse/expand preview button
#mode-badge               top-right mode label (LIVE / DEMO)
#toast                    transient toast text
#hide-ui                  button to hide chrome
#show-ui                  small button to restore chrome
```

Required CSS state hooks:
- `body.is-live` reveals `#hud` and hides `#intro`.
- `#intro.is-hidden` fades/scales out.
- `#intro[data-state="loading"|"error"]` adjusts button/status.
- `#tracker-panel.is-collapsed` hides preview body.
- `#help-panel.is-open` visible.
- `#toast.is-visible` visible.
- `body.ui-hidden` hides all chrome except `#show-ui`.
- `#show-ui` is hidden unless `body.ui-hidden`.
- prefers-reduced-motion respected for CSS-only animations.

Design notes:

- Exact selfie video must be mirrored via CSS (`transform: scaleX(-1)`), and overlay
  canvas must NOT be mirrored (handTracking draws mirrored positions).
- Layout must not cover the flower centre on desktop. Intro may use a left editorial
  column with a big serif title; HUD cards sit at bottom corners.
- Use system fonts only. A tasteful serif stack for the title is encouraged
  (e.g. `"Bodoni 72","Didot","Times New Roman","Songti SC",serif`), sans for UI.
- Glassmorphism should be subtle; use thin 1px rgba borders, backdrop blur, grain/vignette
  overlays (CSS gradients / inline SVG data URI) not external assets.
- Include inline SVG icons (camera, hand, close, eye) rather than icon fonts.
- Responsive at <=760px: simplified HUD, tracker preview may become a small floating
  card; title/CTA fully usable at 360x640.
- No layout shift after camera start. Buttons need visible focus states.
- Accessible: real `<button>`, `aria-label`, `aria-live`, decent contrast.

## Quality bar

- No errors/warnings in console (except Chrome's expected camera permission logs).
- Smooth idle animation with no camera (demo mode must be screenshot-ready).
- The page should look finished at 1440×900 and 390×844.
- Keep the code dependency-free; no npm install required to run.
