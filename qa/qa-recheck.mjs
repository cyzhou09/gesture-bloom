/**
 * Targeted re-checks requested by Lead:
 *   A. deterministic camera-denial path via monkey-patched getUserMedia
 *   B. help backdrop close after the 450ms+ visibility transition
 *   C. focus-after-open (expected minor bug), focus trap probe
 *   D. #mode-badge data-mode staleness after entering LIVE
 *   E. WebGL-unavailable graceful error path
 *   F. demo fallback after camera denial
 *
 * Outputs qa/qa-recheck.json + qa-adv-camera-denied.png / qa-adv-webgl-unavailable.png
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

const report = { startedAt: new Date().toISOString(), checks: [], warnings: [], notes: [], screenshots: [] };
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function note(text) { report.notes.push(String(text)); console.log(`  · ${text}`); }

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function fetchOk(url, timeout = 2000) {
  try { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout); const r = await fetch(url, { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; }
}

class CDP {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
    this.socket.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.message} (${m.error.code})`)) : p.res(m.result);
        return;
      }
      for (const l of this.listeners.get(m.method) ?? []) l(m.params);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    const p = new Promise((res, rej) => this.pending.set(id, { res, rej }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return p;
  }
  on(method, l) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(l); }
  once(method, timeout = 15_000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeout);
      const l = (p) => { clearTimeout(t); const a = this.listeners.get(method) ?? []; const i = a.indexOf(l); if (i >= 0) a.splice(i, 1); res(p); };
      this.on(method, l);
    });
  }
}

async function main() {
  await mkdir(QA_DIR, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--port', String(port)], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) { if (await fetchOk(baseUrl)) break; await sleep(150); }
  console.log(`Server: ${baseUrl}`);

  const chromePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
  ].filter(Boolean).find((c) => existsSync(c));
  const dbg = await freePort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'bloom-recheck-'));
  const chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
    '--window-size=1440,900', '--force-device-scale-factor=1',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp = null;
  for (let i = 0; i < 100 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) { cdp = new CDP(page.webSocketDebuggerUrl); await cdp.open(); }
    } catch { /* wait */ }
    if (!cdp) await sleep(150);
  }
  if (!cdp) throw new Error('chrome not ready');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'warning' && type !== 'error') return;
    report.warnings.push({ type, text: (args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ') });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry?.level === 'warning' || entry?.level === 'error') report.warnings.push({ type: entry.level, text: entry.text ?? '' });
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval');
    return r.result?.value;
  };
  const waitFor = async (expression, timeout = 20_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await evaluate(expression)) return true; } catch { /* retry */ } await sleep(150); }
    return false;
  };
  const navigate = async (url) => {
    const loaded = cdp.once('Page.loadEventFired', 25_000).catch(() => null);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await waitFor('document.readyState === "complete"', 15_000);
  };
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(join(QA_DIR, name), Buffer.from(data, 'base64'));
    report.screenshots.push(join(QA_DIR, name));
  };
  const mouseClick = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const key = async (keyName, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };

  /* A. Deterministic camera-denial via monkey-patched getUserMedia. */
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  const patched = await evaluate(`(() => {
    const md = navigator.mediaDevices;
    md.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied by QA patch'), { name: 'NotAllowedError' }));
    return { patched: true, has: typeof md.getUserMedia === 'function' };
  })()`);
  await evaluate(`document.getElementById('enter-camera').click()`);
  const denied = await waitFor(`document.querySelector('#intro')?.dataset.state === 'error'`, 15_000);
  await sleep(500);
  const deniedInfo = await evaluate(`({
    state: document.getElementById('intro')?.dataset.state,
    introStatus: document.getElementById('intro-status')?.textContent?.trim(),
    introNote: document.getElementById('intro-note')?.textContent?.trim(),
    cameraDisabled: document.getElementById('enter-camera')?.disabled,
    demoDisabled: document.getElementById('enter-demo')?.disabled,
    bodyLive: document.body.classList.contains('is-live'),
    trackerRunning: window.__BLOOM__?.trackerRunning,
    trackerPanelDisplay: getComputedStyle(document.getElementById('tracker-panel')).display,
    statusPill: document.getElementById('status-pill')?.dataset.state,
    statusText: document.getElementById('status-text')?.textContent,
    toast: document.getElementById('toast')?.textContent?.trim(),
    introVisibility: getComputedStyle(document.getElementById('intro')).visibility
  })`);
  check('Patched getUserMedia denial: intro reaches error state', denied && deniedInfo.state === 'error', JSON.stringify(deniedInfo).slice(0, 300));
  check('Denial copy is useful Chinese permission guidance', /权限|拒绝/.test(deniedInfo.introStatus ?? '') && /[\u4e00-\u9fff]/.test(deniedInfo.introStatus ?? ''), deniedInfo.introStatus);
  check('Denial points user to demo fallback', /演示/.test(deniedInfo.introNote ?? ''), deniedInfo.introNote);
  check('Denial leaves both CTAs enabled, no camera stream, intro visible', deniedInfo.cameraDisabled === false && deniedInfo.demoDisabled === false && deniedInfo.bodyLive === false && deniedInfo.trackerRunning === false && deniedInfo.introVisibility === 'visible' && deniedInfo.statusPill === 'error', JSON.stringify({ cameraDisabled: deniedInfo.cameraDisabled, demoDisabled: deniedInfo.demoDisabled, bodyLive: deniedInfo.bodyLive, trackerRunning: deniedInfo.trackerRunning, statusPill: deniedInfo.statusPill }));
  await shot('qa-adv-camera-denied.png');

  // F. Demo fallback from the denial state.
  await evaluate(`document.getElementById('enter-demo').click()`);
  const demoAfterDenial = await waitFor(`window.__BLOOM__?.mode === 'demo' && window.__BLOOM__?.live === true`, 5000);
  check('Demo fallback works from camera-denial error state', demoAfterDenial, JSON.stringify(await evaluate(`({ mode: window.__BLOOM__?.mode, live: window.__BLOOM__?.live, badge: document.getElementById('mode-badge')?.textContent })`)));

  /* B/C. Help backdrop after transition, focus-after-open, focus trap. */
  await navigate(baseUrl);
  await waitFor('window.__BLOOM_READY__ === true', 15_000);
  await sleep(1200);
  const helpBtn = await evaluate(`(() => { const r = document.getElementById('help-button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouseClick(helpBtn.x, helpBtn.y);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(700); // B: > 450ms after open, per Lead instruction
  const opened = await evaluate(`({
    open: document.getElementById('help-panel').classList.contains('is-open'),
    visibility: getComputedStyle(document.getElementById('help-panel')).visibility,
    opacity: getComputedStyle(document.getElementById('help-panel')).opacity,
    active: document.activeElement?.id || document.activeElement?.tagName,
    activeInDialog: !!document.activeElement?.closest?.('.help__dialog'),
    backdropTarget: (() => { const e = document.elementFromPoint(40, 450); return e ? e.tagName + '.' + (e.className || '') : null; })()
  })`);
  check('Help opens fully visible after transition', opened.open && opened.visibility === 'visible' && Number(opened.opacity) > 0.99, JSON.stringify({ visibility: opened.visibility, opacity: opened.opacity }));
  check('Backdrop is hit-testable after transition', /help__backdrop/.test(opened.backdropTarget ?? ''), opened.backdropTarget);
  await mouseClick(40, 450);
  const backdropClosed = await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  check('Backdrop click closes help after transition', backdropClosed);

  // Re-open and inspect focus + trap behavior (known minor bug expected).
  await mouseClick(helpBtn.x, helpBtn.y);
  await waitFor(`document.getElementById('help-panel').classList.contains('is-open')`, 4000);
  await sleep(700);
  const focusState = await evaluate(`({
    active: document.activeElement?.id || document.activeElement?.tagName,
    activeInDialog: !!document.activeElement?.closest?.('.help__dialog'),
    helpExpanded: document.getElementById('help-button')?.getAttribute('aria-expanded')
  })`);
  if (focusState.active === 'help-close' && focusState.activeInDialog) {
    check('Focus moves into help dialog on open', true, JSON.stringify(focusState));
  } else {
    note(`MINOR (confirmed): focus does NOT move into the help dialog on open — activeElement=${focusState.active}; src/main.js:360 calls els.helpClose.focus() while #help-panel is still visibility:hidden at transition t=0, so focus() is ignored.`);
    check('Focus moves into help dialog on open', false, JSON.stringify(focusState));
  }
  await evaluate(`document.getElementById('help-close').focus()`);
  await key('Tab', 'Tab', 9);
  await sleep(150);
  const tabbed = await evaluate(`({ active: document.activeElement?.id || document.activeElement?.tagName, inDialog: !!document.activeElement?.closest?.('.help__dialog') })`);
  if (!tabbed.inDialog) note(`MINOR (confirmed): no focus trap — Tab from #help-close moves focus to ${tabbed.active} outside the aria-modal dialog.`);
  check('Tab stays inside modal dialog (focus trap)', tabbed.inDialog, JSON.stringify(tabbed));
  await key('Escape', 'Escape', 27);
  await waitFor(`!document.getElementById('help-panel').classList.contains('is-open')`, 4000);

  /* D. Mode badge data-mode after entering LIVE. */
  await sleep(400);
  await evaluate(`document.getElementById('enter-camera').click()`);
  const live = await waitFor('document.body.classList.contains("is-live")', 40_000);
  await sleep(1200);
  const badge = await evaluate(`(() => {
    const el = document.getElementById('mode-badge');
    const cs = getComputedStyle(el);
    return {
      text: el?.textContent,
      dataMode: el?.getAttribute('data-mode'),
      bodyMode: document.body.dataset.mode,
      color: cs.color,
      borderColor: cs.borderColor,
      live: window.__BLOOM__?.live,
      trackerRunning: window.__BLOOM__?.trackerRunning
    };
  })()`);
  const mintExpected = 'rgb(143, 217, 196)';
  const liveBadgeStyled = badge.dataMode === 'live' && badge.color === mintExpected;
  if (!liveBadgeStyled) {
    note(`MINOR (confirmed): #mode-badge text = ${badge.text} but data-mode = ${badge.dataMode} after entering LIVE (main.js only calls setText, never sets data-mode; index.html ships data-mode="demo"). Computed color ${badge.color} = DEMO gold instead of LIVE mint ${mintExpected}.`);
  }
  check('LIVE mode badge applies LIVE styling', liveBadgeStyled, JSON.stringify(badge));

  /* E. WebGL-unavailable graceful error path. */
  const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (String(type).startsWith('webgl')) return null;
        return original.call(this, type, ...rest);
      };
    })();`,
  });
  await navigate(baseUrl);
  const webglError = await waitFor(`window.__BLOOM_ERROR__ !== undefined`, 10_000);
  await sleep(600);
  const webglInfo = await evaluate(`({
    error: window.__BLOOM_ERROR__,
    introState: document.getElementById('intro')?.dataset.state,
    introStatus: document.getElementById('intro-status')?.textContent?.trim(),
    statusPill: document.getElementById('status-pill')?.dataset.state,
    cameraDisabled: document.getElementById('enter-camera')?.disabled,
    demoDisabled: document.getElementById('enter-demo')?.disabled,
    bodyLive: document.body.classList.contains('is-live'),
    introVisibility: getComputedStyle(document.getElementById('intro')).visibility
  })`);
  check('WebGL-unavailable shows graceful Chinese error', webglError && webglInfo.introState === 'error' && /WebGL/.test(webglInfo.introStatus ?? ''), JSON.stringify(webglInfo).slice(0, 300));
  check('WebGL failure disables unusable actions and stays on intro', webglInfo.cameraDisabled === true && webglInfo.demoDisabled === true && webglInfo.statusPill === 'error' && webglInfo.introVisibility === 'visible', JSON.stringify(webglInfo).slice(0, 300));
  await shot('qa-adv-webgl-unavailable.png');

  // Console warnings of interest (aria-hidden/focus etc.).
  const ariaWarnings = report.warnings.filter((w) => /aria-hidden/i.test(w.text ?? ''));
  if (ariaWarnings.length) note(`MINOR (confirmed): Chrome logs "Blocked aria-hidden on an element because its descendant retained focus" — main.js:144-148 hides #intro via aria-hidden/inert while focus is still inside it (see src/main.js:147). Count=${ariaWarnings.length}.`);
  report.ariaHiddenWarnings = ariaWarnings;

  report.finishedAt = new Date().toISOString();
  await writeFile(join(QA_DIR, 'qa-recheck.json'), `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\nRecheck: ${report.checks.length - failed.length}/${report.checks.length} checks passed.`);
  if (failed.length) { console.log('Failed checks:'); for (const f of failed) console.log(`  • ${f.name} — ${f.detail}`); }

  cdp.socket?.close();
  chrome.kill();
  server.kill();
  await sleep(400);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (error) => {
  console.error('Recheck crashed:', error);
  report.error = String(error?.stack ?? error);
  try { await writeFile(join(QA_DIR, 'qa-recheck.json'), `${JSON.stringify(report, null, 2)}\n`); } catch { /* ignore */ }
  process.exitCode = 1;
});
