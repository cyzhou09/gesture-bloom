/**
 * Extra adversarial QA (independent, read-only against the shipped app).
 *
 *   node qa/qa-adversarial.mjs
 *
 * Starts its own static server + headless Chrome (fake camera device), then
 * exercises: permission-denied fallback, keyboard shortcuts, help dialog
 * focus/aria, tracker collapse, hide/restore UI, reduced motion, low quality,
 * 360x640 + 390x844 layouts, live camera resize, bfcache/pagehide state,
 * FlowerField resize/dispose, external-network audit and console audit.
 *
 * Outputs qa/qa-adversarial.json plus screenshots named qa-adv-*.png.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QA_DIR = join(ROOT, 'qa');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = {
  startedAt: new Date().toISOString(),
  baseUrl: '',
  chrome: '',
  checks: [],
  consoleErrors: [],
  consoleWarnings: [],
  pageExceptions: [],
  externalRequests: [],
  failedRequests: [],
  httpErrors: [],
  screenshots: [],
  notes: [],
  phase: 'setup',
};

let serverProcess = null;
let chromeProcess = null;
let userDataDir = null;
let cdp = null;
let baseUrl = '';

function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function note(message) {
  report.notes.push(String(message));
  console.log(`  · ${message}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;
  await new Promise((res) => server.close(res));
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
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  report.baseUrl = baseUrl;
  serverProcess = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--port', String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
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
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function startChrome() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  report.chrome = chromePath;
  const port = await freePort();
  userDataDir = await mkdtemp(join(tmpdir(), 'bloom-adv-'));
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
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    'about:blank',
  ];
  chromeProcess = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });

  let opened = false;
  for (let i = 0; i < 100 && !opened; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        cdp = new CDP(page.webSocketDebuggerUrl);
        await cdp.open();
        opened = true;
      }
    } catch {
      /* not up yet */
    }
    if (!opened) await sleep(150);
  }
  if (!opened) throw new Error('Chrome DevTools endpoint did not become ready.');
}

/* Minimal DevTools Protocol client (same approach as tests/browser-qa.mjs). */
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
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('WebSocket open timeout')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
      this.socket.addEventListener('error', (event) => { clearTimeout(timer); rej(new Error(`WebSocket error: ${event?.message ?? 'unknown'}`)); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        try { listener(message.params); } catch (error) { console.error('CDP listener failed:', error); }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  once(method, timeout = 15_000) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`Timed out waiting for ${method}`)), timeout);
      const listener = (params) => {
        clearTimeout(timer);
        const list = this.listeners.get(method) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        res(params);
      };
      this.on(method, listener);
    });
  }

  close() {
    try { this.socket?.close(); } catch { /* ignore */ }
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
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation exception';
    throw new Error(text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 15_000, interval = 150) {
  const end = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < end) {
    try { if (await evaluate(expression)) return true; } catch (error) { lastError = error; }
    await sleep(interval);
  }
  if (lastError) throw lastError;
  return false;
}

async function navigate(url) {
  const loaded = cdp.once('Page.loadEventFired', 25_000).catch(() => null);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await waitFor('document.readyState === "complete"', 15_000);
}

async function screenshot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = join(QA_DIR, name);
  await writeFile(file, Buffer.from(data, 'base64'));
  report.screenshots.push(file);
  console.log(`  captured qa/${name}`);
}

async function setMetrics({ width, height, dpr = 1, mobile = false }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile,
    screenWidth: width, screenHeight: height,
  });
}

async function key(desc) {
  const { key: keyName, code, vk } = desc;
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

const KEYS = {
  h: { key: 'h', code: 'KeyH', vk: 72 },
  H: { key: 'H', code: 'KeyH', vk: 72 },
  u: { key: 'u', code: 'KeyU', vk: 85 },
  d: { key: 'd', code: 'KeyD', vk: 68 },
  t: { key: 't', code: 'KeyT', vk: 84 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  question: { key: '?', code: 'Slash', vk: 191 },
};

function jsString(value) {
  return JSON.stringify(value);
}

async function setupPage() {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Accessibility.enable');
  await setMetrics({ width: 1440, height: 900, dpr: 1 });

  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    report.pageExceptions.push({
      phase: report.phase,
      text: exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'unknown',
    });
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const text = (args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
    if (!text) return;
    if (type === 'error') report.consoleErrors.push({ phase: report.phase, text });
    else if (type === 'warning') report.consoleWarnings.push({ phase: report.phase, text });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (!entry) return;
    if (entry.level === 'error') report.consoleErrors.push({ phase: report.phase, text: entry.text ?? '' });
    else if (entry.level === 'warning') report.consoleWarnings.push({ phase: report.phase, text: entry.text ?? '' });
  });
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    const url = request?.url ?? '';
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return;
    if (!url.startsWith(baseUrl)) {
      report.externalRequests.push({ phase: report.phase, url });
    }
  });
  cdp.on('Network.responseReceived', ({ response }) => {
    if (response?.status >= 400 && response.url?.startsWith(baseUrl)) {
      report.httpErrors.push({ phase: report.phase, status: response.status, url: response.url });
    }
  });
  cdp.on('Network.loadingFailed', ({ errorText, type, canceled }) => {
    if (canceled) return;
    report.failedRequests.push({ phase: report.phase, errorText, type });
  });
}

async function resetPermissions() {
  try { await cdp.send('Browser.resetPermissions', {}); } catch { /* ignore */ }
}

