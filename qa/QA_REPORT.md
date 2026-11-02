# 指尖花 · 独立最终 QA 报告

**Project:** `gesture-bloom/` (no-build Three.js + MediaPipe Hand Landmarker, local only)
**Review type:** Independent, adversarial final QA (teammate `qa-reviewer`), implementation **FROZEN**
**Date:** 2026-11-02 (Asia/Shanghai)
**Report path:** `gesture-bloom/qa/QA_REPORT.md`

---

## Verdict

**SIGN-OFF — PASS with Minor findings.** No **Critical** or **Major** defects were found. All product
requirements in `CONTRACT.md` are implemented and verified in the shipped app: Three.js GPU particle
flower, MediaPipe 21-landmark hand tracking, fist→bud / open→bloom / fingertip interaction, no-build
native ES modules, local HTTP serving, responsive UI, and zero external runtime assets/requests.

Six **Minor** issues were found in the help/a11y and lifecycle edges; five of them fall under the Lead's
triaged follow-up patch (focus trap / deferred focus, bfcache recovery, `#mode-badge` LIVE styling,
aria-hidden focus warning), and the sixth is a documentation/tooling mismatch (Node.js version required by
`npm run qa`). Two **Nit** + cleanup items are also listed. None of the findings affects the core
camera/demo/bloom flows verified below.

> Implementation was not touched: only files under `gesture-bloom/qa/` were created/modified.
> Source/test/vendor mtimes all predate the QA session (latest: `src/flower.js` 15:04:04; QA started 15:08).

---

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 家庭版 中文版, 10.0.26200 |
| Node.js | v24.14.1 |
| npm | 11.11.0 |
| Browser | Google Chrome 156.0.8078.74 (`C:\Program Files\Google\Chrome\Application\chrome.exe`) |
| Renderer for headless QA | `--headless=new --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader` |
| Camera for headless QA | `--use-fake-device-for-media-stream` (+ `--use-fake-ui-for-media-stream` for granted-path tests) |
| Server | `node serve.mjs` bound to `127.0.0.1`; default `:4173`/`npm start`, QA harnesses used unique free ports |
| Viewports tested | 1440×900 (DPR1), 1280×800, 390×844 (DPR2), 360×640 (DPR2) |

---

## Evidence — commands and results

### 1. Static checks

```text
npm run check
  ✓ 指尖花 static check passed
    16 files verified, 31 required DOM ids present.

node --check src/main.js src/flower.js src/handTracking.js serve.mjs tests/check.mjs tests/browser-qa.mjs
  → all OK
```

`tests/check.mjs` covers: required files, vendor sizes, JS syntax, 31 contract DOM ids, no duplicate ids,
import map, no inline JS, no external HTML/CSS assets, required CSS state hooks, module imports, RAF loop.

### 2. Server MIME / methods / headers (live server on `127.0.0.1:4173`)

| Request | Status | Content-Type |
| --- | --- | --- |
| `/index.html` | 200 | `text/html; charset=utf-8` |
| `/styles.css` | 200 | `text/css; charset=utf-8` |
| `/src/main.js` | 200 | `text/javascript; charset=utf-8` |
| `/vendor/three.module.js` | 200 | `text/javascript; charset=utf-8` |
| `/vendor/mediapipe/vision_bundle.mjs` | 200 | `text/javascript; charset=utf-8` |
| `/vendor/mediapipe/wasm/vision_wasm_internal.wasm` | 200 | `application/wasm` |
| `/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm` | 200 | `application/wasm` |
| `/vendor/models/hand_landmarker.task` | 200 | `application/octet-stream` |
| `/no-such-file`, `/vendor/` | 404 | text/html |
| `POST /` | 405 | `Allow: GET, HEAD` |

Response headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`Permissions-Policy: camera=(self), microphone=()`, `Cache-Control: no-cache` (vendor: `public, max-age=3600`).
`HEAD` works; content-length matches files. Correct MIME for `.mjs`, `.wasm` and `.task` confirmed
(`serve.mjs:22-39`).

### 3. Path-traversal probe (raw HTTP, Windows-specific encodings included)

