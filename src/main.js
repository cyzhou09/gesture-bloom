/**
 * 指尖花 · Bloom at Your Fingertips
 * App orchestration: intro → camera (MediaPipe) or demo → flower.
 *
 * The render loop lives here on purpose: the tracker and the flower are both
 * driven by one requestAnimationFrame clock, so hand state and visuals can never
 * drift apart.
 */
import { FlowerField } from './flower.js';
import { HandTracker } from './handTracking.js';

const $ = (id) => document.getElementById(id);

const els = {
  scene: $('scene'),
  intro: $('intro'),
  introStatus: $('intro-status'),
  introProgress: $('intro-progress'),
  introNote: $('intro-note'),
  enterCamera: $('enter-camera'),
  enterDemo: $('enter-demo'),
  hud: $('hud'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  modeBadge: $('mode-badge'),
  gestureCard: $('gesture-card'),
  gestureName: $('gesture-name'),
  gestureDesc: $('gesture-desc'),
  bloomFill: $('bloom-fill'),
  bloomValue: $('bloom-value'),
  trackerPanel: $('tracker-panel'),
  video: $('camera-video'),
  landmarkCanvas: $('landmark-canvas'),
  trackerState: $('tracker-state'),
  trackerToggle: $('tracker-toggle'),
  helpButton: $('help-button'),
  helpPanel: $('help-panel'),
  helpClose: $('help-close'),
  toast: $('toast'),
  hideUi: $('hide-ui'),
  showUi: $('show-ui'),
};

const params = new URLSearchParams(window.location.search);
const app = {
  ready: false,
  fatal: false,
  live: false,
  starting: false,
  mode: 'intro', // intro | camera | demo
  demoStart: 0,
  lastTime: performance.now(),
  lastHud: 0,
  lastHand: null,
  demoTipHistory: [],
  demoPrevPalm: null,
  trackingErrorShown: false,
};

let flower = null;
let tracker = null;
let toastTimer = 0;
let helpRestoreFocus = null;
let helpFocusTimer = 0;

/* --------------------------------------------------------------------------
   Small UI helpers
   -------------------------------------------------------------------------- */

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function setStatusPill(state, text) {
  if (els.statusPill) els.statusPill.dataset.state = state;
  setText(els.statusText, text);
}

function setIntroState(state, message, progress = 0) {
  if (!els.intro) return;
  els.intro.dataset.state = state;
  if (typeof message === 'string') setText(els.introStatus, message);
  if (els.introProgress) {
    const clamped = Math.max(0, Math.min(1, progress));
    els.introProgress.style.width = `${clamped * 100}%`;
  }
}

function setIntroBusy(busy) {
  app.starting = busy;
  for (const button of [els.enterCamera, els.enterDemo]) {
    if (!button) continue;
    button.disabled = busy || app.fatal;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

function toast(message, duration = 3000) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast?.classList.remove('is-visible'), duration);
}

function humanizeCameraError(error) {
  const name = error?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '摄像头权限被拒绝。请在地址栏的摄像头图标中允许访问后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到摄像头。请连接摄像头，或使用演示模式。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头正被其他应用占用，关闭会议软件后再试一次。';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return '摄像头不支持所需画质，请换一个浏览器或设备再试。';
  }
  if (name === 'SecurityError') {
    return '当前页面不是安全上下文。请通过 http://localhost 访问，而不是直接打开 html 文件。';
  }
  if (name === 'AbortError') {
    return '摄像头启动被中断，请重试。';
  }
  const message = String(error?.message ?? '');
  if (/wasm|model|fetch|import/i.test(message)) {
    return '手部模型加载失败。请确认 vendor/ 目录完整，并通过本地 HTTP 服务访问。';
  }
  return message || '摄像头启动失败，请检查设备与浏览器权限。';
}

/* --------------------------------------------------------------------------
   Enter camera / demo
   -------------------------------------------------------------------------- */

function enterLive(mode) {
  app.live = true;
  app.starting = false;
  app.mode = mode;
  setIntroBusy(false);
  document.body.classList.add('is-live');
  document.body.classList.toggle('is-demo', mode === 'demo');
  document.body.dataset.mode = mode;
  // Chrome warns if aria-hidden lands on an ancestor of the focused element.
  // Blur the intro CTA before hiding the intro from assistive technology.
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && els.intro?.contains(activeElement)) {
    activeElement.blur();
  }
  if (els.intro) {
    els.intro.dataset.state = 'ready';
    els.intro.classList.add('is-hidden');
    els.intro.setAttribute('aria-hidden', 'true');
    els.intro.inert = true;
  }
  if (els.hud) els.hud.setAttribute('aria-hidden', 'false');
  if (els.modeBadge) els.modeBadge.dataset.mode = mode === 'demo' ? 'demo' : 'live';
  if (mode === 'demo') {
    setStatusPill('demo', '自动演示');
    setText(els.modeBadge, 'DEMO');
  } else {
    setStatusPill('live', '寻找手部');
    setText(els.modeBadge, 'LIVE');
  }
}

