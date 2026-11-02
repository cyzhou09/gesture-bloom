/**
 * Headless Chrome smoke test + screenshot generator.
 *
 *   node tests/browser-qa.mjs
 *   BASE_URL=http://localhost:4173 node tests/browser-qa.mjs
 *
 * If BASE_URL is not supplied, a local static server is started on :4179.
 * Requires Chrome/Edge (override with CHROME_PATH). Uses the DevTools Protocol
 * directly, so no npm dependencies are needed.
 *
 * Outputs:
 *   qa/intro-desktop.png
 *   qa/demo-desktop.png
 *   qa/demo-mobile.png
 *   qa/camera-fake.png         (headless fake camera; usually no hand detected)
 *   qa/qa-report.json
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const execFileAsync = promisify(execFile);

if (typeof WebSocket !== 'function') {
  console.error('This QA harness uses the built-in WebSocket client and requires Node.js 22 or newer.');
  process.exit(1);
}

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const QA_DIR = join(ROOT, 'qa');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: '',
  chrome: '',
  checks: [],
  consoleErrors: [],
  networkErrors: [],
  screenshots: [],
  camera: null,
};

let serverProcess = null;
let chromeProcess = null;
let userDataDir = null;
let cdp = null;
let baseUrl = process.env.BASE_URL || '';

function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fetchOk(url, timeout = 2000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (baseUrl) {
    if (!(await fetchOk(baseUrl, 4000))) throw new Error(`BASE_URL is not reachable: ${baseUrl}`);
    report.baseUrl = baseUrl;
    return;
  }

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  report.baseUrl = baseUrl;
  serverProcess = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--port', String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 80; i += 1) {
    if (await fetchOk(baseUrl)) return;
    await sleep(150);
  }
  throw new Error('Local server did not start.');
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function startChrome() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  report.chrome = chromePath;
  const port = await freePort();
  userDataDir = await mkdtemp(join(tmpdir(), 'bloom-qa-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--hide-scrollbars',
    '--window-size=1440,900',
    '--force-device-scale-factor=1',
    // SwiftShader keeps WebGL available on headless CI machines.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    // Camera lifecycle tests work without a real webcam.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    'about:blank',
  ];
  chromeProcess = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (await fetchOk(`${base}/json/version`, 1000)) break;
    if (i === 99) throw new Error('Chrome DevTools endpoint did not become ready.');
    await sleep(150);
  }

  const list = await (await fetch(`${base}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No page target found.');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  return base;
}

/* --------------------------------------------------------------------------
   Minimal DevTools Protocol client (Node >= 22 has global WebSocket)
   -------------------------------------------------------------------------- */