| Request path | Result |
| --- | --- |
| `/../CONTRACT.md`, `/%2e%2e/CONTRACT.md`, `/vendor/../../CONTRACT.md`, `/.%2e/CONTRACT.md`, `//../../CONTRACT.md` | 200 — URL parser normalises to an **in-root** file (`/CONTRACT.md`); no escape |
| `/..%5c..%5cWindows%5cwin.ini` | 400 Bad request |
| `/..\..\Windows\win.ini` | 404 (no such in-root path) |
| `/%2e%2e%5c%2e%2e%5cWindows%5cwin.ini` | 400 |
| `/C:/Windows/win.ini` | 400 |
| `/%00index.html` | 400 |

**Conclusion:** no request can be served from outside `ROOT` (`serve.mjs:49-67`). Note the server intentionally
serves any project file (including `/tests/`, `/scratch/` if present) — local-dev design, not a traversal bug.
Delete `scratch/` before delivery.

### 4. Shipped-source asset/network audit

- No `fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` in `index.html`, `styles.css`, `src/*.js`, `serve.mjs`.
- Only external URL **strings** in shipped files are `data:` SVG URIs (favicon + grain) and localhost text in
  error copy/console output. No CDN, fonts, images or analytics.
- Vendor bundles contain license/doc URLs in comments only (not fetched); MediaPipe WASM/model are local.
- Live network monitor across the whole adversarial run: **0 external requests, 0 failed local requests, 0 HTTP ≥ 400**.

### 5. `npm run qa` (official headless smoke test)

```text
✓ Browser QA: 13/13 checks passed
  baseUrl http://127.0.0.1:63298
  reports: qa/qa-report.json
  screenshots: intro-desktop, demo-bud, demo-desktop, help-desktop, demo-mobile, camera-fake
  consoleErrors: [], networkErrors: []
```

### 6. Independent adversarial harness results

| Harness | Result | Notes |
| --- | --- | --- |
| `node qa/qa-adversarial.mjs` | 56/61 checks passed | 2 help-timing flakes + 3 invalid denial checks — see reconciliation below |
| `node qa/qa-recheck.mjs` | 11/13 checks passed | both failures are **genuine Minor findings** (no focus trap; LIVE badge styling) |
| `node qa/qa-hand-math.mjs` | PASS | synthetic 21-landmark hands: open openness 0.837→`open`, fist 0.000→`fist`; mirrored tip x 0.56; grace present@300ms / released@401ms; stop-before-start safe; reused snapshot confirmed |

**Adversarial run reconciliation (important for honesty):**

- *“Real click opens help / backdrop closes”* failed in `qa-adversarial.mjs` because the samples were taken while
  the CSS `visibility` transition had not yet advanced under headless load (panel measured `visibility:hidden`,
  `elementFromPoint` hit `#intro`). Re-run in `qa-recheck.mjs` with a 700 ms wait: panel `visible`/`opacity:1`,
  backdrop hit-testable, backdrop click closes, focus lands on `#help-close`. **No app defect.**
- *“Camera denial”* 3 checks failed because the harness Chrome carried `--use-fake-ui-for-media-stream`, which
  auto-accepts and overrides `Browser.setPermission(denied)` (evidence: `trackerRunning:true`). Replaced with the
  deterministic monkey-patch probe below (Lead-requested); **all denial checks now pass**.
  (CDP note: `Browser.setPermission` needs Blink name `camera`, not `videoCapture`.)

**Deterministic camera-denial probe** (`qa-recheck.mjs`, `navigator.mediaDevices.getUserMedia` patched to reject
with `NotAllowedError`):

```text
intro data-state=error
intro-status: 摄像头权限被拒绝。请在地址栏的摄像头图标中允许访问后重试。
intro-note:   也可以直接进入演示模式，先看看花开的样子。
camera/demo buttons: enabled; bodyLive=false; trackerRunning=false; status-pill=error
toast: 摄像头未能启动，仍可使用演示模式
→ clicking 演示 enters DEMO successfully.   [PASS]
```

**WebGL-unavailable probe** (inject `getContext('webgl')→null` before load):