/**
 * A browser back/forward cache restore (or a pagehide) leaves the camera stream
 * gone but the last UI state alive. Return to the intro with a clear recovery
 * action instead of showing a dead "LIVE" HUD.
 */
function resetCameraSession(message) {
  if (els.helpPanel?.classList.contains('is-open')) closeHelp();
  tracker?.stop?.();
  app.live = false;
  app.starting = false;
  app.mode = 'intro';
  app.lastHand = null;
  app.demoPrevPalm = null;
  app.demoTipHistory.length = 0;
  document.body.classList.remove('is-live', 'is-demo');
  document.body.dataset.mode = 'intro';
  if (els.intro) {
    els.intro.classList.remove('is-hidden');
    els.intro.inert = false;
    els.intro.removeAttribute('aria-hidden');
  }
  if (els.hud) els.hud.setAttribute('aria-hidden', 'true');
  if (els.modeBadge) {
    els.modeBadge.dataset.mode = 'demo';
    setText(els.modeBadge, 'DEMO');
  }
  setIntroBusy(false);
  setIntroState('error', message, 0);
  setStatusPill('error', '摄像头已暂停');
  setText(els.trackerState, '等待手部进入画面');
  setText(els.introNote, '摄像头在页面切换时被浏览器暂停。重新开启摄像头，或直接进入演示模式。');
  toast('摄像头已暂停，请重新开启', 4200);
}

async function startCamera() {
  if (app.starting || app.fatal || !tracker) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setIntroState('error', '当前浏览器不支持摄像头访问，请使用最新版 Chrome / Edge。', 0);
    setStatusPill('error', '需要 HTTPS 或 localhost');
    return;
  }

  setIntroBusy(true);
  setIntroState('loading', '正在请求摄像头权限…', 0.06);
  setStatusPill('loading', '正在连接');
  setText(els.introNote, '画面只在本机浏览器中处理，不会离开设备。');

  try {
    await tracker.start();
    app.starting = false;
    setIntroState('loading', '花已醒来，正在进入花园…', 1);
    setStatusPill('live', '寻找手部');
    window.setTimeout(() => {
      if (app.live) {
        tracker.stop?.();
        return;
      }
      enterLive('camera');
      toast('连接成功 · 握拳收拢花苞，张开手掌让它绽放', 4200);
    }, 260);
  } catch (error) {
    console.error('[bloom] camera start failed:', error);
    tracker.stop?.();
    setIntroBusy(false);
    setIntroState('error', humanizeCameraError(error), 0);
    setStatusPill('error', '连接失败');
    setText(els.introNote, '也可以直接进入演示模式，先看看花开的样子。');
    toast('摄像头未能启动，仍可使用演示模式');
  }
}

function startDemo({ silent = false } = {}) {
  if (app.fatal) return;
  if (app.starting && !app.live) return;

  if (tracker?.running) tracker.stop();
  app.starting = false;
  app.demoStart = performance.now();
  app.demoPrevPalm = null;
  app.demoTipHistory.length = 0;
  enterLive('demo');
  setIntroBusy(false);
  setStatusPill('demo', '自动演示');
  if (!silent) {
    toast('演示模式 · 无需摄像头，花会随程序节奏开合', 4200);
  }
}

/* --------------------------------------------------------------------------
   Demo gesture generator
   -------------------------------------------------------------------------- */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function demoOpenness(t) {
  // 12 second loop: closed hold → bloom → open hold → close → rest.
  const cycle = (t % 12) / 12;
  if (cycle < 0.16) return 0.05;
  if (cycle < 0.38) return easeInOut((cycle - 0.16) / 0.22);
  if (cycle < 0.54) return 1;
  if (cycle < 0.78) return 1 - easeInOut((cycle - 0.54) / 0.24);
  return 0.05;
}