class CDP {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${event?.message ?? 'unknown'}`));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params);
        } catch (error) {
          console.error('CDP listener failed:', error);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  once(method, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
      const listener = (params) => {
        clearTimeout(timer);
        const list = this.listeners.get(method) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
  }
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'evaluation exception';
    throw new Error(text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 15_000, interval = 180) {
  const end = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < end) {
    try {
      if (await evaluate(expression)) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  if (lastError) throw lastError;
  return false;
}

async function navigate(url) {
  const loaded = cdp.once('Page.loadEventFired', 20_000).catch(() => null);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await waitFor('document.readyState === "complete"', 15_000);
}

async function setupPage() {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    report.consoleErrors.push({
      type: 'exception',
      text: exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'unknown exception',
    });
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error') return;
    const text = (args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.type)
      .join(' ');
    if (text) report.consoleErrors.push({ type: 'console.error', text });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry?.level === 'error') report.consoleErrors.push({ type: 'log', text: entry.text ?? '' });
  });
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response?.status >= 400 && response.url.startsWith(baseUrl)) {
      report.networkErrors.push({ status: response.status, url: response.url });
    }
  });
  cdp.on('Network.loadingFailed', ({ errorText, type, requestId }) => {
    if (type === 'Image' || type === 'Font' || type === 'Stylesheet' || type === 'Script') {
      report.consoleErrors.push({ type: `network.${type}`, text: `${errorText} (${requestId})` });
    }
  });
}

async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = join(QA_DIR, name);
  await writeFile(file, Buffer.from(data, 'base64'));
  report.screenshots.push(file);
  console.log(`  captured qa/${name}`);
}

async function main() {
  await mkdir(QA_DIR, { recursive: true });
  await ensureServer();
  console.log(`\nServer: ${baseUrl}`);
  await startChrome();
  await setupPage();

  // 1. Intro / idle scene, desktop
  await navigate(baseUrl);
  const ready = await waitFor('window.__BLOOM_READY__ === true', 15_000);
  check('WebGL scene boots', ready);
  await sleep(2400);
  const intro = await evaluate(`({
    mode: window.__BLOOM__?.mode,
    live: window.__BLOOM__?.live,
    hasWebgl: !!document.querySelector('#scene'),
    title: document.querySelector('#intro-title')?.textContent?.trim()?.slice(0, 40),
    introVisible: !document.body.classList.contains('is-live')
  })`);
  check('Intro is interactive and scene is alive', intro.mode === 'intro' && intro.introVisible, JSON.stringify(intro));
  await screenshot('intro-desktop.png');

  // 2. Demo mode, desktop — wait for a bloom window in the 12s loop.
  await navigate(`${baseUrl}/?demo=1`);
  const demoLive = await waitFor('window.__BLOOM__?.mode === "demo"', 15_000);
  check('Demo mode starts without camera', demoLive);

  // The 12s demo loop starts with a closed bud, then opens. Capture both states.
  // Keep the bud screenshot inside the closed hold (0–1.9 s) so the HUD and the
  // geometry are in the same state when the frame is captured.
  await sleep(900);
  const bud = await evaluate(`({
    mode: window.__BLOOM__?.mode,
    bloom: window.__BLOOM__?.bloom,
    gesture: window.__BLOOM__?.hand?.gesture
  })`);
  check('Demo closes into a bud', bud.bloom < 0.36 && bud.gesture === 'fist', `bloom=${Number(bud.bloom).toFixed(2)}, gesture=${bud.gesture}`);
  await screenshot('demo-bud.png');

  await sleep(4200);
  const demo = await evaluate(`({
    mode: window.__BLOOM__?.mode,
    live: window.__BLOOM__?.live,
    bloom: window.__BLOOM__?.bloom,
    hand: window.__BLOOM__?.hand?.gesture,
    introHidden: document.querySelector('#intro')?.getAttribute('aria-hidden') === 'true',
    hudVisible: getComputedStyle(document.querySelector('#hud')).display !== 'none'
  })`);
  check('Demo drives flower bloom', demo.bloom > 0.55, `bloom=${Number(demo.bloom).toFixed(2)}, gesture=${demo.hand}`);
  check('HUD visible / intro hidden in demo', demo.hudVisible && demo.introHidden, JSON.stringify(demo));
  await screenshot('demo-desktop.png');

  // Help dialog and chrome visibility.
  await evaluate(`document.getElementById('help-button')?.click()`);
  await waitFor(`document.getElementById('help-panel')?.classList.contains('is-open')`, 4000);
  await sleep(500); // let the visibility/opacity transition finish for focus + hit-testing
  const help = await evaluate(`({
    open: document.getElementById('help-panel')?.classList.contains('is-open'),
    hidden: document.getElementById('help-panel')?.getAttribute('aria-hidden'),
    expanded: document.getElementById('help-button')?.getAttribute('aria-expanded'),
    activeInDialog: document.getElementById('help-panel')?.contains(document.activeElement),
    activeId: document.activeElement?.id
  })`);
  check('Help dialog opens accessibly', help.open && help.hidden === 'false' && help.expanded === 'true', JSON.stringify(help));
  check('Help moves focus into the dialog', help.activeInDialog === true, JSON.stringify(help));
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
  });
  const trapped = await evaluate(`({
    activeInDialog: document.getElementById('help-panel')?.contains(document.activeElement),
    activeId: document.activeElement?.id
  })`);
  check('Help keeps Tab focus inside the modal', trapped.activeInDialog === true, JSON.stringify(trapped));
  await screenshot('help-desktop.png');
  await evaluate(`document.getElementById('help-close')?.click()`);
  await waitFor(`!document.getElementById('help-panel')?.classList.contains('is-open')`, 4000);
  const helpClosed = await evaluate(`({
    activeId: document.activeElement?.id,
    expanded: document.getElementById('help-button')?.getAttribute('aria-expanded')
  })`);
  check('Help restores focus on close', helpClosed.activeId === 'help-button' && helpClosed.expanded === 'false', JSON.stringify(helpClosed));

  await evaluate(`document.getElementById('hide-ui')?.click()`);
  const hidden = await evaluate(`document.body.classList.contains('ui-hidden')`);
  await evaluate(`document.getElementById('show-ui')?.click()`);
  const shown = await evaluate(`!document.body.classList.contains('ui-hidden')`);
  check('Hide / restore chrome works', hidden && shown, `hidden=${hidden}, restored=${shown}`);

  // 3. Demo mode, mobile
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  await navigate(`${baseUrl}/?demo=1`);
  await waitFor('window.__BLOOM__?.mode === "demo"', 15_000);
  await sleep(4800);
  const mobile = await evaluate(`({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bloom: window.__BLOOM__?.bloom,
    cameraPanel: getComputedStyle(document.querySelector('#tracker-panel')).display
  })`);
  check('Mobile layout fits viewport', mobile.scrollWidth <= mobile.width + 1, JSON.stringify(mobile));
  await screenshot('demo-mobile.png');

  // 4. Camera lifecycle with a synthetic device. There is no hand in the fake
  //    stream, but camera + WASM + model + overlay loader must all work.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  await evaluate(`document.getElementById('enter-camera')?.click()`);
  const cameraOutcome = await waitFor(
    `document.body.classList.contains('is-live') || document.querySelector('#intro')?.dataset.state === 'error'`,
    35_000,
  );
  await sleep(1600);
  const camera = await evaluate(`({
    live: window.__BLOOM__?.live,
    mode: window.__BLOOM__?.mode,
    trackerRunning: window.__BLOOM__?.trackerRunning,
    introState: document.querySelector('#intro')?.dataset.state,
    introStatus: document.querySelector('#intro-status')?.textContent?.trim(),
    trackerState: document.querySelector('#tracker-state')?.textContent?.trim(),
    videoReady: (document.querySelector('#camera-video')?.readyState ?? 0) >= 2,
    videoWidth: document.querySelector('#camera-video')?.videoWidth ?? 0,
    overlayWidth: document.querySelector('#landmark-canvas')?.width ?? 0,
    badgeText: document.querySelector('#mode-badge')?.textContent?.trim(),
    badgeDataMode: document.querySelector('#mode-badge')?.dataset.mode,
    badgeColor: getComputedStyle(document.querySelector('#mode-badge')).color
  })`);
  report.camera = camera;
  check('Camera stream + MediaPipe model initialize', camera.live && camera.trackerRunning, JSON.stringify(camera));
  check('Video frames and overlay canvas are ready', camera.videoReady && camera.videoWidth > 0 && camera.overlayWidth > 0);
  check('LIVE badge uses live mint styling', camera.badgeText === 'LIVE' && camera.badgeDataMode === 'live' && /143,\s*217,\s*196/.test(camera.badgeColor), JSON.stringify(camera));
  if (camera.live) await screenshot('camera-fake.png');

  // Simulate a bfcache round-trip: pagehide must stop tracks, pageshow must not
  // leave a stale LIVE HUD pointing at a dead camera.
  if (camera.live) {
    await evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`);
    await sleep(350);
    await evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    const recovered = await waitFor(
      `window.__BLOOM__?.mode === 'intro' && !document.body.classList.contains('is-live') && document.querySelector('#intro')?.dataset.state === 'error'`,
      6000,
    );
    const recovery = await evaluate(`({
      mode: window.__BLOOM__?.mode,
      live: window.__BLOOM__?.live,
      trackerRunning: window.__BLOOM__?.trackerRunning,
      introState: document.querySelector('#intro')?.dataset.state,
      introStatus: document.querySelector('#intro-status')?.textContent?.trim(),
      cameraDisabled: document.getElementById('enter-camera')?.disabled,
      demoDisabled: document.getElementById('enter-demo')?.disabled
    })`);
    check(
      'bfcache restore recovers to intro with retry CTA',
      recovered && !recovery.cameraDisabled && !recovery.demoDisabled && recovery.trackerRunning === false,
      JSON.stringify(recovery),
    );
  }

  const fatalErrors = report.consoleErrors.filter((entry) => {
    const text = entry.text ?? '';
    return !/favicon|Autoplay|Permissions-Policy|WebGL.*deprecated|GroupMarkerNotSet|SwiftShader/i.test(text);
  });
  if (fatalErrors.length) {
    check('No console errors', false, `${fatalErrors.length} error(s): ${fatalErrors.slice(0, 2).map((e) => e.text.slice(0, 120)).join(' | ')}`);
  } else {
    check('No console errors', true);
  }
  check('No failed local requests', report.networkErrors.length === 0, `${report.networkErrors.length} failing request(s)`);

  if (cameraOutcome === false) check('Camera lifecycle completed', false, 'timed out waiting for live/error state');

  report.finishedAt = new Date().toISOString();
  await writeFile(join(QA_DIR, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const failed = report.checks.filter((entry) => !entry.ok);
  console.log(`\n${failed.length ? '✗' : '✓'} Browser QA: ${report.checks.length - failed.length}/${report.checks.length} checks passed.`);
  console.log(`  report: qa/qa-report.json`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const item of failed) console.log(`  • ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error('\nBrowser QA crashed:', error);
  report.error = String(error?.stack ?? error);
  try {
    await mkdir(QA_DIR, { recursive: true });
    await writeFile(join(QA_DIR, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (chromeProcess?.pid) {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(chromeProcess.pid), '/T', '/F']).catch(() => {});
    } else {
      chromeProcess.kill('SIGKILL');
    }
  }
  if (serverProcess?.pid) serverProcess.kill();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