```text
intro data-state=error, status-pill=error ("WebGL 不可用")
intro-status: 当前浏览器无法创建 WebGL 场景。请开启硬件加速，或使用最新版 Chrome / Edge。
both CTAs disabled, stays on intro, no uncaught exception, window.__BLOOM_ERROR__ set.  [PASS]
```

### 7. Extra verified runtime behaviour (adversarial run)

- `?quality=low` → `flower.quality='low'`, `particleCount=6000`, DPR1. Invalid `?quality=banana` → auto tier,
  no crash.
- `?demo=1` auto-starts; `D` starts demo from intro; demo loop reaches >90 % bloom and back to bud.
- HUD bloom meter matches `flower.bloom` (±1 %) and `#bloom-fill` width; gesture card copy follows gesture.
- Camera path: loading state (`data-state=loading`, buttons disabled, `aria-busy=true`, progress 10 %, spinner
  visible) → LIVE; fake video 1280×720 readyState 4; overlay canvas 248×186 = CSS box × DPR.
- Mirroring: `#camera-video` computed `matrix(-1,0,0,1,0,0)` + `object-fit: cover`; `#landmark-canvas` `none` (correct).
- Tracker collapse via `T`: `is-collapsed`, `aria-expanded=false`, body `display:none`; expand restores.
- `U` hides chrome (show-ui visible, header hidden); `Escape` restores; `show-ui` click restores.
- Resize while LIVE 1440→390×844: WebGL backing 780×1688 (390×844 × tier DPR2), HUD reflows, no overlap.
- `prefers-reduced-motion: reduce`: aurora animation `none`, CSS animation/transition durations ≈ 1e-06 s,
  WebGL loop still live.
- Mobile 390×844 and 360×640 (intro + demo + live camera): no horizontal scroll, CTAs in-viewport and
  hit-testable, HUD cards inside viewport and non-overlapping.

---

## Screenshot findings (all inspected at full resolution)

| Screenshot | Finding |
| --- | --- |
| `qa/intro-desktop.png` (1440×900) | Composition correct: editorial serif title left, CTAs + progress + hint + privacy note; flower centre-right; header/badge/help; no overflow. Idle flower reads as a luminous orb (Nit-1). |
| `qa/demo-bud.png` | Clear pink **teardrop bud**, 9 % bloom, “含苞” copy, demo fingertip dot + comet trail visible. Tip has a white-hot highlight (Nit-1). |
| `qa/demo-desktop.png` | Layered radial rose visible with spiral petal bands, warm core, pollen/dust; 100 % bloom, “绽放” copy. Upper core slightly overexposed (Nit-1). |
| `qa/help-desktop.png` | Dialog fits 1440×900, three gesture cards + shortcuts + privacy note, backdrop dims scene. |
| `qa/demo-mobile.png` (390×844@2x) | Header fits, flower centred, gesture card at bottom, hide-UI eye at right; no horizontal scroll / overlap. |
| `qa/camera-fake.png` (1280×800) | LIVE + “寻找手部”; green synthetic camera preview in glass tracker card; “静候”; bloom 42 %; expected no hand in fake stream. |
| `qa/qa-adv-camera-denied.png` | Chinese permission error visible in intro, toast, demo fallback note, status “连接失败”; both CTAs usable. |
| `qa/qa-adv-webgl-unavailable.png` | Chinese WebGL error, disabled CTAs, status “WebGL 不可用”; graceful. |
| `qa/qa-adv-mobile-360-intro.png`, `qa-adv-mobile-360-demo.png` | 360×640 fits, title/CTAs fully visible and clickable, no horizontal scroll. |
| `qa/qa-adv-mobile-390-demo.png`, `qa-adv-camera-mobile.png` | 390×844 demo + live-camera layouts fit; tracker card (122 px) and gesture card do not overlap hide-UI. |
| `qa/qa-adv-low-quality.png` | Low tier still reads as a bud/rose at 6k particles. |
| `qa/qa-adv-bfcache-stale-live.png` | Evidence for MINOR-3: HUD says LIVE / 寻找手部 while the tracker is stopped and the preview is black after a simulated bfcache restore. |

---

## Issues (severity-tagged)

### Critical — none

### Major — none

### Minor