function demoHand(now, dt) {
  const t = Math.max(0, (now - app.demoStart) / 1000);
  const openness = demoOpenness(t);
  const palm = {
    x: 0.5 + 0.185 * Math.sin(t * 0.46) + 0.028 * Math.sin(t * 1.13 + 0.7),
    y: 0.5 + 0.095 * Math.sin(t * 0.33 + 1.4) + 0.018 * Math.cos(t * 0.91),
    z: 0,
  };
  const previous = app.demoPrevPalm;
  const safeDt = Math.max(dt, 1 / 240);
  const velocity = previous
    ? {
        x: (palm.x - previous.x) / safeDt,
        y: (palm.y - previous.y) / safeDt,
      }
    : { x: 0, y: 0 };
  app.demoPrevPalm = palm;

  const spread = 0.038 + openness * 0.035;
  const wave = Math.sin(t * 1.7);
  const tips = [
    { x: palm.x - spread * 1.5, y: palm.y + spread * 0.1, z: 0 },
    { x: palm.x - spread * 0.62 + wave * 0.012, y: palm.y - spread * 1.7, z: 0 },
    { x: palm.x - spread * 0.1, y: palm.y - spread * 1.95, z: 0 },
    { x: palm.x + spread * 0.5, y: palm.y - spread * 1.7, z: 0 },
    { x: palm.x + spread * 1.12, y: palm.y - spread * 1.25, z: 0 },
  ];
  app.demoTipHistory.push({ x: tips[1].x, y: tips[1].y });
  if (app.demoTipHistory.length > 16) app.demoTipHistory.shift();

  const gesture = openness > 0.62 ? 'open' : openness < 0.24 ? 'fist' : 'half';
  return {
    present: true,
    gesture,
    openness,
    pinch: gesture === 'fist' ? 0.55 : 0.08,
    palm,
    indexTip: tips[1],
    tips,
    velocity,
    landmarks: null,
    handedness: 'Right',
    fps: 60,
  };
}

/* --------------------------------------------------------------------------
   HUD
   -------------------------------------------------------------------------- */

const GESTURE_COPY = {
  none: { name: '静候', desc: '把手掌伸进画面，花会听见你' },
  open: { name: '绽放', desc: '掌心舒展 · 粒子向光盛开' },
  fist: { name: '含苞', desc: '轻轻握拳 · 花收拢成一颗心跳' },
  pinch: { name: '牵引', desc: '指尖相触 · 光尘向花心聚拢' },
  half: { name: '呼吸', desc: '再张开一点 · 或者慢慢握紧' },
};

const hudCache = { name: '', desc: '', gesture: '', tracker: '', status: '', value: '', pill: '' };

function updateHud(now, hand) {
  if (!app.live || now - app.lastHud < 70) return;
  app.lastHud = now;

  const gesture = hand?.gesture ?? 'none';
  const copy = GESTURE_COPY[gesture] ?? GESTURE_COPY.none;
  if (copy.name !== hudCache.name) {
    setText(els.gestureName, copy.name);
    hudCache.name = copy.name;
  }
  if (copy.desc !== hudCache.desc) {
    setText(els.gestureDesc, copy.desc);
    hudCache.desc = copy.desc;
  }
  if (gesture !== hudCache.gesture) {
    if (els.gestureCard) els.gestureCard.dataset.gesture = gesture;
    hudCache.gesture = gesture;
  }

  const bloom = typeof flower?.bloom === 'number' ? flower.bloom : 0;
  const percentage = `${Math.round(clamp01(bloom) * 100)}%`;
  if (percentage !== hudCache.value) {
    setText(els.bloomValue, percentage);
    if (els.bloomFill) els.bloomFill.style.width = percentage;
    hudCache.value = percentage;
  }

  let trackerLabel;
  let statusLabel;
  let pillState;
  if (app.mode === 'demo') {
    trackerLabel = '程序轨迹 · 无摄像头';
    statusLabel = '自动演示';
    pillState = 'demo';
  } else if (hand) {
    const side = hand.handedness === 'Left' ? '左手' : hand.handedness === 'Right' ? '右手' : '手部';
    trackerLabel = `${side} · 21 个关键点`;
    statusLabel = '手部追踪';
    pillState = 'live';
  } else {
    trackerLabel = '等待手部进入画面';
    statusLabel = '寻找手部';
    pillState = 'live';
  }

  if (trackerLabel !== hudCache.tracker) {
    setText(els.trackerState, trackerLabel);
    hudCache.tracker = trackerLabel;
  }
  if (statusLabel !== hudCache.status) {
    setText(els.statusText, statusLabel);
    hudCache.status = statusLabel;
  }
  if (pillState !== hudCache.pill) {
    if (els.statusPill) els.statusPill.dataset.state = pillState;
    hudCache.pill = pillState;
  }
}

