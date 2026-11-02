# Lead final verification addendum

**Date:** 2026-11-02 15:3x (Asia/Shanghai)
**Scope:** final delivery tree after the post-fix patch. This addendum corrects two stale notes in
`qa/QA_REPORT.md` (which was written before the last focus-hardening tweak) and records the final gates.

## Final gates

| Gate | Result |
| --- | --- |
| `npm run check` | PASS — 16 files, 31 required DOM ids, no external assets, no inline JS |
| `node --check` on all shipped JS | PASS |
| `npm run qa` | **18/18** — intro, demo bud/open, help focus/trap/restore, mobile, fake-camera init, LIVE mint badge, bfcache recovery, no console errors/network failures |
| `qa/qa-recheck.mjs` | **13/13** |
| `qa/qa-postfix.mjs` | **21/21** |
| `qa/qa-hand-math.mjs` | PASS |
| Headless camera lifecycle | fake 1280×720 stream + real MediaPipe GPU init, trackerRunning=true, 0 app console errors |
| Local server MIME | `.mjs` text/javascript, `.wasm` application/wasm, `.task` application/octet-stream |
| Runtime network audit | 0 external requests; 0 failed local requests |

## Corrections to the QA report

1. **Deferred help focus is no longer a single 380 ms retry.** Final `src/main.js` retries
   `focusHelpControl()` every 60 ms (up to 24 attempts) until focus lands inside the open modal; it also
   clears the timer on close. The QA post-fix run passed “Help open moves focus into the dialog” on
   attempt 1 (`qa/qa-postfix.json`). This removes the residual headless-only transition-stall risk from
   the QA report's “Residual risk after fixes” paragraph.
2. **`scratch/` has been deleted.** The final tree contains only the application, vendor files, tests,
   docs and QA evidence; total size is ~50 MB.

## Accepted known nit (non-blocking)

- **NIT-1 additive highlight clipping:** the bud tip / upper bloom core clips toward white at
  `TUNING.exposure = 1.55`. It is intentional-looking bioluminescence and does not affect usability;
  left unchanged to avoid invalidating the approved visual build.

## Residual risks (unchanged)

No physical webcam/hand was available in this environment. MediaPipe loading and inference were
exercised with Chrome's synthetic camera (no hand present); the gesture math was validated against
synthetic 21-landmark hands. Headless Chrome used SwiftShader, so real-GPU frame pacing/performance
and real-device mobile behavior still need a human webcam pass. All of these are environment limits,
not known defects.

## GitHub Pages deployment

- Repository: <https://github.com/cyzhou09/gesture-bloom>
- Live site: <https://cyzhou09.github.io/gesture-bloom/>
- GitHub Actions workflow run: **success** (`Deploy to GitHub Pages`, build + deploy).
- GitHub Pages serves the required MIME types correctly: `.mjs` → `text/javascript`,
  `.js` → `application/javascript`, `.wasm` → `application/wasm`, `.task` → `application/octet-stream`.
- `BASE_URL=https://cyzhou09.github.io/gesture-bloom npm run qa` → **18/18 checks passed**
  on the live HTTPS site (WebGL boot, demo bud/bloom, help/a11y, mobile, MediaPipe camera
  initialization with synthetic camera, 0 console errors, 0 failed requests).
- The app is hosted under a GitHub Pages sub-path; all imports and MediaPipe WASM/model paths
  resolve via relative URLs / `import.meta.url`. A local sub-path simulation also passed 18/18.

**Final verdict: ready to deliver.**