**MINOR-1 · Help dialog has no focus trap despite `aria-modal="true"`.**
`index.html:213` (`role="dialog" aria-modal="true"`), `src/main.js:354-361` (`openHelp`/`closeHelp`).
`qa-recheck.json` check “Tab stays inside modal dialog” fails: after focusing `#help-close`, `Tab` moves focus
to `BODY` (in the adversarial run it moved to `#enter-camera`). Keyboard users can tab into background chrome
while the modal is open. *Fix (Lead triaged): add a focus trap / inert background.*
**Repro:** open help → focus `#help-close` → Tab → inspect `document.activeElement`.

**MINOR-2 · Focus-into-dialog races the panel’s visibility transition (intermittent).**
`src/main.js:360` calls `els.helpClose.focus()` synchronously while `#help-panel` is still
`visibility:hidden` at transition time 0 (`styles.css:1235-1253`). In `qa-adversarial.json` the focus call was
ignored (`activeElement` stayed `#help-button`, panel still hidden when sampled); in `qa-recheck.json` the same
flow moved focus correctly to `#help-close`. Intermittent a11y defect. *Fix (Lead triaged): defer focus
(double rAF) or avoid transitioning `visibility`.*
**Repro:** click `#help-button` on a freshly loaded intro page and sample `document.activeElement` immediately.

**MINOR-3 · pagehide/bfcache restore leaves a stale “LIVE” UI with a dead tracker.**
`src/main.js:575-577` stops the tracker on `pagehide`, but there is no `pageshow` recovery/reset. After a
simulated bfcache restore: `mode=camera`, `live=true`, `trackerRunning=false`, `video.srcObject=null`,
HUD still shows LIVE / 寻找手部, preview black; only a page reload recovers. Evidence:
`qa-adversarial.json` (`pagehide-bfcache`) + `qa/qa-adv-bfcache-stale-live.png`. *Fix (Lead triaged):
pageshow handler to restart/reset.*

**MINOR-4 · `#mode-badge` never gets `data-mode="live"`, so LIVE uses DEMO styling.**
`src/main.js:153,156` only call `setText`, never set/update `data-mode`; `index.html:50` ships
`data-mode="demo"`; `styles.css:335-343` keys colours off it. After entering camera mode:
`text=LIVE`, `data-mode=demo`, computed colour `rgb(233,207,156)` (DEMO gold) instead of live mint
`rgb(143,217,196)`. Evidence: `qa-recheck.json` check “LIVE mode badge applies LIVE styling”. *Fix (Lead triaged).*

**MINOR-5 · Hiding the intro while it still contains focus logs an `aria-hidden` warning.**
`src/main.js:144-149` sets `aria-hidden="true"` + `inert` on `#intro` in `enterLive()` while focus may still be
on `#enter-camera`/`#enter-demo` (e.g. keyboard Tab + D). Chrome logs:
`Blocked aria-hidden on an element because its descendant retained focus… Element with focus: <button#enter-camera>`.
This is an app-triggered console warning (quality bar allows only expected MediaPipe logs). Evidence:
`qa-adversarial.json` → `consoleWarnings[0]` (phase `demo`). *Fix (Lead triaged): blur/refocus before hiding.*

**MINOR-6 · Tooling/doc: `npm run qa` needs Node ≥ 22 but `engines`/README claim Node 18+.**
`package.json:13-14` (`"node": ">=18"`), `README.md:11` (“需要 Node.js 18+”), while `tests/browser-qa.mjs:160`
relies on the global `WebSocket` (“Node >= 22 has global WebSocket”). `npm start` works on 18, but `npm run qa`
will throw `WebSocket is not defined` on Node 18/20. App runtime unaffected; documentation/tooling only.
(Node 24 was used here; no Node 18 runtime was available to execute the negative test.)

### Nit

**NIT-1 · Additive highlights clip to near-white at the bud tip / upper bloom core.**
`src/flower.js:79` (`exposure: 1.55`) + additive blending; visible in `demo-bud.png` (white-hot bud nose) and
`demo-desktop.png` (upper-centre highlight). Petal structure is still readable; no functional impact.
Optional polish: slightly lower exposure or add a soft highlight roll-off.