/* --------------------------------------------------------------------------
   Help / chrome controls
   -------------------------------------------------------------------------- */

function focusHelpControl(attempt = 0) {
  const panel = els.helpPanel;
  if (!panel?.classList.contains('is-open')) return;
  if (panel.contains(document.activeElement)) return;
  els.helpClose?.focus();
  // Some browsers keep the panel `visibility:hidden` for a few frames while
  // the opening transition runs; focus() is ignored until it is visible.
  // Retry briefly rather than relying on one arbitrary transition duration.
  if (!panel.contains(document.activeElement) && attempt < 24) {
    helpFocusTimer = window.setTimeout(() => focusHelpControl(attempt + 1), 60);
  }
}

function openHelp() {
  if (!els.helpPanel) return;
  const active = document.activeElement;
  helpRestoreFocus = active instanceof HTMLElement && active !== document.body ? active : els.helpButton;
  els.helpPanel.classList.add('is-open');
  els.helpPanel.setAttribute('aria-hidden', 'false');
  els.helpButton?.setAttribute('aria-expanded', 'true');
  // The panel opens with a short visibility transition; focusing immediately can
  // be ignored in that frame, so retry once the dialog is actually visible.
  els.helpClose?.focus();
  window.clearTimeout(helpFocusTimer);
  helpFocusTimer = window.setTimeout(() => focusHelpControl(0), 40);
}

function closeHelp() {
  if (!els.helpPanel?.classList.contains('is-open')) return;
  window.clearTimeout(helpFocusTimer);
  els.helpPanel.classList.remove('is-open');
  els.helpPanel.setAttribute('aria-hidden', 'true');
  els.helpButton?.setAttribute('aria-expanded', 'false');
  const restore = helpRestoreFocus instanceof HTMLElement ? helpRestoreFocus : els.helpButton;
  restore?.focus();
  helpRestoreFocus = null;
}

function trapHelpFocus(event) {
  const panel = els.helpPanel;
  if (!panel?.classList.contains('is-open')) return false;
  const focusable = [...panel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    return true;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !panel.contains(active)) {
    event.preventDefault();
    first.focus();
  }
  return true;
}

function toggleHelp() {
  if (els.helpPanel?.classList.contains('is-open')) closeHelp();
  else openHelp();
}

function hideChrome() {
  // Don't leave an invisible modal open underneath the hidden chrome.
  if (els.helpPanel?.classList.contains('is-open')) closeHelp();
  document.body.classList.add('ui-hidden');
  toast('按 U 或点击右下角眼睛恢复界面', 2400);
}

function showChrome() {
  document.body.classList.remove('ui-hidden');
}

function toggleTrackerPanel() {
  if (!els.trackerPanel) return;
  const collapsed = els.trackerPanel.classList.toggle('is-collapsed');
  els.trackerToggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  els.trackerToggle?.setAttribute('aria-label', collapsed ? '展开摄像头预览' : '收起摄像头预览');
}

/* --------------------------------------------------------------------------
   Animation loop
   -------------------------------------------------------------------------- */

function animate(now) {
  const dt = Math.min(Math.max((now - app.lastTime) / 1000, 0), 0.05);
  app.lastTime = now;

  let hand = null;
  if (app.live && app.mode === 'camera' && tracker?.running) {
    try {
      const state = tracker.update(now, dt);
      hand = state?.present ? state : null;
      app.lastHand = hand;
    } catch (error) {
      console.error('[bloom] tracker update failed:', error);
      if (!app.trackingErrorShown) {
        app.trackingErrorShown = true;
        toast('手部追踪出现异常，尝试刷新页面', 4200);
      }
      hand = null;
    }
  } else if (app.live && app.mode === 'demo') {
    hand = demoHand(now, dt);
    app.lastHand = hand;
  } else {
    app.lastHand = null;
  }

  if (flower) {
    try {
      flower.update(hand, dt, now / 1000);
    } catch (error) {
      console.error('[bloom] render failed:', error);
      app.fatal = true;
      toast('渲染出现异常，请刷新页面', 5000);
    }
  }

  updateHud(now, hand);
  requestAnimationFrame(animate);
}

