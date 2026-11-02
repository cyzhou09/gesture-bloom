/**
 * Static project self-check: no browser required.
 * Run: npm run check
 */
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

async function exists(relative, minBytes = 1) {
  try {
    const info = await stat(join(ROOT, relative));
    if (!info.isFile()) return fail(`${relative}: not a file`);
    if (info.size < minBytes) return fail(`${relative}: only ${info.size} bytes (expected >= ${minBytes})`);
    notes.push(`${relative} — ${(info.size / 1024).toFixed(1)} KB`);
    return true;
  } catch {
    fail(`${relative}: missing`);
    return false;
  }
}

for (const file of [
  'index.html', 'styles.css', 'start.bat', 'src/main.js', 'src/flower.js',
  'src/handTracking.js', 'serve.mjs', 'package.json', 'README.md',
  '.nojekyll', '.github/workflows/pages.yml',
]) {
  await exists(file);
}

for (const file of [
  'vendor/three.module.js',
  'vendor/three.core.js',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'vendor/models/hand_landmarker.task',
]) {
  await exists(file, 10_000);
}

// JS syntax check via Node's built-in parser.
const jsFiles = [
  'src/main.js', 'src/flower.js', 'src/handTracking.js', 'serve.mjs',
  'tests/check.mjs', 'tests/browser-qa.mjs',
];
for (const file of jsFiles) {
  try {
    await execFileAsync(process.execPath, ['--check', join(ROOT, file)], { timeout: 20_000 });
  } catch (error) {
    fail(`${file}: syntax error — ${(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}

const requiredIds = [
  'scene', 'app', 'header', 'status-pill', 'status-text', 'help-button', 'help-panel',
  'help-close', 'intro', 'intro-title', 'intro-subtitle', 'enter-camera', 'enter-demo',
  'intro-status', 'intro-progress', 'intro-note', 'hud', 'gesture-card', 'gesture-name',
  'gesture-desc', 'bloom-fill', 'bloom-value', 'tracker-panel', 'camera-video',
  'landmark-canvas', 'tracker-state', 'tracker-toggle', 'mode-badge', 'toast',
  'hide-ui', 'show-ui',
];

const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const css = await readFile(join(ROOT, 'styles.css'), 'utf8');
const main = await readFile(join(ROOT, 'src/main.js'), 'utf8');
const handTracking = await readFile(join(ROOT, 'src/handTracking.js'), 'utf8');
const bat = await readFile(join(ROOT, 'start.bat'), 'utf8');
const server = await readFile(join(ROOT, 'serve.mjs'), 'utf8');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
for (const id of requiredIds) {
  if (!ids.includes(id)) fail(`index.html: missing required element #${id}`);
}
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) fail(`index.html: duplicate ids: ${[...new Set(duplicates)].join(', ')}`);

if (!/type="importmap"/.test(html) || !/"three"\s*:\s*"\.\/vendor\/three\.module\.js"/.test(html)) {
  fail('index.html: missing / invalid relative three import map');
}
if (!/type="module"\s+src="\.\/src\/main\.js"/.test(html)) {
  fail('index.html: missing module script ./src/main.js');
}
if (!/href="\.\/styles\.css"/.test(html)) fail('index.html: missing ./styles.css stylesheet');
if (/["']\/(?:vendor|src)\//.test(html)) {
  fail('index.html: root-absolute asset paths break GitHub Pages sub-path hosting');
}
if (!/\bmuted\b/.test(html) || !/\bplaysinline\b/i.test(html)) {
  fail('index.html: camera video must be muted and playsinline');
}
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attrs]) => !/\bsrc\s*=/.test(attrs) && !/type\s*=\s*["']importmap["']/i.test(attrs));
if (inlineScripts.some(([, , body]) => body.trim())) {
  fail('index.html: inline JavaScript is not allowed (importmap is fine)');
}

const externalUrls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]);
if (externalUrls.length) fail(`index.html: external runtime assets: ${externalUrls.join(', ')}`);
if (/@import\s+url\(["']?https?:/i.test(css)) fail('styles.css: external @import detected');
if (/url\(["']?https?:/i.test(css)) fail('styles.css: external url() asset detected');

for (const hook of [
  'body.is-live', 'intro.is-hidden', 'is-collapsed', 'help-panel.is-open',
  'toast.is-visible', 'body.ui-hidden', 'body.is-demo',
]) {
  if (!css.includes(hook)) fail(`styles.css: missing required state hook "${hook}"`);
}

const importMap = new Map();
for (const [, name, path] of html.matchAll(/["']?([\w@/-]+)["']?\s*:\s*["']([^"']+)["']/g)) {
  importMap.set(name, path);
}
for (const [name, path] of importMap) {
  if (path.startsWith('/') && !path.startsWith('//')) continue;
}

if (!main.includes("from './flower.js'")) fail('src/main.js: does not import ./flower.js');
if (!main.includes("from './handTracking.js'")) fail('src/main.js: does not import ./handTracking.js');
if (!/requestAnimationFrame/.test(main)) fail('src/main.js: no render loop');
if (/['"]\/(?:vendor|src)\//.test(handTracking)) {
  fail('src/handTracking.js: root-absolute asset path breaks GitHub Pages sub-path hosting');
}
if (!/new URL\('\.\.\/vendor\/', import\.meta\.url\)/.test(handTracking)) {
  fail('src/handTracking.js: MediaPipe assets should resolve from import.meta.url');
}

if (!/node serve\.mjs --open --port %PORT%/.test(bat)) {
  fail('start.bat: should launch `node serve.mjs --open --port %PORT%`');
}
if (!/cd \/d "%~dp0"/.test(bat)) fail('start.bat: should cd to its own folder');
if (!/serve\.mjs --open/.test(server) || !/function openBrowser/.test(server)) {
  fail('serve.mjs: missing --open browser launcher support');
}

const pagesWorkflow = await readFile(join(ROOT, '.github/workflows/pages.yml'), 'utf8');
if (!/actions\/deploy-pages@v4/.test(pagesWorkflow) || !/actions\/upload-pages-artifact@v3/.test(pagesWorkflow)) {
  fail('GitHub Pages workflow is missing the official deploy/upload actions');
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n`);
  for (const message of failures) console.error(`  • ${message}`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 指尖花 static check passed');
  console.log(`  ${notes.length} files verified, ${requiredIds.length} required DOM ids present.\n`);
  for (const note of notes) console.log(`  · ${note}`);
  console.log('');
}