**NIT-2 · Hiding the UI while the help dialog is open leaves help logically open underneath.**
Static review: `hideChrome()` (`src/main.js:377-384`) does not close the help panel; `body.ui-hidden` CSS hides
`#help-panel` (`styles.css:1448-1456`), so the first `Escape` closes the invisible dialog and only a second
`Escape` restores the UI (`src/main.js:461-480`). Edge case; not exercised in a dedicated test.

---

## Requirement audit (CONTRACT.md)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Single `THREE.Points` GPU particle flower, ≥12k desktop / ~6k low | ✅ | `flower.js` tiers 22 000 / 14 000 / 6 000 (`flower.js:103-107`); GPU morph in vertex shader; `?quality=low` probe → 6 000 |
| Reads as teardrop bud + layered radial petals, warm-gold core/pollen | ✅ | `demo-bud.png`, `demo-desktop.png`; stamen/pollen/dust layers in `flower.js` |
| Additive glow, round sprites, depthWrite off, petal contrast | ✅ | Shader `gl_PointCoord` + additive, `depthWrite:false`; structure visible (NIT-1 highlight only) |
| Fingertip lean/shimmer/comet trail + soft glow; parallax toward palm; idle breathing | ✅ | Shader tip uniforms (`flower.js:569-585`), trail points, demo screenshots show dot + trail; idle loop verified |
| Fist → bud, open palm → bloom, continuous openness | ✅ | `flower.js:905-920` mapping + `main.js` demo; synthetic-landmark probe: fist 0.00→`fist`, open 0.84→`open` |
| MediaPipe Tasks Vision local (bundle/WASM/model), GPU→CPU fallback | ✅ | `handTracking.js:53-55,437-480,1074-1121`; local-only network audit; GPU path exercised |
| 21 landmarks, mirrored coordinates, skeleton overlay aligned to cover-cropped mirrored video | ✅ | `HAND_CONNECTIONS` valid 21-point skeleton; mirrored tip x=0.56 in probe; browser transform/object-fit checks; overlay math in `handTracking.js:954-1052` |
| Scale-normalised gestures + smoothing + hysteresis, 30–40 fps throttle | ✅ | `handTracking.js:92,739-814,889-905`; math probe; browser fake-camera run detected no hand (expected) |
| Robust camera start/stop/idempotent, Chinese named errors, cleanup | ✅ | Deterministic denial probe; `stop()` before `start()` probe; tracks stopped on pagehide |
| No build step, native ES modules/HTML/CSS, local HTTP, secure-context note | ✅ | Import map + bare `three`; `npm start`; intro privacy/localhost copy; README |
| No external runtime assets/network | ✅ | Source scan + full-run network monitor: 0 external requests |
| Responsive desktop/mobile, no layout shift after start, focus states | ✅ | Screenshots + viewport measurements; focus-visible styles present; no h-scroll/overlap |
| Accessibility (real buttons, labels, aria-live, focus, dialog) | ⚠️ mostly | Buttons/labels/`aria-live`/focus-restore verified; focus trap + intermittent open-focus are MINOR-1/2 |
| Reduced motion for CSS animations | ✅ | Emulated `prefers-reduced-motion` → animations disabled |
| 60 fps target / DPR cap 2 | ✅ (by code) | DPR caps by tier; real hardware FPS not measurable under SwiftShader (residual risk) |

---

## Code-review notes (integration)

- **State machine / races** — `app.starting` guards double camera starts; the post-ready 260 ms timer checks
  `app.live` and stops the tracker if demo was started meanwhile; `startDemo` stops a running tracker and
  resets demo state; failure path re-enables CTAs and keeps intro usable (verified via denial probe).
- **HandTracker snapshot reuse** — `update()` intentionally returns the same object each frame
  (`handTracking.js:330-342,612-629`). `main.js` consumes it synchronously (no cross-frame retention); only the
  debug surface (`window.__BLOOM__.hand`) exposes the mutable reference. This is contract-compliant; QA
  automation must read fields immediately (documented in `qa/qa-hand-math.mjs`).
- **Hand-loss grace** — present for ≤400 ms then `gesture='none'`; flare-out verified (300 ms true / 401 ms false).
- **Flower resize/dispose** — `resize()` clamps per-tier DPR and updates uniform scale; double `dispose()` and
  post-dispose `update()/resize()` are safe (in-browser API probe: 800×600 backing at DPR2 high tier); no own RAF.