function handleResize() {
  if (!flower) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  flower.resize(window.innerWidth, window.innerHeight, dpr);
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

function bindEvents() {
  els.enterCamera?.addEventListener('click', startCamera);
  els.enterDemo?.addEventListener('click', () => startDemo());
  els.helpButton?.addEventListener('click', toggleHelp);
  els.helpClose?.addEventListener('click', closeHelp);
  els.hideUi?.addEventListener('click', hideChrome);
  els.showUi?.addEventListener('click', showChrome);
  els.trackerToggle?.addEventListener('click', toggleTrackerPanel);

  els.helpPanel?.addEventListener('click', (event) => {
    if (event.target === els.helpPanel || event.target.closest?.('.help__backdrop')) closeHelp();
  });

  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('orientationchange', () => window.setTimeout(handleResize, 120), { passive: true });

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      if (els.helpPanel?.classList.contains('is-open')) closeHelp();
      else if (document.body.classList.contains('ui-hidden')) showChrome();
      return;
    }
    if (els.helpPanel?.classList.contains('is-open')) {
      if (key === 'tab') {
        trapHelpFocus(event);
        return;
      }
      if (key === 'h' || key === '?') {
        event.preventDefault();
        closeHelp();
      }
      // While the modal is open, don't let global shortcuts fire behind it.
      return;
    }
    if (key === 'h' || key === '?') {
      event.preventDefault();
      toggleHelp();
      return;
    }
    if (key === 'u') {
      event.preventDefault();
      if (document.body.classList.contains('ui-hidden')) showChrome();
      else hideChrome();
      return;
    }
    if (key === 'd') {
      event.preventDefault();
      if (app.mode === 'camera') {
        toast('正在使用摄像头；握拳或张开手掌就可以控制花朵');
      } else {
        startDemo();
      }
      return;
    }
    if (key === 't' && app.mode === 'camera') {
      event.preventDefault();
      toggleTrackerPanel();
    }
  });

  // A lost WebGL context is recoverable only by reloading; fail gracefully.
  els.scene?.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    app.fatal = true;
    toast('图形上下文丢失，请刷新页面', 6000);
  });
}

function boot() {
  bindEvents();
  els.helpPanel?.setAttribute('aria-hidden', 'true');
  setIntroBusy(false);
  setIntroState('idle', '让摄像头看见你的手，花就会醒来。', 0);
  setStatusPill('idle', '等待唤醒');

  try {
    const quality = params.get('quality');
    flower = new FlowerField(els.scene, {
      quality: quality === 'low' || quality === 'high' ? quality : undefined,
    });
    handleResize();
  } catch (error) {
    console.error('[bloom] WebGL init failed:', error);
    app.fatal = true;
    setIntroBusy(false);
    setIntroState('error', '当前浏览器无法创建 WebGL 场景。请开启硬件加速，或使用最新版 Chrome / Edge。', 0);
    setStatusPill('error', 'WebGL 不可用');
    if (els.introNote) {
      els.introNote.textContent = '摄像头需要 localhost 或 HTTPS；WebGL 需要开启硬件加速。';
    }
    window.__BLOOM_ERROR__ = String(error?.message ?? error);
    return;
  }

  tracker = new HandTracker({
    video: els.video,
    overlay: els.landmarkCanvas,
    onStatus: (status) => {
      if (!status || app.mode === 'camera') return;
      if (status.phase === 'camera' || status.phase === 'model') {
        setIntroState('loading', status.message || '正在加载手部追踪…', status.progress ?? 0.2);
      } else if (status.phase === 'ready') {
        setIntroState('loading', status.message || '手部追踪已就绪', 1);
      }
    },
  });

  app.ready = true;
  document.body.dataset.ready = 'true';
  window.__BLOOM_READY__ = true;

  // Expose a tiny read-only-ish debug surface for automated QA and curious users.
  window.__BLOOM__ = {
    get mode() { return app.mode; },
    get live() { return app.live; },
    get bloom() { return flower?.bloom ?? 0; },
    get hand() { return app.lastHand; },
    get trackerRunning() { return Boolean(tracker?.running); },
    flower,
    tracker,
    startDemo,
    startCamera,
    showChrome,
    hideChrome,
  };

  requestAnimationFrame(animate);

  // Demo can start from a query string (used by QA and for sharing a link).
  if (params.get('demo') === '1') {
    requestAnimationFrame(() => requestAnimationFrame(() => startDemo({ silent: true })));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

window.addEventListener('pagehide', () => {
  // Browsers freeze pages (bfcache) without warning; release the camera now.
  tracker?.stop?.();
});

window.addEventListener('pageshow', () => {
  if (!app.ready) return;
  // If the page came back from bfcache after pagehide stopped the tracker, the
  // old LIVE HUD would otherwise point at a dead camera. Ask the user to retry.
  if (app.mode === 'camera' && !tracker?.running) {
    resetCameraSession('摄像头在页面切换后已停止，请重新开启。');
  }
});