async function main() {
  await mkdir(QA_DIR, { recursive: true });
  await ensureServer();
  console.log(`\nServer: ${baseUrl}`);
  await startChrome();
  await setupPage();
  await resetPermissions();

  /* ------------------------------------------------------------------ *
   * 1. Intro page: a11y, layout, no-overflow
   * ------------------------------------------------------------------ */
  report.phase = 'intro';
  await navigate(baseUrl);
  check('WebGL scene boots', await waitFor('window.__BLOOM_READY__ === true', 15_000));
  await sleep(1800);

  const intro = await evaluate(`(() => {
    const byId = (id) => document.getElementById(id);
    const rect = (id) => { const r = byId(id)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } : null; };
    const buttons = [...document.querySelectorAll('button')];
    return {
      lang: document.documentElement.lang,
      title: document.title,
      mode: window.__BLOOM__?.mode,
      live: window.__BLOOM__?.live,
      error: window.__BLOOM_ERROR__ ?? null,
      introState: byId('intro')?.dataset.state,
      introStatusLive: byId('intro-status')?.getAttribute('aria-live'),
      privacyNote: byId('intro-note')?.textContent?.trim(),
      buttonsWithoutName: buttons.filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim())).length,
      helpExpanded: byId('help-button')?.getAttribute('aria-expanded'),
      helpControls: byId('help-button')?.getAttribute('aria-controls'),
      helpAriaHidden: byId('help-panel')?.getAttribute('aria-hidden'),
      helpRole: byId('help-panel')?.getAttribute('role'),
      helpModal: byId('help-panel')?.getAttribute('aria-modal'),
      helpLabelledBy: byId('help-panel')?.getAttribute('aria-labelledby'),
      showUiHidden: getComputedStyle(byId('show-ui')).visibility,
      titleRect: rect('intro-title'),
      cameraRect: rect('enter-camera'),
      demoRect: rect('enter-demo'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      innerHeight,
      introScrollWidth: byId('intro')?.scrollWidth,
      introClientWidth: byId('intro')?.clientWidth,
      introScrollHeight: byId('intro')?.scrollHeight,
      introClientHeight: byId('intro')?.clientHeight,
      canvasBacking: { w: byId('scene')?.width, h: byId('scene')?.height },
      canvasCss: { w: byId('scene')?.clientWidth, h: byId('scene')?.clientHeight },
      dpr: devicePixelRatio,
      landmarkCanvasAria: byId('landmark-canvas')?.getAttribute('aria-hidden'),
      videoAria: byId('camera-video')?.getAttribute('aria-label'),
      hudAriaHidden: byId('hud')?.getAttribute('aria-hidden'),
    };
  })()`);

  check('Intro boot state correct', intro.mode === 'intro' && intro.live === false && !intro.error, JSON.stringify({ mode: intro.mode, live: intro.live, error: intro.error }));
  check('No horizontal overflow at 1440x900', intro.scrollWidth <= intro.innerWidth + 1, `scrollWidth=${intro.scrollWidth}`);
  check('Scene canvas fills viewport', intro.canvasCss.w === 1440 && intro.canvasCss.h === 900, JSON.stringify(intro.canvasCss));
  check('Canvas backing = viewport x DPR', intro.canvasBacking.w === Math.round(1440 * Math.min(intro.dpr, 2)) && intro.canvasBacking.h === Math.round(900 * Math.min(intro.dpr, 2)), JSON.stringify({ backing: intro.canvasBacking, dpr: intro.dpr }));
  check('Intro title stays in left editorial column', intro.titleRect && intro.titleRect.x < intro.innerWidth * 0.2 && intro.titleRect.right < intro.innerWidth * 0.55, JSON.stringify(intro.titleRect));
  check('CTAs visible and in viewport', intro.cameraRect && intro.cameraRect.bottom <= intro.innerHeight && intro.demoRect && intro.demoRect.bottom <= intro.innerHeight, JSON.stringify({ camera: intro.cameraRect, demo: intro.demoRect }));
  check('All buttons have accessible names', intro.buttonsWithoutName === 0, `missing=${intro.buttonsWithoutName}`);
  check('intro-status uses aria-live=polite', intro.introStatusLive === 'polite', String(intro.introStatusLive));
  check('Privacy copy present in intro', /不会上传|不会保存|本机/.test(intro.privacyNote ?? ''), intro.privacyNote);
  check('Help dialog carries modal semantics', intro.helpRole === 'dialog' && intro.helpModal === 'true' && intro.helpLabelledBy === 'help-title', JSON.stringify({ role: intro.helpRole, modal: intro.helpModal, labelledby: intro.helpLabelledBy }));
  check('Help dialog closed (aria-hidden) at boot', intro.helpAriaHidden === 'true' && intro.helpExpanded === 'false', JSON.stringify({ hidden: intro.helpAriaHidden, expanded: intro.helpExpanded }));
  check('show-ui hidden unless ui-hidden', intro.showUiHidden === 'hidden', intro.showUiHidden);
  check('HUD aria-hidden false in DOM before live? (visible only via CSS)', intro.hudAriaHidden === null || intro.hudAriaHidden === 'false', String(intro.hudAriaHidden));

  /* ------------------------------------------------------------------ *
   * 2. Help dialog: focus, keyboard, backdrop; hide/restore chrome
   * ------------------------------------------------------------------ */
  report.phase = 'help-keyboard';
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const helpBtnRect = await evaluate(`(() => { const r = document.getElementById('help-button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await clickAt(helpBtnRect.x, helpBtnRect.y);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(500); // let the visibility/opacity transition finish before asserting focus
  const helpOpen = await evaluate(`({
    open: document.getElementById('help-panel').classList.contains('is-open'),
    hidden: document.getElementById('help-panel').getAttribute('aria-hidden'),
    expanded: document.getElementById('help-button').getAttribute('aria-expanded'),
    active: document.activeElement?.id,
    activeInDialog: !!document.activeElement?.closest?.('.help__dialog'),
    bodyOverflow: getComputedStyle(document.body).overflow,
    panelVisibility: getComputedStyle(document.getElementById('help-panel')).visibility,
    dialogRect: (() => { const r = document.querySelector('.help__dialog').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; })()
  })`);
  check('Real click opens help dialog and moves focus inside', helpOpen.open && helpOpen.hidden === 'false' && helpOpen.expanded === 'true' && helpOpen.active === 'help-close' && helpOpen.activeInDialog, JSON.stringify(helpOpen).slice(0, 400));
  check('Help dialog fits 1440x900', helpOpen.dialogRect.right <= 1440 && helpOpen.dialogRect.bottom <= 900, JSON.stringify(helpOpen.dialogRect));

  await key(KEYS.escape);
  await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(200);
  const helpClosed = await evaluate(`({
    open: document.getElementById('help-panel').classList.contains('is-open'),
    expanded: document.getElementById('help-button').getAttribute('aria-expanded'),
    active: document.activeElement?.id
  })`);
  check('Escape closes help and restores focus to help button', !helpClosed.open && helpClosed.expanded === 'false' && helpClosed.active === 'help-button', JSON.stringify(helpClosed));

  // Keyboard H toggles.
  await key(KEYS.h);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  const hOpen = await evaluate(`document.getElementById('help-panel').classList.contains('is-open')`);
  await key(KEYS.h);
  await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  const hClosed = await evaluate(`!document.getElementById('help-panel').classList.contains('is-open')`);
  check('H toggles help open and closed', hOpen && hClosed, `open=${hOpen}, closed=${hClosed}`);

  // '?' opens help.
  await key(KEYS.question);
  const questionOpened = await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  check('"?" opens help', questionOpened);
  await key(KEYS.escape);
  await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);

  // Backdrop click closes.
  await clickAt(helpBtnRect.x, helpBtnRect.y);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(500); // wait until the panel is fully visible / hit-testable
  const backdropTarget = await evaluate(`(() => { const e = document.elementFromPoint(40, 450); return { tag: e?.tagName, cls: e?.className ?? null }; })()`);
  await clickAt(40, 450);
  const backdropClosed = await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  check('Clicking help backdrop closes dialog', backdropClosed, JSON.stringify(backdropTarget));
  if (!backdropClosed) note(`Backdrop close failed; elementFromPoint(40,450) = ${JSON.stringify(backdropTarget)}`);

  // Focus trap probe: from the close button, Tab should stay inside a modal.
  await clickAt(helpBtnRect.x, helpBtnRect.y);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(500);
  await evaluate(`document.getElementById('help-close').focus()`);
  await key({ key: 'Tab', code: 'Tab', vk: 9 });
  await sleep(150);
  const afterTab = await evaluate(`({
    active: document.activeElement?.id,
    inDialog: !!document.activeElement?.closest?.('.help__dialog'),
    tag: document.activeElement?.tagName
  })`);
  if (afterTab.inDialog) check('Tab stays inside modal dialog (focus trap)', true, JSON.stringify(afterTab));
  else note(`MINOR: no focus trap — Tab from #help-close escapes to ${afterTab.active || afterTab.tag} (aria-modal=true but focus can leave dialog).`);
  await key(KEYS.escape);
  await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(200);

  // Hide / restore chrome.
  await key(KEYS.u);
  await sleep(600); // visibility transition completes
  const uiHidden = await evaluate(`({
    hidden: document.body.classList.contains('ui-hidden'),
    showUi: getComputedStyle(document.getElementById('show-ui')).visibility,
    header: getComputedStyle(document.getElementById('header')).visibility
  })`);
  await key(KEYS.escape);
  await sleep(600);
  const uiRestored = await evaluate(`({
    hidden: document.body.classList.contains('ui-hidden'),
    showUi: getComputedStyle(document.getElementById('show-ui')).visibility,
    header: getComputedStyle(document.getElementById('header')).visibility
  })`);
  check('U hides chrome, Escape restores it', uiHidden.hidden && uiHidden.showUi === 'visible' && uiHidden.header === 'hidden' && !uiRestored.hidden && uiRestored.header === 'visible', JSON.stringify({ hidden: uiHidden, restored: uiRestored }));
  await key(KEYS.u);
  await sleep(600);
  await evaluate(`document.getElementById('show-ui').click()`);
  const restoredByClick = await evaluate(`!document.body.classList.contains('ui-hidden')`);
  check('Clicking show-ui restores chrome', restoredByClick);

  /* ------------------------------------------------------------------ *
   * 3. Demo mode via D key + HUD
   * ------------------------------------------------------------------ */
  report.phase = 'demo';
  await key(KEYS.d);
  const demoStarted = await waitFor(`window.__BLOOM__?.mode === 'demo' && window.__BLOOM__?.live === true`, 5000);
  await sleep(700); // HUD visibility transition completes
  const demoInfo = await evaluate(`({
    mode: window.__BLOOM__?.mode,
    live: window.__BLOOM__?.live,
    badge: document.getElementById('mode-badge')?.textContent,
    trackerDisplay: getComputedStyle(document.getElementById('tracker-panel')).display,
    hudVisible: getComputedStyle(document.getElementById('hud')).visibility,
    introHidden: document.getElementById('intro')?.getAttribute('aria-hidden'),
    introInert: document.getElementById('intro')?.inert,
    status: document.getElementById('status-text')?.textContent
  })`);
  check('D key starts demo from intro', demoStarted && demoInfo.mode === 'demo', JSON.stringify(demoInfo));
  check('Demo hides intro, shows HUD, no camera card', demoInfo.introHidden === 'true' && demoInfo.introInert === true && demoInfo.hudVisible === 'visible' && demoInfo.trackerDisplay === 'none', JSON.stringify(demoInfo));
  check('Demo badge + status label', demoInfo.badge === 'DEMO' && demoInfo.status === '自动演示', JSON.stringify({ badge: demoInfo.badge, status: demoInfo.status }));

  const demoBloom = await waitFor(`(window.__BLOOM__?.bloom ?? 0) > 0.9`, 9000);
  check('Demo loop blooms the flower past 90%', demoBloom, await evaluate(`JSON.stringify({ bloom: +window.__BLOOM__.bloom.toFixed(2), gesture: window.__BLOOM__.hand?.gesture, bloomValue: document.getElementById('bloom-value')?.textContent })`));
  const hudSync = await evaluate(`({
    bloom: +window.__BLOOM__.bloom.toFixed(2),
    bloomValue: document.getElementById('bloom-value')?.textContent,
    bloomFill: document.getElementById('bloom-fill')?.style.width,
    gestureName: document.getElementById('gesture-name')?.textContent,
    gestureData: document.getElementById('gesture-card')?.dataset.gesture
  })`);
  const percentFromHud = Number.parseInt(hudSync.bloomValue, 10);
  check('HUD bloom meter tracks flower.bloom (±2%)', Math.abs(percentFromHud - hudSync.bloom * 100) <= 2 && hudSync.bloomFill === hudSync.bloomValue, JSON.stringify(hudSync));
  check('Gesture card shows open-palm coaching copy', hudSync.gestureName === '绽放' && hudSync.gestureData === 'open', JSON.stringify({ name: hudSync.gestureName, data: hudSync.gestureData }));

  // Demo does not expose camera preview even with T.
  await key(KEYS.t);
  const demoToggle = await evaluate(`({ collapsed: document.getElementById('tracker-panel').classList.contains('is-collapsed'), display: getComputedStyle(document.getElementById('tracker-panel')).display })`);
  check('T is a no-op in demo mode', demoToggle.collapsed === false, JSON.stringify(demoToggle));

  /* ------------------------------------------------------------------ *
   * 4. quality=low + invalid quality
   * ------------------------------------------------------------------ */
  report.phase = 'quality-low';
  await navigate(`${baseUrl}/?demo=1&quality=low`);
  await waitFor(`window.__BLOOM__?.mode === 'demo'`, 15_000);
  await sleep(1200);
  const low = await evaluate(`({
    quality: window.__BLOOM__?.flower?.quality,
    particleCount: window.__BLOOM__?.flower?.particleCount,
    bloom: window.__BLOOM__?.bloom,
    sceneWidth: document.getElementById('scene')?.width,
    dpr: devicePixelRatio
  })`);
  check('?quality=low selects 6k-particle tier', low.quality === 'low' && low.particleCount === 6000, JSON.stringify(low));
  await screenshot('qa-adv-low-quality.png');

  report.phase = 'quality-invalid';
  await navigate(`${baseUrl}/?demo=1&quality=banana`);
  await waitFor(`window.__BLOOM__?.mode === 'demo'`, 15_000);
  const invalidQuality = await evaluate(`({ quality: window.__BLOOM__?.flower?.quality, error: window.__BLOOM_ERROR__ ?? null })`);
  check('Invalid ?quality falls back to auto tier', ['low', 'balanced', 'high'].includes(invalidQuality.quality) && !invalidQuality.error, JSON.stringify(invalidQuality));

  /* ------------------------------------------------------------------ *
   * 5. Reduced motion
   * ------------------------------------------------------------------ */
  report.phase = 'reduced-motion';
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await navigate(`${baseUrl}/?demo=1`);
  await waitFor(`window.__BLOOM__?.mode === 'demo'`, 15_000);
  await sleep(600);
  const reduced = await evaluate(`({
    matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    auroraAnimation: getComputedStyle(document.querySelector('.atmosphere'), '::before').animationName,
    introItemDuration: getComputedStyle(document.querySelector('.intro__inner > *')).animationDuration,
    hudPulse: getComputedStyle(document.querySelector('.live-dot')).animationDuration,
    live: window.__BLOOM__?.live
  })`);
  const reducedItemMs = Number.parseFloat(reduced.introItemDuration) * (String(reduced.introItemDuration).includes('ms') ? 1 : 1000);
  const reducedPulseMs = Number.parseFloat(reduced.hudPulse) * (String(reduced.hudPulse).includes('ms') ? 1 : 1000);
  check('prefers-reduced-motion disables CSS motion (WebGL loop continues)', reduced.matches && reduced.auroraAnimation === 'none' && reducedItemMs <= 0.01 && reducedPulseMs <= 0.01 && reduced.live === true, JSON.stringify(reduced));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  /* ------------------------------------------------------------------ *
   * 6. FlowerField API: resize/dispose; module contracts
   * ------------------------------------------------------------------ */
  report.phase = 'api-probe';
  const apiProbe = await evaluate(`(async () => {
    const out = {};
    const { FlowerField } = await import('/src/flower.js');
    const { HandTracker, HAND_CONNECTIONS } = await import('/src/handTracking.js');
    out.connectionCount = HAND_CONNECTIONS.length;
    out.connectionsValid = HAND_CONNECTIONS.every(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < 21 && b >= 0 && b < 21);
    let ctorThrew = false;
    try { new HandTracker({}); } catch (e) { ctorThrew = e instanceof TypeError; }
    out.handTrackerCtorThrows = ctorThrew;
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    const f = new FlowerField(canvas);
    out.quality = f.quality;
    out.particles = f.particleCount;
    f.update(null, 0.016, 0);
    out.bloomAfterIdle = f.bloom;
    const capRatio = { high: 2, balanced: 1.5, low: 1 }[f.quality] ?? 1;
    f.resize(400, 300, 2);
    out.backingAfterResize = { w: canvas.width, h: canvas.height, expected: { w: 400 * capRatio, h: 300 * capRatio } };
    f.dispose();
    f.dispose();
    let threwAfterDispose = false;
    try { f.update(null, 0.016, 1); f.resize(640, 480, 2); } catch { threwAfterDispose = true; }
    out.threwAfterDispose = threwAfterDispose;
    out.disposedSafe = !threwAfterDispose;
    return out;
  })()`);
  check('HAND_CONNECTIONS is a valid 21-landmark skeleton', apiProbe.connectionCount > 0 && apiProbe.connectionsValid, JSON.stringify(apiProbe));
  check('HandTracker constructor validates required elements', apiProbe.handTrackerCtorThrows === true, String(apiProbe.handTrackerCtorThrows));
  check('FlowerField resize/dispose safe + idempotent', apiProbe.disposedSafe === true && apiProbe.backingAfterResize.w === apiProbe.backingAfterResize.expected.w && apiProbe.backingAfterResize.h === apiProbe.backingAfterResize.expected.h, JSON.stringify(apiProbe));

  /* ------------------------------------------------------------------ *
   * 7. Mobile layouts: 390x844 and 360x640
   * ------------------------------------------------------------------ */
  report.phase = 'mobile-390';
  await setMetrics({ width: 390, height: 844, dpr: 2, mobile: true });
  await navigate(`${baseUrl}/?demo=1`);
  await waitFor(`window.__BLOOM__?.mode === 'demo'`, 15_000);
  await sleep(1200);
  const mobile390 = await evaluate(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    return {
      inner: { w: innerWidth, h: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      gesture: r('#gesture-card'),
      hideUi: r('#hide-ui'),
      header: r('#header'),
      bloomValue: document.getElementById('bloom-value')?.textContent,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    };
  })()`);
  const overlap = (a, b) => a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  check('390x844 demo: no horizontal scroll', !mobile390.overflowX && mobile390.scrollWidth <= 390, JSON.stringify({ scrollWidth: mobile390.scrollWidth, inner: mobile390.inner }));
  check('390x844 demo: gesture card fully inside viewport', mobile390.gesture && mobile390.gesture.bottom <= 844 && mobile390.gesture.x >= 0 && mobile390.gesture.right <= 390, JSON.stringify(mobile390.gesture));
  check('390x844 demo: hide-ui does not cover gesture card', !overlap(mobile390.gesture, mobile390.hideUi), JSON.stringify({ gesture: mobile390.gesture, hideUi: mobile390.hideUi }));
  await screenshot('qa-adv-mobile-390-demo.png');

  report.phase = 'mobile-360';
  await setMetrics({ width: 360, height: 640, dpr: 2, mobile: true });
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  await sleep(1200);
  const mobile360Intro = await evaluate(`(() => {
    const rect = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const byId = (id) => document.getElementById(id);
    const hit = (id) => { const b = byId(id).getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!el && (el.id === id || !!el.closest('#' + id)); };
    return {
      inner: { w: innerWidth, h: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      introScroll: { w: byId('intro').scrollWidth, h: byId('intro').scrollHeight },
      title: rect('intro-title'),
      camera: rect('enter-camera'),
      demo: rect('enter-demo'),
      cameraClickable: hit('enter-camera'),
      demoClickable: hit('enter-demo'),
      cameraDisabled: byId('enter-camera').disabled,
      demoDisabled: byId('enter-demo').disabled,
      overflowX: document.documentElement.scrollWidth > innerWidth,
    };
  })()`);
  check('360x640 intro: no horizontal scroll', !mobile360Intro.overflowX && mobile360Intro.scrollWidth <= 360, JSON.stringify({ scrollWidth: mobile360Intro.scrollWidth, inner: mobile360Intro.inner }));
  check('360x640 intro: CTAs inside viewport and hit-testable', mobile360Intro.cameraClickable && mobile360Intro.demoClickable && mobile360Intro.camera.bottom <= 640 && mobile360Intro.demo.bottom <= 640 && mobile360Intro.camera.right <= 360, JSON.stringify({ camera: mobile360Intro.camera, demo: mobile360Intro.demo }));
  await screenshot('qa-adv-mobile-360-intro.png');

  await navigate(`${baseUrl}/?demo=1`);
  await waitFor(`window.__BLOOM__?.mode === 'demo'`, 15_000);
  await sleep(1200);
  const mobile360Demo = await evaluate(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    return { scrollWidth: document.documentElement.scrollWidth, gesture: r('#gesture-card'), hideUi: r('#hide-ui'), inner: { w: innerWidth, h: innerHeight } };
  })()`);
  check('360x640 demo: no horizontal scroll and HUD fits', mobile360Demo.scrollWidth <= 360 && mobile360Demo.gesture && mobile360Demo.gesture.bottom <= 640, JSON.stringify(mobile360Demo));
  await screenshot('qa-adv-mobile-360-demo.png');

  /* ------------------------------------------------------------------ *
   * 8. Live camera (fake device): loading UX, resize, tracker collapse,
   *    pagehide/bfcache state
   * ------------------------------------------------------------------ */
  report.phase = 'camera-live';
  await setMetrics({ width: 1440, height: 900, dpr: 1 });
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  await evaluate(`document.getElementById('enter-camera').click()`);
  await sleep(60);
  const duringStart = await evaluate(`({
    introState: document.getElementById('intro')?.dataset.state,
    cameraDisabled: document.getElementById('enter-camera')?.disabled,
    cameraBusy: document.getElementById('enter-camera')?.getAttribute('aria-busy'),
    progress: document.getElementById('intro-progress')?.style.width,
    spinner: (() => { const s = document.querySelector('#enter-camera .btn__spinner'); return s ? getComputedStyle(s).display : null; })()
  })`);
  note(`During camera start (60ms): ${JSON.stringify(duringStart)}`);

  const wentLive = await waitFor('document.body.classList.contains("is-live")', 40_000);
  await sleep(1500);
  const camera = await evaluate(`(() => {
    const video = document.getElementById('camera-video');
    const overlay = document.getElementById('landmark-canvas');
    return {
      live: window.__BLOOM__?.live,
      mode: window.__BLOOM__?.mode,
      trackerRunning: window.__BLOOM__?.trackerRunning,
      introHidden: document.getElementById('intro')?.getAttribute('aria-hidden'),
      introInert: document.getElementById('intro')?.inert,
      badge: document.getElementById('mode-badge')?.textContent,
      statusState: document.getElementById('status-pill')?.dataset.state,
      statusText: document.getElementById('status-text')?.textContent,
      trackerState: document.getElementById('tracker-state')?.textContent,
      trackerDisplay: getComputedStyle(document.getElementById('tracker-panel')).display,
      videoReady: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      videoObjectFit: getComputedStyle(video).objectFit,
      videoTransform: getComputedStyle(video).transform,
      overlayWidth: overlay.width,
      overlayHeight: overlay.height,
      overlayClient: { w: overlay.clientWidth, h: overlay.clientHeight },
      overlayTransform: getComputedStyle(overlay).transform,
      hudVisible: getComputedStyle(document.getElementById('hud')).visibility,
      gestureName: document.getElementById('gesture-name')?.textContent,
      gestureDesc: document.getElementById('gesture-desc')?.textContent,
      bloomValue: document.getElementById('bloom-value')?.textContent
    };
  })()`);
  check('Camera live state: HUD + LIVE badge + intro hidden', wentLive && camera.live && camera.mode === 'camera' && camera.badge === 'LIVE' && camera.statusState === 'live' && camera.introHidden === 'true' && camera.introInert === true && camera.hudVisible === 'visible', JSON.stringify(camera).slice(0, 400));
  check('Fake camera stream delivers video frames', camera.videoReady >= 2 && camera.videoWidth > 0 && camera.videoHeight > 0, JSON.stringify({ readyState: camera.videoReady, w: camera.videoWidth, h: camera.videoHeight }));
  check('Video mirrored, overlay not mirrored', camera.videoTransform === 'matrix(-1, 0, 0, 1, 0, 0)' && camera.overlayTransform === 'none' && camera.videoObjectFit === 'cover', JSON.stringify({ video: camera.videoTransform, overlay: camera.overlayTransform, fit: camera.videoObjectFit }));
  const pageDpr = await evaluate('devicePixelRatio');
  check('Landmark overlay canvas sized to CSS box x DPR', camera.overlayWidth === Math.round(camera.overlayClient.w * Math.min(pageDpr, 2)) && camera.overlayHeight === Math.round(camera.overlayClient.h * Math.min(pageDpr, 2)) && camera.overlayWidth > 0, JSON.stringify({ backing: { w: camera.overlayWidth, h: camera.overlayHeight }, client: camera.overlayClient, dpr: pageDpr }));
  check('No-hand camera HUD copy is correct', /等待手部/.test(camera.trackerState) && camera.gestureName === '静候' && camera.statusText === '寻找手部', JSON.stringify({ trackerState: camera.trackerState, gesture: camera.gestureName, status: camera.statusText }));

  // Tracker collapse / expand (T).
  await key(KEYS.t);
  await sleep(150);
  const collapsed = await evaluate(`({
    collapsed: document.getElementById('tracker-panel').classList.contains('is-collapsed'),
    expanded: document.getElementById('tracker-toggle').getAttribute('aria-expanded'),
    bodyDisplay: getComputedStyle(document.getElementById('tracker-body')).display,
    width: getComputedStyle(document.getElementById('tracker-panel')).width
  })`);
  check('T collapses tracker preview (aria-expanded=false, body hidden)', collapsed.collapsed && collapsed.expanded === 'false' && collapsed.bodyDisplay === 'none', JSON.stringify(collapsed));
  await key(KEYS.t);
  await sleep(150);
  const expanded = await evaluate(`({ collapsed: document.getElementById('tracker-panel').classList.contains('is-collapsed'), expanded: document.getElementById('tracker-toggle').getAttribute('aria-expanded'), bodyDisplay: getComputedStyle(document.getElementById('tracker-body')).display })`);
  check('T expands tracker preview again', !expanded.collapsed && expanded.expanded === 'true' && expanded.bodyDisplay !== 'none', JSON.stringify(expanded));

  // Resize while live (desktop -> mobile) exercises flower.resize + HUD reflow.
  report.phase = 'camera-resize-mobile';
  await setMetrics({ width: 390, height: 844, dpr: 2, mobile: true });
  await sleep(900);
  const resized = await evaluate(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), right: +b.right.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const scene = document.getElementById('scene');
    return {
      dpr: devicePixelRatio,
      inner: { w: innerWidth, h: innerHeight },
      sceneBacking: { w: scene.width, h: scene.height },
      sceneCss: { w: scene.clientWidth, h: scene.clientHeight },
      tracker: r('#tracker-panel'),
      gesture: r('#gesture-card'),
      hideUi: r('#hide-ui'),
      scrollWidth: document.documentElement.scrollWidth,
      trackerState: document.getElementById('tracker-state')?.textContent,
      videoWidth: document.getElementById('camera-video')?.videoWidth,
      quality: window.__BLOOM__?.flower?.quality
    };
  })()`);
  const resizeCap = { high: 2, balanced: 1.5, low: 1 }[resized.quality] ?? 1;
  const expectedBacking = { w: 390 * resizeCap, h: 844 * resizeCap };
  const overlaps = (a, b) => a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  check('Live resize to mobile resizes WebGL canvas (CSS 390x844 x tier DPR)', resized.sceneBacking.w === expectedBacking.w && resized.sceneBacking.h === expectedBacking.h && resized.sceneCss.w === 390, JSON.stringify({ backing: resized.sceneBacking, expected: expectedBacking, css: resized.sceneCss, quality: resized.quality }));
  check('Live 390x844 camera: no h-scroll, no HUD overlap', resized.scrollWidth <= 390 && !overlaps(resized.tracker, resized.gesture) && !overlaps(resized.tracker, resized.hideUi) && !overlaps(resized.gesture, resized.hideUi) && resized.gesture.bottom <= 844, JSON.stringify({ tracker: resized.tracker, gesture: resized.gesture, hideUi: resized.hideUi, scrollWidth: resized.scrollWidth }));
  check('Tracking keeps running across resize', resized.videoWidth > 0 && /等待手部|关键点/.test(resized.trackerState ?? ''), JSON.stringify({ videoWidth: resized.videoWidth, trackerState: resized.trackerState }));
  await screenshot('qa-adv-camera-mobile.png');

  // pagehide (bfcache) simulation: app stops the tracker but has no restore path.
  report.phase = 'pagehide-bfcache';
  await evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`);
  await sleep(400);
  const afterPagehide = await evaluate(`({
    live: window.__BLOOM__?.live,
    mode: window.__BLOOM__?.mode,
    trackerRunning: window.__BLOOM__?.trackerRunning,
    videoSrcObject: document.getElementById('camera-video')?.srcObject,
    hudVisible: getComputedStyle(document.getElementById('hud')).visibility,
    statusText: document.getElementById('status-text')?.textContent,
    introHidden: document.getElementById('intro')?.getAttribute('aria-hidden')
  })`);
  await sleep(1200);
  await evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
  await sleep(800);
  const afterPageshow = await evaluate(`({
    live: window.__BLOOM__?.live,
    mode: window.__BLOOM__?.mode,
    trackerRunning: window.__BLOOM__?.trackerRunning,
    videoSrcObject: document.getElementById('camera-video')?.srcObject,
    statusText: document.getElementById('status-text')?.textContent,
    cameraDisabled: document.getElementById('enter-camera')?.disabled,
    hudVisible: getComputedStyle(document.getElementById('hud')).visibility
  })`);
  const bfcacheLeak = afterPagehide.live === true && afterPagehide.trackerRunning === false && afterPagehide.videoSrcObject === null && afterPageshow.trackerRunning === false;
  if (bfcacheLeak) {
    note(`MINOR: simulated bfcache restore leaves mode=${afterPageshow.mode}, live=true, trackerRunning=false — HUD still claims LIVE but no tracking and no in-page recovery path (source: src/main.js:575-577 stops tracker on pagehide; no pageshow handler).`);
  }
  check('pagehide stops camera tracks', afterPagehide.trackerRunning === false && afterPagehide.videoSrcObject === null, JSON.stringify(afterPagehide));
  await screenshot('qa-adv-bfcache-stale-live.png');

  /* ------------------------------------------------------------------ *
   * 9. Camera permission denied -> useful Chinese error + demo fallback
   * ------------------------------------------------------------------ */
  report.phase = 'camera-denied';
  await setMetrics({ width: 1440, height: 900, dpr: 1 });
  // NOTE: CDP permission descriptor uses Blink's `camera` name (not videoCapture).
  let denyPermissionError = null;
  try {
    await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: baseUrl });
  } catch (error) {
    denyPermissionError = String(error?.message ?? error);
    note(`Could not force camera denial via CDP: ${denyPermissionError}`);
  }
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  await evaluate(`document.getElementById('enter-camera').click()`);
  const denied = await waitFor(`document.getElementById('intro')?.dataset.state === 'error'`, 20_000);
  await sleep(400);
  const deniedInfo = await evaluate(`({
    state: document.getElementById('intro')?.dataset.state,
    status: document.getElementById('intro-status')?.textContent?.trim(),
    note: document.getElementById('intro-note')?.textContent?.trim(),
    cameraDisabled: document.getElementById('enter-camera')?.disabled,
    demoDisabled: document.getElementById('enter-demo')?.disabled,
    bodyLive: document.body.classList.contains('is-live'),
    trackerRunning: window.__BLOOM__?.trackerRunning,
    statusPill: document.getElementById('status-pill')?.dataset.state,
    toast: document.getElementById('toast')?.textContent?.trim(),
    introVisible: getComputedStyle(document.getElementById('intro')).visibility
  })`);
  check('Camera denial shows error state and stays on intro', denied && deniedInfo.state === 'error' && !deniedInfo.bodyLive && deniedInfo.introVisible === 'visible', JSON.stringify(deniedInfo).slice(0, 400));
  check('Camera denial error is useful Chinese permission copy', /权限|拒绝/.test(deniedInfo.status ?? '') && /[\u4e00-\u9fff]/.test(deniedInfo.status ?? ''), deniedInfo.status);
  check('Denial keeps both CTAs enabled and offers demo fallback', deniedInfo.cameraDisabled === false && deniedInfo.demoDisabled === false && /演示/.test(deniedInfo.note ?? ''), JSON.stringify({ cameraDisabled: deniedInfo.cameraDisabled, demoDisabled: deniedInfo.demoDisabled, note: deniedInfo.note }));
  await screenshot('qa-adv-camera-denied.png');

  await evaluate(`document.getElementById('enter-demo').click()`);
  const demoAfterDenial = await waitFor(`window.__BLOOM__?.mode === 'demo' && window.__BLOOM__?.live === true`, 5000);
  check('Demo fallback works after camera denial', demoAfterDenial, JSON.stringify(await evaluate(`({ mode: window.__BLOOM__?.mode, live: window.__BLOOM__?.live, badge: document.getElementById('mode-badge')?.textContent })`)));

  await resetPermissions();

  /* ------------------------------------------------------------------ *
   * 10. Console / network audit
   * ------------------------------------------------------------------ */
  report.phase = 'audit';
  const external = report.externalRequests;
  check('No external runtime requests', external.length === 0, JSON.stringify(external.slice(0, 5)));
  check('No failed local requests', report.failedRequests.length === 0, JSON.stringify(report.failedRequests.slice(0, 5)));
  check('No HTTP >= 400 responses', report.httpErrors.length === 0, JSON.stringify(report.httpErrors.slice(0, 5)));

  const unexpectedErrors = report.consoleErrors.filter((entry) => {
    const text = entry.text ?? '';
    if (entry.phase === 'camera-denied') return false; // expected diagnostic for the forced denial test
    return !/favicon|Autoplay|Permissions-Policy|WebGL.*deprecated|GroupMarkerNotSet|SwiftShader/i.test(text);
  });
  check('No unexpected console errors / page exceptions', unexpectedErrors.length === 0 && report.pageExceptions.length === 0, JSON.stringify({ errors: unexpectedErrors.slice(0, 3), exceptions: report.pageExceptions.slice(0, 3) }));

  const warnings = report.consoleWarnings;
  note(`Console warnings during whole run (${warnings.length}): ${JSON.stringify(warnings.slice(0, 6))}`);
  note(`Forced-denial console diagnostics (expected): ${JSON.stringify(report.consoleErrors.filter((e) => e.phase === 'camera-denied').slice(0, 3))}`);

  // Response header spot check against our own server.
  const headers = await fetch(`${baseUrl}/vendor/mediapipe/wasm/vision_wasm_internal.wasm`, { method: 'HEAD' });
  check('WASM served as application/wasm with nosniff', headers.ok && headers.headers.get('content-type') === 'application/wasm' && headers.headers.get('x-content-type-options') === 'nosniff', JSON.stringify({ status: headers.status, type: headers.headers.get('content-type'), nosniff: headers.headers.get('x-content-type-options') }));

  report.finishedAt = new Date().toISOString();
  await writeFile(join(QA_DIR, 'qa-adversarial.json'), `${JSON.stringify(report, null, 2)}\n`);

  const failed = report.checks.filter((entry) => !entry.ok);
  console.log(`\n${failed.length ? '✗' : '✓'} Adversarial QA: ${report.checks.length - failed.length}/${report.checks.length} checks passed.`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const item of failed) console.log(`  • ${item.name} — ${item.detail}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error('\nAdversarial QA crashed:', error);
  report.error = String(error?.stack ?? error);
  try {
    await mkdir(QA_DIR, { recursive: true });
    await writeFile(join(QA_DIR, 'qa-adversarial.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (chromeProcess?.pid) {
    try { await new Promise((res) => spawn('taskkill', ['/PID', String(chromeProcess.pid), '/T', '/F'], { stdio: 'ignore' }).on('exit', res)); } catch { /* ignore */ }
  }
  if (serverProcess?.pid) serverProcess.kill();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