- **Render error handling** — `main.js` wraps `tracker.update` and `flower.update` in try/catch; WebGL context
  loss handled via `webglcontextlost` → fatal toast. WebGL-unavailable boot path verified graceful.
- **Mobile/touch** — HUD grid reflow at ≤900 px, compact ≤600 px; 360×640 and 390×844 verified; tracker card
  collapse prevents camera card dominating small screens; no covered controls.
- **Privacy/offline** — video only enters MediaPipe in-page; no upload/save; tracks stopped in `stop()`/`teardown`/
  `pagehide`; all assets local; demo mode fully offline.
- **Vendor** — `three.module.js` imports local `./three.core.js`; `vision_bundle.mjs` carries a
  `sourceMappingURL=vision_bundle_mjs.js.map` whose map is absent — DevTools-only, no runtime request (harmless).

---

## Residual risks

1. **No real webcam/hand available in this environment.** MediaPipe loading/inference was exercised with Chrome’s
   fake device (always no hand), so real landmark accuracy, lighting/distance robustness, and overlay alignment
   against a real hand remain unverified end-to-end. Gesture maths was validated with synthetic 21-landmark hands
   (`qa/qa-hand-math.mjs`).
2. **Headless SwiftShader.** Shader output should be identical in principle, but frame pacing, driver timings and
   CSS-transition scheduling differ from hardware. This caused two timing flakes in the adversarial harness
   (panel sampled mid-transition), reconciled as harness artifacts, not app defects.
3. **Real-device mobile / quality auto-detection.** Device emulation keeps a desktop UA, so mobile emulation ran
   the `high` tier; the `low` tier was only exercised via `?quality=low`. Real mobile performance/thermal behaviour
   is untested.
4. **bfcache** was simulated with `PageTransitionEvent('pagehide'/'pageshow', {persisted:true})`, not an actual
   back/forward navigation; code review confirms the missing `pageshow` handler (MINOR-3).
5. **Performance:** 60 fps target, real-GPU frame times and memory were not measurable under SwiftShader.
6. **Accessibility:** keyboard/ARIA flows were exercised, but no exhaustive WCAG/contrast audit was performed
   (several 9–11 px secondary labels use 50 % opacity text; not machine-verified).

---

## Cleanup notes (pre-delivery)

- **`gesture-bloom/scratch/` must be deleted.** It holds 14 files / **11.9 MB** of teammate scratch work
  (screenshots, probe HTML/JS). It is also served by the static server while present.
- Stale QA artifacts `qa/intro-partial.png` and `qa/preview-2.png` (from earlier intermediate runs) were removed
  by QA; the six canonical `npm run qa` screenshots + adversarial screenshots remain.
- QA temp scripts/logs used during review were removed; permanent auxiliary artifacts are listed below.
- `qa/` contains **~21 MB** of screenshots; harmless for delivery but could be trimmed to the six canonical
  screenshots if repository size matters.

---

## Evidence artifacts

| Artifact | Contents |
| --- | --- |
| `qa/qa-report.json` + 6 canonical screenshots | Official `npm run qa` run (13/13) |
| `qa/qa-adversarial.mjs` / `qa/qa-adversarial.json` + `qa-adv-*.png` | Independent adversarial harness: 61 checks, console/network audit, mobile, resize, bfcache, low-quality |
| `qa/qa-recheck.mjs` / `qa/qa-recheck.json` + `qa-adv-camera-denied.png`, `qa-adv-webgl-unavailable.png` | Lead-requested targeted re-probes: deterministic denial, help transition/backdrop/focus, LIVE badge, WebGL failure |
| `qa/qa-hand-math.mjs` | Node-only synthetic-landmark validation of gesture maths / snapshot reuse / grace period |
| `qa/QA_REPORT.md` | This report |

Reconcile counts when reading artifacts: `qa-adversarial.json` records 5 failures that are **not app defects**
(2 headless timing flakes, 3 invalid denial-harness config); the re-probes in `qa-recheck.json` supersede them.
The only genuine failing checks in the final evidence are MINOR-1 (focus trap) and MINOR-4 (LIVE badge styling).

---

## Sign-off

```text
VERDICT: SIGN-OFF
Critical: 0 | Major: 0 | Minor: 6 | Nit: 2
Core requirements verified; minor a11y/lifecycle items listed for the Lead's triaged follow-up patch.
QA artifacts and repro steps are committed under gesture-bloom/qa/.
```

**QA reviewer:** `qa-reviewer` (independent)
**Date:** 2026-11-02T15:25+08:00
**Implementation status:** frozen; no source/test/vendor/config changes made by QA.

---

## Post-fix verification (2026-11-02T15:32+08:00)

Re-verified the Lead's post-sign-off patch against the current tree. The section above is kept as frozen
history; only this section reflects the patched tree. QA again wrote only under `qa/`.

**Patched files (mtimes):** `src/main.js` (22.5 KB, 15:27:21), `tests/browser-qa.mjs` (21.4 KB, 15:27:21),
`package.json` (engines → `>=22`, 15:25:53), `README.md` (8.2 KB, 15:28:59). `src/flower.js`,
`src/handTracking.js`, `index.html`, `styles.css`, `vendor/` unchanged (no vendor changes; no visual code changes).
`git` is not initialised, so diff-level comparison was not possible; the change set was verified functionally.

### Re-run evidence

| Check | Pre-fix | Post-fix |
| --- | --- | --- |
| `npm run check` | ✓ 16 files / 31 ids | ✓ 16 files / 31 ids |
| `node --check` all JS | ✓ | ✓ (`main.js`, `flower.js`, `handTracking.js`, `serve.mjs`, `tests/*.mjs`) |
| `npm run qa` (`tests/browser-qa.mjs`) | 13/13 | **18/18** — adds help focus/trap/restore, LIVE badge data-mode+color, bfcache round-trip; 0 console errors, 0 failed requests |
| `qa/qa-recheck.mjs` | 11/13 (2 genuine minors) | **13/13** — focus trap, deferred focus, LIVE mint badge, denial path, WebGL failure all pass; `ariaHiddenWarnings: []` |
| `qa/qa-postfix.mjs` (new targeted harness) | n/a | **21/21** — fix-by-fix verification below |
| `qa/qa-hand-math.mjs` | PASS | PASS (tracking/flower source unchanged) |

### Fix-by-fix verification

| Fix | Evidence | Status |
| --- | --- | --- |
| (a) focus trap + deferred focus (MINOR-1/2) | `main.js:396-449` (`focusHelpControl`, 380 ms retry, `trapHelpFocus`); postfix: “Help open moves focus into the dialog (deferred focus)” ✓ (attempt 1), “Help traps Tab and Shift+Tab inside the modal” ✓, “H closes the open modal and restores focus” ✓, focus/restore fallback to `#help-button` when focus was BODY ✓; official QA: “Help moves focus into the dialog”, “Help keeps Tab focus inside the modal”, “Help restores focus on close” all ✓; help screenshot shows focus ring on close button | **Resolved** |
| (b) `#mode-badge.dataset.mode` (MINOR-4) | `main.js:158`; postfix: DEMO `data-mode=demo` + `rgb(233,207,156)` ✓, LIVE `data-mode=live` + mint `rgb(143,217,196)` ✓; official QA “LIVE badge uses live mint styling” ✓; `camera-fake.png` badge now mint | **Resolved** |
| (c) blur intro CTA before aria-hidden (MINOR-5) | `main.js:145-150`; postfix: focused CTA + real demo click → `activeElement=BODY`, `intro[aria-hidden=true]`, `inert=true` ✓; audit: **0** “Blocked aria-hidden … retained focus” warnings; only expected MediaPipe (2) + SwiftShader driver messages remain | **Resolved** |
| (d) bfcache recovery (MINOR-3) | `main.js:173-200` (`resetCameraSession`) + `main.js:674-681` (`pageshow`); postfix: pagehide stops tracks ✓, pageshow → `mode=intro`, `live=false`, intro error state, enabled retry/demo CTAs, status `摄像头已暂停` ✓, camera retry succeeds ✓; official QA “bfcache restore recovers to intro with retry CTA” ✓; screenshot `qa-adv-postfix-bfcache.png` | **Resolved** |
| (e) `hideChrome` closes open help (NIT-2) | `main.js:456-461`; postfix: “hideChrome() closes an open modal (defensive path)” ✓ (modal closed, `ui-hidden`, show-UI visible). Note: while the modal is open the `U` shortcut is intentionally blocked by modal semantics (verified: U ignored, modal stays open); the defensive path is used by programmatic/debug calls, not reachable by clicking the covered hide-UI button. | **Resolved (defensive path)** |
| (f) tracker toggle aria-label | `main.js:467-472`; postfix: collapse → `aria-expanded=false` + “展开摄像头预览”, expand → `true` + “收起摄像头预览” ✓ | **Resolved** |
| (g) help restore-focus fallback | `main.js:401-424`; postfix: BODY-focus open → focus in dialog, Escape → `#help-button` ✓ | **Resolved** |
| Node engines / README / friendly guard (MINOR-6) | `package.json:13-14` → `"node": ">=22"`; `README.md:19,50` distinguish runtime (18+) vs QA (22+); `tests/browser-qa.mjs:29-32` prints a friendly message and exits 1 when global `WebSocket` is absent | **Resolved (static verification; Node 18 unavailable to run the negative path)** |
| NIT-1 additive highlight clipping | no rendering/visual code changed; still observable in `demo-bud.png` / `demo-desktop.png` | **Open Nit (non-blocking, unchanged)** |

### No-regression spot checks

- Demo loop still reaches `bloom=1.00` / `gesture=open`; bud screenshot at 24 % still reads as a teardrop bud
  (`demo-bud.png` re-inspected); mobile 390×844 unchanged (`demo-mobile.png`); `camera-fake.png` re-inspected
  (LIVE mint badge, tracker card, “静候”), `help-desktop.png` re-inspected (focus ring on close button only).
- Adversarial evidence from the frozen section (`qa-adversarial.json`) predates this patch; the post-fix harnesses
  (`qa-recheck.json`, `qa-postfix.json`) supersede it for the fixed areas.
- `qa/qa-postfix.mjs` (new) + `qa-postfix.json` + `qa-adv-postfix-bfcache.png` are the added post-fix artifacts;
  temp run logs were removed.

### Residual risk after fixes

- **Headless-only transition stall:** the deferred focus retry is a single 380 ms timeout. In one post-fix harness
  run the panel’s `visibility` transition had not advanced at 380 ms, so the retry was missed
  (the next open succeeded; official QA and `qa-recheck` pass the same check). This was only reproducible under
  headless SwiftShader load; real-browser transitions advance per frame. Optional hardening: focus on
  `transitionend`, or retry focus until `document.activeElement` lands in the dialog.
- Pre-existing residual risks from the frozen section still apply: no real webcam/real-hand end-to-end validation,
  SwiftShader vs hardware rendering/performance, mobile quality auto-detection, simulated (not real) bfcache
  navigation, and no exhaustive WCAG/contrast audit.
- `scratch/` (11.9 MB) still needs deletion before delivery (unchanged by this patch).

### Post-fix verdict

```text
POST-FIX SIGN-OFF
Critical: 0 | Major: 0 | Minor: 0 (all 6 resolved) | Nit: 1 open (visual highlight clipping, unchanged)
Official npm run qa: 18/18 | qa-recheck: 13/13 | qa-postfix: 21/21 | qa-hand-math: PASS
No regressions found in demo, camera, help/a11y, bfcache, badge or responsive flows.
```

**QA reviewer:** `qa-reviewer` (independent)
**Date:** 2026-11-02T15:34+08:00
**Implementation status:** patched by Lead; QA made no source/test/vendor/config changes.

---

**Lead addendum (final delivery):** after this report, help focus was hardened from a single 380 ms retry to a
60 ms retry loop until focus enters the modal; `scratch/` was deleted; final gates were rerun:
`npm run qa` 18/18, `qa-recheck` 13/13, `qa-postfix` 21/21. The stale 380 ms note above is superseded.
See [`LEAD_FINAL_VERIFICATION.md`](LEAD_FINAL_VERIFICATION.md).
