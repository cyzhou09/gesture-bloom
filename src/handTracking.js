/**
 * 指尖花 · handTracking.js
 * ---------------------------------------------------------------------------
 * Webcam + MediaPipe Tasks Vision (Hand Landmarker) tracking for the
 * "指尖花 / Bloom at your fingertips" experience.
 *
 * Lives entirely inside this module:
 *   1. camera lifecycle (getUserMedia → <video> → play),
 *   2. local MediaPipe asset loading (bundle / WASM / .task) with a GPU→CPU
 *      delegate fallback,
 *   3. scale-normalised, temporally smoothed hand metrics (openness, pinch,
 *      gesture, palm / fingertip positions, velocity),
 *   4. a mirrored skeleton overlay that stays aligned with an
 *      `object-fit: cover` + `transform: scaleX(-1)` camera preview.
 *
 * The main loop owns requestAnimationFrame; this module never starts one.
 * All hand coordinates returned to the app are normalised 0..1 and already
 * mirrored for the selfie view (x = 0 is the viewer's left).
 *
 * Status callback shape (all optional fields included only when relevant):
 *   { phase: 'camera'|'model'|'ready'|'error', message: string,
 *     detail?: string, progress?: number }
 */

/* ========================================================================== *
 * Public constants
 * ========================================================================== */

/**
 * 21-point hand skeleton, MediaPipe landmark indices (wrist = 0).
 * Thumb 1–4, index 5–8, middle 9–12, ring 13–16, pinky 17–20.
 * @type {Array<[number, number]>}
 */
export const HAND_CONNECTIONS = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // middle
  [5, 9], [9, 10], [10, 11], [11, 12],
  // ring
  [9, 13], [13, 14], [14, 15], [15, 16],
  // pinky
  [13, 17], [17, 18], [18, 19], [19, 20],
  // palm rim
  [0, 17],
];

/* ========================================================================== *
 * Local MediaPipe assets (never a CDN)
 * ========================================================================== */

// Resolve assets relative to this module so the app also works when it is
// hosted under a sub-path (GitHub Pages: https://user.github.io/repo/).
const VENDOR_ROOT = new URL('../vendor/', import.meta.url);
const MP_VISION_MODULE = new URL('mediapipe/vision_bundle.mjs', VENDOR_ROOT).href;
const MP_WASM_ROOT = new URL('mediapipe/wasm', VENDOR_ROOT).href;
const MP_MODEL_PATH = new URL('models/hand_landmarker.task', VENDOR_ROOT).href;

/* ========================================================================== *
 * MediaPipe landmark indices used by the gesture maths
 * ========================================================================== */

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const RING_MCP = 13;
const PINKY_MCP = 17;
const INDEX_TIP = 8;

/** Per finger (thumb → pinky): base joint, first joint, second joint, tip. */
const FINGER_BASE = [1, 5, 9, 13, 17];
const FINGER_JOINT_A = [2, 6, 10, 14, 18];
const FINGER_JOINT_B = [3, 7, 11, 15, 19];
const FINGER_TIP = [4, 8, 12, 16, 20];

/** Tips in thumb → pinky order, as promised by the contract. */
const TIP_ORDER = [4, 8, 12, 16, 20];

/** Openness weights for index / middle / ring / pinky (middle is most stable). */
const FINGER_WEIGHTS = [1.0, 1.15, 0.95, 0.8];
const FINGER_WEIGHT_SUM = 3.9;

/* ========================================================================== *
 * Tuning constants (documented for integration & QA)
 * ========================================================================== */

/**
 * Detection cadence. At 60 Hz rendering a 1000/36 ms gate yields one detection
 * every second frame (~30 fps); at 120 Hz it yields ~30 fps as well; on a slow
 * 30 fps main loop every frame is used. Keeps MediaPipe CPU cost off the
 * render critical path.
 */
const DETECT_INTERVAL_MS = 1000 / 36;

/** Keep reporting the hand (last smoothed pose) for this long after loss. */
const HAND_LOST_GRACE_MS = 400;

/** Camera metadata/play watchdog. */
const CAMERA_TIMEOUT_MS = 12000;

/** Exponential smoothing time constants (seconds). */
const SMOOTH_POS_TAU = 0.055;      // palm / landmarks follow the hand quickly
const SMOOTH_OPENNESS_TAU = 0.10;  // openness is intentionally calmer
const SMOOTH_PINCH_TAU = 0.09;
const SMOOTH_FINGER_TAU = 0.10;    // per-finger extension used by gestures
const SMOOTH_VELOCITY_TAU = 0.12;

/** Gesture hysteresis thresholds (enter / exit). */
const OPEN_ENTER = 0.62;
const OPEN_EXIT = 0.52;
const FIST_ENTER = 0.24;
const FIST_EXIT = 0.32;
const PINCH_ENTER = 0.72;
const PINCH_EXIT = 0.52;
/** Middle+ring average extension needed to call a pinch a pinch. */
const PINCH_FINGERS_ENTER = 0.55;
const PINCH_FINGERS_EXIT = 0.35;

/** Velocity clamp, normalised units per second. */
const VELOCITY_LIMIT = 6;

/** Overlay palette — thin mint skeleton, warm-gold index fingertip. */
const MINT_LINE = 'rgba(150, 240, 210, 0.5)';
const MINT_JOINT = 'rgba(205, 255, 238, 0.72)';
const MINT_TIP = 'rgba(226, 255, 245, 0.85)';
const GOLD_CORE = 'rgba(255, 230, 176, 0.95)';
const GOLD_HALO_CENTER = 'rgba(255, 214, 140, 0.5)';
const GOLD_HALO_MID = 'rgba(255, 196, 110, 0.16)';
const GOLD_HALO_EDGE = 'rgba(255, 180, 90, 0)';
const TWO_PI = Math.PI * 2;

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function makeError(message, name, cause) {
  const error = new Error(message);
  if (name) error.name = name;
  if (cause !== undefined) {
    try {
      error.cause = cause;
    } catch (_) {
      /* older engines: ignore */
    }
  }
  return error;
}

function abortError() {
  return makeError('摄像头启动已取消', 'AbortError');
}

function stopStreamTracks(stream) {
  try {
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : [];
    for (let i = 0; i < tracks.length; i += 1) {
      try {
        tracks[i].stop();
      } catch (_) {
        /* individual track stop must never break teardown */
      }
    }
  } catch (_) {
    /* stream may be a stub in tests */
  }
}

/** Map a getUserMedia / media element failure to a Chinese, named Error. */
function mapCameraError(error) {
  const rawName = error && typeof error.name === 'string' ? error.name : '';
  let message;
  switch (rawName) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      message = '摄像头权限被拒绝。请在浏览器地址栏允许摄像头访问后重试。';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      message = '未找到可用的摄像头设备，请连接摄像头后重试。';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      message = '摄像头被其他应用占用，无法读取。请关闭占用摄像头的程序后重试。';
      break;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      message = '摄像头不支持所需的画面尺寸，请更换设备后重试。';
      break;
    case 'NotSupportedError':
      message = '当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。';
      break;
    case 'AbortError':
      message = '摄像头启动已取消';
      break;
    default:
      message = '无法启动摄像头，请检查设备与浏览器权限设置。';
      break;
  }
  return makeError(message, rawName || 'CameraError', error);
}

function createLandmarkArray() {
  const landmarks = new Array(21);
  for (let i = 0; i < 21; i += 1) landmarks[i] = { x: 0.5, y: 0.5, z: 0 };
  return landmarks;
}

/* ========================================================================== *
 * HandTracker
 * ========================================================================== */

export class HandTracker {
  /**
   * @param {{
   *   video: HTMLVideoElement,
   *   overlay: HTMLCanvasElement,
   *   onStatus?: (status: {
   *     phase: 'camera'|'model'|'ready'|'error',
   *     message: string,
   *     detail?: string,
   *     progress?: number
   *   }) => void
   * }} options
   */
  constructor(options = {}) {
    const video = options.video;
    const overlay = options.overlay;
    if (!video || typeof video !== 'object') {
      throw new TypeError('HandTracker: options.video 必须是 <video> 元素');
    }
    if (!overlay || typeof overlay !== 'object') {
      throw new TypeError('HandTracker: options.overlay 必须是 <canvas> 元素');
    }

    this._video = video;
    this._overlay = overlay;
    this._onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

    /** @type {CanvasRenderingContext2D|null} */
    this._ctx = null;
    try {
      this._ctx = typeof overlay.getContext === 'function' ? overlay.getContext('2d') : null;
    } catch (_) {
      this._ctx = null; // never fatal: tracking still works, overlay is skipped
    }

    /** Camera / MediaPipe resources. */
    this._stream = null;
    /** @type {any} */
    this._landmarker = null;
    /** @type {any} */
    this._mp = null;
    /** @type {any} */
    this._vision = null;
    /** @type {'GPU'|'CPU'|null} */
    this._delegate = null;
    this._startPromise = null;
    this._cpuSwitchPromise = null;

    /** Session token: invalidates an in-flight start() when stop() is called. */
    this._session = 0;
    this._running = false;

    /** Timing bookkeeping. */
    this._lastUpdateAt = -1;
    this._lastDetectAt = -Infinity;
    this._lastVideoTs = 0;
    this._lastSeenAt = -Infinity;
    this._detectFailures = 0;
    this._fps = 0;
    this._videoAspect = 16 / 9;

    /** Gesture state machine memory (hysteresis). */
    this._gesture = 'none';
    this._handedness = null;

    /** Smoothed output pose (mutated in place, never re-allocated). */
    this._smoothLandmarks = createLandmarkArray();
    this._smooth = {
      openness: 0,
      pinch: 0,
      palm: { x: 0.5, y: 0.5, z: 0 },
      velocity: { x: 0, y: 0 },
    };
    this._prevPalmX = 0.5;
    this._prevPalmY = 0.5;

    /** Latest detection target (raw, mirrored, unsmoothed). */
    this._targetLandmarks = createLandmarkArray();
    this._target = {
      openness: 0,
      pinch: 0,
      palm: { x: 0.5, y: 0.5, z: 0 },
    };
    this._fingerExt = new Float32Array(5);
    this._fingerTarget = new Float32Array(5);

    /** Reused detection metrics scratch. */
    this._metrics = {
      openness: 0,
      pinch: 0,
      palmX: 0.5,
      palmY: 0.5,
      palmZ: 0,
      fingers: this._fingerTarget,
    };

    /** Overlay bookkeeping. */
    this._overlayW = 0;
    this._overlayH = 0;
    this._overlayDpr = 0;
    this._projX = new Float32Array(21);
    this._projY = new Float32Array(21);

    /** The object returned by update(); nested refs are stable. */
    this._tips = [
      this._smoothLandmarks[THUMB_TIP],
      this._smoothLandmarks[INDEX_TIP],
      this._smoothLandmarks[12],
      this._smoothLandmarks[16],
      this._smoothLandmarks[20],
    ];
    this._snapshot = {
      present: false,
      gesture: 'none',
      openness: 0,
      pinch: 0,
      palm: this._smooth.palm,
      indexTip: this._smoothLandmarks[INDEX_TIP],
      tips: this._tips,
      velocity: this._smooth.velocity,
      landmarks: null,
      handedness: null,
      fps: 0,
    };

    this._resetTracking();
  }

  /** @returns {boolean} true once start() has completed and the tracker is live. */
  get running() {
    return this._running;
  }

  /** @returns {'GPU'|'CPU'|null} active MediaPipe delegate (diagnostics). */
  get delegate() {
    return this._delegate;
  }

  /* ======================================================================== *
   * Lifecycle
   * ======================================================================== */

  /**
   * Request the camera and load MediaPipe. Resolves when READY; rejects with a
   * named, Chinese-messaged Error on failure (all acquired resources released).
   * @returns {Promise<void>}
   */
  start() {
    if (this._running) return Promise.resolve();
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._doStart().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _doStart() {
    const token = ++this._session;
    const alive = () => token === this._session;

    this._emit('camera', '正在唤醒摄像头…', 0.1);

    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        throw makeError(
          '当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。',
          'NotSupportedError'
        );
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (error) {
        throw mapCameraError(error);
      }

      if (!alive()) {
        stopStreamTracks(stream);
        throw abortError();
      }
      this._stream = stream;

      const video = this._video;
      try {
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
      } catch (_) {
        /* property assignment on a stub must not abort start */
      }

      this._emit('camera', '摄像头已连接，正在准备画面…', 0.22);
      await this._waitForVideo();
      if (!alive()) throw abortError();

      try {
        await video.play();
      } catch (error) {
        throw mapCameraError(error);
      }
      if (!alive()) throw abortError();
      if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) {
        throw makeError('摄像头画面尚未就绪，请稍后重试。', 'CameraError');
      }
      this._emit('camera', '摄像头已就绪', 0.38);

      this._emit('model', '正在加载手部追踪模型…', 0.5);
      let mp;
      try {
        mp = await import(MP_VISION_MODULE);
      } catch (cause) {
        throw makeError('手部追踪模型加载失败，请刷新页面重试。', 'ModelError', cause);
      }
      if (!alive()) throw abortError();

      const FilesetResolver = mp && mp.FilesetResolver;
      const HandLandmarker = mp && mp.HandLandmarker;
      if (!FilesetResolver || !HandLandmarker) {
        throw makeError('手部追踪运行库不完整，请检查 vendor 目录是否完整。', 'ModelError');
      }
      this._mp = mp;

      this._emit('model', '正在准备手部追踪引擎…', 0.62);
      let vision;
      try {
        vision = await FilesetResolver.forVisionTasks(MP_WASM_ROOT);
      } catch (cause) {
        throw makeError('手部追踪引擎加载失败，请刷新页面重试。', 'ModelError', cause);
      }
      if (!alive()) throw abortError();
      this._vision = vision;

      this._emit('model', '正在加载手部追踪模型…', 0.65);
      let landmarker = null;
      try {
        landmarker = await this._createLandmarker(HandLandmarker, vision, 'GPU');
        this._delegate = 'GPU';
      } catch (gpuError) {
        this._emit('model', 'GPU 不可用，正在使用 CPU 模式…', 0.78);
        this._delegate = 'CPU';
        try {
          landmarker = await this._createLandmarker(HandLandmarker, vision, 'CPU');
        } catch (cpuError) {
          throw makeError(
            '手部追踪模型初始化失败，请刷新页面重试。',
            'ModelError',
            cpuError
          );
        }
      }
      if (!alive()) {
        try {
          if (landmarker && typeof landmarker.close === 'function') landmarker.close();
        } catch (_) {
          /* ignore */
        }
        throw abortError();
      }

      this._landmarker = landmarker;
      this._resetTracking();
      this._emit('model', '手部追踪模型已加载', 0.9);
      this._running = true;
      this._emit('ready', '手部追踪已就绪', 1);
    } catch (error) {
      const stopped = !alive();
      this._teardown();
      let out = error;
      if (stopped || (error && error.name === 'AbortError')) out = abortError();
      // A user-initiated stop() is not an error worth surfacing in the UI.
      if (!out || out.name !== 'AbortError') {
        this._emit(
          'error',
          out && out.message ? out.message : '摄像头启动失败，请刷新页面重试。',
          undefined,
          out && out.name
        );
      }
      throw out;
    }
  }

  /**
   * Stop tracks, close MediaPipe, clear the overlay. Idempotent and safe before
   * start(); a start() in flight is cancelled and rejects with AbortError.
   */
  stop() {
    this._session += 1; // invalidates an in-flight start()/CPU fallback
    this._running = false;

    if (this._stream) {
      stopStreamTracks(this._stream);
      this._stream = null;
    }
    if (this._landmarker) {
      try {
        if (typeof this._landmarker.close === 'function') this._landmarker.close();
      } catch (_) {
        /* already closed */
      }
      this._landmarker = null;
    }
    this._delegate = null;
    this._mp = null;
    this._vision = null;

    const video = this._video;
    if (video) {
      try {
        if (typeof video.pause === 'function') video.pause();
      } catch (_) {
        /* ignore */
      }
      try {
        video.srcObject = null;
      } catch (_) {
        /* ignore */
      }
    }

    this._clearOverlay();
    this._resetTracking();
  }

  /* ======================================================================== *
   * Per-frame update
   * ======================================================================== */

  /**
   * Advance tracking by one main-loop frame. Always returns the contract shape;
   * never throws for camera/MediaPipe hiccups.
   * @param {number} nowMs performance.now()
   * @param {number} dt seconds since the previous update
   * @returns {{
   *   present: boolean, gesture: string, openness: number, pinch: number,
   *   palm: {x:number,y:number,z:number},
   *   indexTip: {x:number,y:number,z:number},
   *   tips: Array<{x:number,y:number,z:number}>,
   *   velocity: {x:number,y:number},
   *   landmarks: Array<{x:number,y:number,z:number}>|null,
   *   handedness: 'Left'|'Right'|null,
   *   fps: number
   * }}
   */
  update(nowMs, dt) {
    const now = this._resolveNow(nowMs);
    const step = this._resolveStep(now, dt);

    if (!this._running) {
      this._publishIdle();
      return this._snapshot;
    }

    // 1) Detection, throttled to ~30 fps.
    if (
      this._landmarker &&
      this._videoIsReady() &&
      now - this._lastDetectAt >= DETECT_INTERVAL_MS
    ) {
      this._detect(now);
    }

    // 2) Ease every output toward the newest detection target.
    this._smoothStep(step);

    // 3) Presence with a short grace period so the flower can relax smoothly.
    const sinceSeen = now - this._lastSeenAt;
    const present = Number.isFinite(this._lastSeenAt) && sinceSeen <= HAND_LOST_GRACE_MS;

    // 4) Gesture label (hysteresis, evaluated on smoothed values).
    if (present) {
      this._gesture = this._nextGesture(
        this._gesture,
        this._smooth.openness,
        this._smooth.pinch,
        this._fingerExt
      );
    } else {
      this._gesture = 'none';
    }

    // 5) Publish the reusable result object.
    const snapshot = this._snapshot;
    snapshot.present = present;
    snapshot.gesture = present ? this._gesture : 'none';
    snapshot.openness = this._smooth.openness;
    snapshot.pinch = this._smooth.pinch;
    snapshot.palm = this._smooth.palm;
    snapshot.indexTip = this._smoothLandmarks[INDEX_TIP];
    snapshot.tips = this._tips;
    snapshot.velocity = this._smooth.velocity;
    snapshot.landmarks = present ? this._smoothLandmarks : null;
    snapshot.handedness = present ? this._handedness : null;
    snapshot.fps = this._fps > 0 ? Math.round(this._fps * 10) / 10 : 0;

    // 6) Overlay: mirrored skeleton aligned with the video crop.
    this._drawOverlay(now, present);

    return snapshot;
  }

  /* ======================================================================== *
   * Detection
   * ======================================================================== */

  _videoIsReady() {
    const video = this._video;
    return (
      !!video &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    );
  }

  _detect(now) {
    const video = this._video;

    // Landmark coordinates are normalised per-axis, so aspect-correct all
    // metric maths with the real frame aspect ratio.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) this._videoAspect = vw / vh;

    const prevDetectAt = this._lastDetectAt;
    this._lastDetectAt = now;
    if (Number.isFinite(prevDetectAt) && now > prevDetectAt) {
      const inst = 1000 / (now - prevDetectAt);
      this._fps = this._fps > 0 ? this._fps + (inst - this._fps) * 0.15 : inst;
    }

    // MediaPipe VIDEO mode requires strictly increasing integer timestamps.
    const timestamp = Math.max(Math.round(now), this._lastVideoTs + 1);
    this._lastVideoTs = timestamp;

    let result;
    try {
      result = this._landmarker.detectForVideo(video, timestamp);
    } catch (error) {
      this._detectFailures += 1;
      this._maybeSwitchToCpu();
      return;
    }
    this._detectFailures = 0;

    const hands = result && result.landmarks;
    const raw = hands && hands.length ? hands[0] : null;
    if (raw && raw.length >= 21) {
      this._ingest(raw, result, now);
    }
  }

  _ingest(raw, result, now) {
    // Validate once: malformed detections are ignored instead of throwing.
    for (let i = 0; i < 21; i += 1) {
      const lm = raw[i];
      if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return;
    }

    const aspect = this._videoAspect;
    const metrics = this._computeMetrics(raw, aspect);
    const targetLandmarks = this._targetLandmarks;
    const target = this._target;

    for (let i = 0; i < 21; i += 1) {
      const lm = raw[i];
      const point = targetLandmarks[i];
      // Selfie mirror: x = 1 - x so x grows to the viewer's right.
      point.x = 1 - lm.x;
      point.y = lm.y;
      point.z = Number.isFinite(lm.z) ? lm.z : 0;
    }

    target.openness = metrics.openness;
    target.pinch = metrics.pinch;
    target.palm.x = 1 - metrics.palmX;
    target.palm.y = metrics.palmY;
    target.palm.z = metrics.palmZ;

    const fingers = metrics.fingers;
    for (let f = 0; f < 5; f += 1) this._fingerTarget[f] = fingers[f];

    // MediaPipe's label refers to the hand's actual anatomy for the frame we
    // feed it. We pass the raw (unmirrored) camera frame, so the label passes
    // through unchanged — verified against a known unmirrored right-palm photo
    // (MediaPipe 0.10.22 → 'Right'). Mirroring only happens for display.
    let handedness = null;
    const handCategories =
      (result && result.handedness) || (result && result.handednesses);
    if (handCategories && handCategories[0] && handCategories[0][0]) {
      const name = handCategories[0][0].categoryName;
      if (name === 'Left' || name === 'Right') handedness = name;
    }
    this._handedness = handedness;

    const gap = Number.isFinite(this._lastSeenAt) ? now - this._lastSeenAt : Infinity;
    this._lastSeenAt = now;
    // First sighting (or re-entry): snap positions instead of flying in from
    // wherever the previous hand was; openness/pinch still ease in.
    if (gap > 250) this._snapPoseToTarget();
  }

  /**
   * Scale-normalised hand metrics.
   * All distances are computed in "frame-height units": x deltas are multiplied
   * by the frame aspect ratio so the result is independent of resolution and of
   * hand distance from the camera.
   */
  _computeMetrics(raw, aspect) {
    const metrics = this._metrics;

    // Palm centre from wrist + the four MCP joints.
    const palmX =
      (raw[WRIST].x + raw[INDEX_MCP].x + raw[MIDDLE_MCP].x + raw[RING_MCP].x + raw[PINKY_MCP].x) *
      0.2;
    const palmY =
      (raw[WRIST].y + raw[INDEX_MCP].y + raw[MIDDLE_MCP].y + raw[RING_MCP].y + raw[PINKY_MCP].y) *
      0.2;
    const palmZ =
      ((Number.isFinite(raw[WRIST].z) ? raw[WRIST].z : 0) +
        (Number.isFinite(raw[INDEX_MCP].z) ? raw[INDEX_MCP].z : 0) +
        (Number.isFinite(raw[MIDDLE_MCP].z) ? raw[MIDDLE_MCP].z : 0) +
        (Number.isFinite(raw[RING_MCP].z) ? raw[RING_MCP].z : 0) +
        (Number.isFinite(raw[PINKY_MCP].z) ? raw[PINKY_MCP].z : 0)) *
      0.2;

    // Palm scale: mean of wrist→middle-MCP (length) and index→pinky-MCP (width).
    const wrist = raw[WRIST];
    const middleMcp = raw[MIDDLE_MCP];
    const indexMcp = raw[INDEX_MCP];
    const pinkyMcp = raw[PINKY_MCP];
    const palmLength = Math.hypot(
      (wrist.x - middleMcp.x) * aspect,
      wrist.y - middleMcp.y
    );
    const palmWidth = Math.hypot(
      (indexMcp.x - pinkyMcp.x) * aspect,
      indexMcp.y - pinkyMcp.y
    );
    const scale = Math.max(0.02, (palmLength + palmWidth) * 0.5);
    const widthSafe = Math.max(0.02, palmWidth);

    // Per-finger extension: straightness of the joint chain blended with the
    // normalised tip-to-palm reach. Both are scale invariant.
    const fingers = metrics.fingers;
    let weighted = 0;
    for (let f = 1; f < 5; f += 1) {
      const base = raw[FINGER_BASE[f]];
      const jointA = raw[FINGER_JOINT_A[f]];
      const jointB = raw[FINGER_JOINT_B[f]];
      const tip = raw[FINGER_TIP[f]];

      const chain =
        Math.hypot((jointA.x - base.x) * aspect, jointA.y - base.y) +
        Math.hypot((jointB.x - jointA.x) * aspect, jointB.y - jointA.y) +
        Math.hypot((tip.x - jointB.x) * aspect, tip.y - jointB.y);
      const direct = Math.hypot((tip.x - base.x) * aspect, tip.y - base.y);
      const straightness = chain > 1e-6 ? direct / chain : 0;

      const reach =
        Math.hypot((tip.x - palmX) * aspect, tip.y - palmY) / scale;

      const straightScore = clamp01((straightness - 0.6) / 0.34);
      const reachScore = clamp01((reach - 0.95) / 0.6);
      const ext = straightScore * 0.55 + reachScore * 0.45;
      fingers[f] = ext;
      weighted += ext * FINGER_WEIGHTS[f - 1];
    }
    fingers[0] = 0; // thumb extension is not used for openness

    metrics.openness = clamp01(weighted / FINGER_WEIGHT_SUM);
    metrics.palmX = palmX;
    metrics.palmY = palmY;
    metrics.palmZ = palmZ;

    // Pinch: thumb-tip ↔ index-tip distance as a fraction of palm width.
    // 0.12 palm-widths → 1 (touching), 0.8 palm-widths → 0 (apart).
    const pinchDistance =
      Math.hypot((raw[THUMB_TIP].x - raw[INDEX_TIP].x) * aspect, raw[THUMB_TIP].y - raw[INDEX_TIP].y) /
      widthSafe;
    metrics.pinch = clamp01(1 - (pinchDistance - 0.12) / 0.68);

    return metrics;
  }

  /* ======================================================================== *
   * Smoothing
   * ======================================================================== */

  _smoothStep(dt) {
    const posAlpha = 1 - Math.exp(-dt / SMOOTH_POS_TAU);
    const openAlpha = 1 - Math.exp(-dt / SMOOTH_OPENNESS_TAU);
    const pinchAlpha = 1 - Math.exp(-dt / SMOOTH_PINCH_TAU);
    const fingerAlpha = 1 - Math.exp(-dt / SMOOTH_FINGER_TAU);
    const velocityAlpha = 1 - Math.exp(-dt / SMOOTH_VELOCITY_TAU);

    const smoothLandmarks = this._smoothLandmarks;
    const targetLandmarks = this._targetLandmarks;
    for (let i = 0; i < 21; i += 1) {
      const s = smoothLandmarks[i];
      const t = targetLandmarks[i];
      s.x += (t.x - s.x) * posAlpha;
      s.y += (t.y - s.y) * posAlpha;
      s.z += (t.z - s.z) * posAlpha;
    }

    const smooth = this._smooth;
    const target = this._target;
    smooth.palm.x += (target.palm.x - smooth.palm.x) * posAlpha;
    smooth.palm.y += (target.palm.y - smooth.palm.y) * posAlpha;
    smooth.palm.z += (target.palm.z - smooth.palm.z) * posAlpha;
    smooth.openness += (target.openness - smooth.openness) * openAlpha;
    smooth.pinch += (target.pinch - smooth.pinch) * pinchAlpha;

    for (let f = 0; f < 5; f += 1) {
      this._fingerExt[f] += (this._fingerTarget[f] - this._fingerExt[f]) * fingerAlpha;
    }

    // Palm velocity from the smoothed position (normalised units / second).
    if (dt > 1e-4) {
      const inv = 1 / dt;
      const vx = clamp((smooth.palm.x - this._prevPalmX) * inv, -VELOCITY_LIMIT, VELOCITY_LIMIT);
      const vy = clamp((smooth.palm.y - this._prevPalmY) * inv, -VELOCITY_LIMIT, VELOCITY_LIMIT);
      smooth.velocity.x += (vx - smooth.velocity.x) * velocityAlpha;
      smooth.velocity.y += (vy - smooth.velocity.y) * velocityAlpha;
    }
    this._prevPalmX = smooth.palm.x;
    this._prevPalmY = smooth.palm.y;
  }

  _snapPoseToTarget() {
    const smoothLandmarks = this._smoothLandmarks;
    const targetLandmarks = this._targetLandmarks;
    for (let i = 0; i < 21; i += 1) {
      const s = smoothLandmarks[i];
      const t = targetLandmarks[i];
      s.x = t.x;
      s.y = t.y;
      s.z = t.z;
    }
    const smooth = this._smooth;
    smooth.palm.x = this._target.palm.x;
    smooth.palm.y = this._target.palm.y;
    smooth.palm.z = this._target.palm.z;
    smooth.velocity.x = 0;
    smooth.velocity.y = 0;
    this._prevPalmX = smooth.palm.x;
    this._prevPalmY = smooth.palm.y;
  }

  /* ======================================================================== *
   * Gesture state machine (hysteresis)
   * ======================================================================== */

  /**
   * Priority: pinch (thumb+index touching while middle/ring stay open) →
   * fist → open → half. Enter/exit thresholds differ so labels never flicker.
   */
  _nextGesture(previous, openness, pinch, fingers) {
    const middleRing = (fingers[2] + fingers[3]) * 0.5;

    const pinching =
      previous === 'pinch'
        ? pinch > PINCH_EXIT && middleRing > PINCH_FINGERS_EXIT
        : pinch > PINCH_ENTER && middleRing > PINCH_FINGERS_ENTER;
    if (pinching) return 'pinch';

    if (previous === 'fist' ? openness < FIST_EXIT : openness < FIST_ENTER) {
      return 'fist';
    }
    if (previous === 'open' ? openness > OPEN_EXIT : openness > OPEN_ENTER) {
      return 'open';
    }
    return 'half';
  }

  /* ======================================================================== *
   * Overlay
   * ======================================================================== */

  /** Resize the overlay backing store to its CSS box × DPR (capped at 2). */
  _ensureOverlaySize() {
    const context = this._ctx;
    const canvas = this._overlay;
    if (!context || !canvas) return false;

    const width = Math.round(canvas.clientWidth || 0);
    const height = Math.round(canvas.clientHeight || 0);
    if (width <= 0 || height <= 0) {
      this._overlayW = 0;
      this._overlayH = 0;
      return false;
    }

    const rawDpr =
      typeof window !== 'undefined' && window && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio
        : 1;
    const dpr = Math.min(2, Math.max(1, rawDpr || 1));
    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);

    let resized = false;
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      resized = true;
    }
    if (resized || this._overlayW !== width || this._overlayH !== height || this._overlayDpr !== dpr) {
      try {
        if (typeof context.setTransform === 'function') {
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
      } catch (_) {
        /* stub contexts */
      }
      this._overlayW = width;
      this._overlayH = height;
      this._overlayDpr = dpr;
    }
    return true;
  }

  _drawOverlay(now, present) {
    const context = this._ctx;
    if (!context) return;
    if (!this._ensureOverlaySize()) return;

    const width = this._overlayW;
    const height = this._overlayH;
    try {
      context.clearRect(0, 0, width, height);
    } catch (_) {
      return;
    }
    if (!present) return;

    const video = this._video;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!(videoWidth > 0) || !(videoHeight > 0)) return;

    // `object-fit: cover`: scale to fill, centre-crop. Mirrored video means the
    // normalised landmark x maps directly (both are already viewer-relative).
    const coverScale = Math.max(width / videoWidth, height / videoHeight);
    const drawWidth = videoWidth * coverScale;
    const drawHeight = videoHeight * coverScale;
    const offsetX = (width - drawWidth) * 0.5;
    const offsetY = (height - drawHeight) * 0.5;

    const landmarks = this._smoothLandmarks;
    const projX = this._projX;
    const projY = this._projY;
    for (let i = 0; i < 21; i += 1) {
      projX[i] = offsetX + landmarks[i].x * drawWidth;
      projY[i] = offsetY + landmarks[i].y * drawHeight;
    }

    try {
      // Skeleton: thin mint lines.
      context.lineWidth = 1.15;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = MINT_LINE;
      context.beginPath();
      for (let c = 0; c < HAND_CONNECTIONS.length; c += 1) {
        const a = HAND_CONNECTIONS[c][0];
        const b = HAND_CONNECTIONS[c][1];
        context.moveTo(projX[a], projY[a]);
        context.lineTo(projX[b], projY[b]);
      }
      context.stroke();

      // Joint dots.
      context.fillStyle = MINT_JOINT;
      context.beginPath();
      for (let i = 0; i < 21; i += 1) {
        context.moveTo(projX[i] + 1.6, projY[i]);
        context.arc(projX[i], projY[i], 1.6, 0, TWO_PI);
      }
      context.fill();

      // Non-index fingertips: slightly larger mint dots.
      context.fillStyle = MINT_TIP;
      context.beginPath();
      for (let f = 0; f < TIP_ORDER.length; f += 1) {
        if (f === 1) continue; // index handled below
        const tip = TIP_ORDER[f];
        context.moveTo(projX[tip] + 2.2, projY[tip]);
        context.arc(projX[tip], projY[tip], 2.2, 0, TWO_PI);
      }
      context.fill();

      // Index fingertip: warm gold core + soft pulsing halo.
      const indexX = projX[INDEX_TIP];
      const indexY = projY[INDEX_TIP];
      const pulse = 1 + Math.sin(now * 0.005) * 0.06;

      if (typeof context.save === 'function') context.save();
      if (typeof context.globalCompositeOperation === 'string') {
        context.globalCompositeOperation = 'lighter';
      }
      if (typeof context.createRadialGradient === 'function') {
        const haloRadius = 16 * pulse;
        const halo = context.createRadialGradient(indexX, indexY, 0, indexX, indexY, haloRadius);
        halo.addColorStop(0, GOLD_HALO_CENTER);
        halo.addColorStop(0.45, GOLD_HALO_MID);
        halo.addColorStop(1, GOLD_HALO_EDGE);
        context.fillStyle = halo;
        context.beginPath();
        context.arc(indexX, indexY, haloRadius, 0, TWO_PI);
        context.fill();
      }
      context.fillStyle = GOLD_CORE;
      context.beginPath();
      context.arc(indexX, indexY, 3.2, 0, TWO_PI);
      context.fill();
      if (typeof context.restore === 'function') context.restore();
    } catch (_) {
      // A broken 2D context must never take down the render loop.
    }
  }

  _clearOverlay() {
    const context = this._ctx;
    const canvas = this._overlay;
    if (!context || !canvas) return;
    try {
      if (typeof context.save === 'function') context.save();
      if (typeof context.setTransform === 'function') context.setTransform(1, 0, 0, 1, 0, 0);
      const width = canvas.width || 0;
      const height = canvas.height || 0;
      if (width > 0 && height > 0) context.clearRect(0, 0, width, height);
      if (typeof context.restore === 'function') context.restore();
    } catch (_) {
      /* ignore */
    }
  }

  /* ======================================================================== *
   * CPU fallback (GPU delegate failed at runtime)
   * ======================================================================== */

  _maybeSwitchToCpu() {
    if (this._delegate !== 'GPU' || this._cpuSwitchPromise) return;
    if (this._detectFailures < 3) return;
    const HandLandmarker = this._mp && this._mp.HandLandmarker;
    const vision = this._vision;
    if (!HandLandmarker || !vision) return;

    this._detectFailures = 0;
    const token = this._session;
    this._emit('model', 'GPU 模式不可用，正在切换到 CPU 模式…', 0.86);

    const oldLandmarker = this._landmarker;
    this._landmarker = null;
    try {
      if (oldLandmarker && typeof oldLandmarker.close === 'function') oldLandmarker.close();
    } catch (_) {
      /* ignore */
    }

    this._cpuSwitchPromise = (async () => {
      try {
        const created = await this._createLandmarker(HandLandmarker, vision, 'CPU');
        if (token !== this._session || !this._running) {
          try {
            if (created && typeof created.close === 'function') created.close();
          } catch (_) {
            /* ignore */
          }
          return;
        }
        this._landmarker = created;
        this._delegate = 'CPU';
        this._detectFailures = 0;
        this._lastDetectAt = -Infinity; // detect on the very next frame
        this._emit('model', '已切换到手部追踪 CPU 模式', 0.9);
        this._emit('ready', '手部追踪已就绪（CPU 模式）', 1);
      } catch (error) {
        this._emit(
          'error',
          '手部追踪暂时不可用，请刷新页面重试。',
          undefined,
          error && error.name
        );
      }
    })().finally(() => {
      this._cpuSwitchPromise = null;
    });
  }

  /* ======================================================================== *
   * Internals
   * ======================================================================== */

  _createLandmarker(HandLandmarker, vision, delegate) {
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MP_MODEL_PATH,
        delegate,
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.5,
    });
  }

  _waitForVideo() {
    const video = this._video;
    if (this._videoIsReady()) return Promise.resolve();
    if (typeof video.addEventListener !== 'function') {
      return Promise.resolve(); // stub; the readiness check happens after play()
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (typeof video.removeEventListener === 'function') {
          video.removeEventListener('loadedmetadata', check);
          video.removeEventListener('loadeddata', check);
          video.removeEventListener('error', onError);
          video.removeEventListener('emptied', onEmpty);
        }
        clearTimeout(timer);
      };
      const check = () => {
        if (settled) return;
        if (video.videoWidth > 0 && video.readyState >= 2) {
          cleanup();
          resolve();
        }
      };
      const onError = () => {
        if (settled) return;
        cleanup();
        reject(
          makeError('摄像头视频流初始化失败，请重新授权后重试。', 'CameraError', video.error || undefined)
        );
      };
      const onEmpty = () => {
        if (settled) return;
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(
          makeError('摄像头启动超时，请检查设备是否被其他程序占用。', 'CameraTimeoutError')
        );
      }, CAMERA_TIMEOUT_MS);

      video.addEventListener('loadedmetadata', check);
      video.addEventListener('loadeddata', check);
      video.addEventListener('error', onError);
      video.addEventListener('emptied', onEmpty);
    });
  }

  _teardown() {
    this._running = false;
    if (this._stream) {
      stopStreamTracks(this._stream);
      this._stream = null;
    }
    if (this._landmarker) {
      try {
        if (typeof this._landmarker.close === 'function') this._landmarker.close();
      } catch (_) {
        /* ignore */
      }
      this._landmarker = null;
    }
    this._delegate = null;
    this._mp = null;
    this._vision = null;

    const video = this._video;
    if (video) {
      try {
        if (typeof video.pause === 'function') video.pause();
      } catch (_) {
        /* ignore */
      }
      try {
        video.srcObject = null;
      } catch (_) {
        /* ignore */
      }
    }

    this._clearOverlay();
    this._resetTracking();
  }

  _resetTracking() {
    this._lastDetectAt = -Infinity;
    this._lastVideoTs = 0;
    this._lastSeenAt = -Infinity;
    this._detectFailures = 0;
    this._fps = 0;
    this._gesture = 'none';
    this._handedness = null;

    const smoothLandmarks = this._smoothLandmarks;
    for (let i = 0; i < 21; i += 1) {
      smoothLandmarks[i].x = 0.5;
      smoothLandmarks[i].y = 0.5;
      smoothLandmarks[i].z = 0;
    }
    const smooth = this._smooth;
    smooth.openness = 0;
    smooth.pinch = 0;
    smooth.palm.x = 0.5;
    smooth.palm.y = 0.5;
    smooth.palm.z = 0;
    smooth.velocity.x = 0;
    smooth.velocity.y = 0;
    this._prevPalmX = 0.5;
    this._prevPalmY = 0.5;

    const targetLandmarks = this._targetLandmarks;
    for (let i = 0; i < 21; i += 1) {
      targetLandmarks[i].x = 0.5;
      targetLandmarks[i].y = 0.5;
      targetLandmarks[i].z = 0;
    }
    this._target.openness = 0;
    this._target.pinch = 0;
    this._target.palm.x = 0.5;
    this._target.palm.y = 0.5;
    this._target.palm.z = 0;
    this._fingerExt.fill(0);
    this._fingerTarget.fill(0);
  }

  _publishIdle() {
    const snapshot = this._snapshot;
    snapshot.present = false;
    snapshot.gesture = 'none';
    snapshot.openness = this._smooth.openness;
    snapshot.pinch = this._smooth.pinch;
    snapshot.palm = this._smooth.palm;
    snapshot.indexTip = this._smoothLandmarks[INDEX_TIP];
    snapshot.tips = this._tips;
    snapshot.velocity = this._smooth.velocity;
    snapshot.landmarks = null;
    snapshot.handedness = null;
    snapshot.fps = this._fps > 0 ? Math.round(this._fps * 10) / 10 : 0;
  }

  _resolveNow(nowMs) {
    if (Number.isFinite(nowMs)) return nowMs;
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  _resolveStep(now, dt) {
    let step;
    if (Number.isFinite(dt)) {
      step = dt;
    } else if (this._lastUpdateAt >= 0) {
      step = (now - this._lastUpdateAt) / 1000;
    } else {
      step = 0;
    }
    this._lastUpdateAt = now;
    return clamp(step, 0, 0.1);
  }

  _emit(phase, message, progress, detail) {
    const callback = this._onStatus;
    if (!callback) return;
    const status = { phase, message };
    if (progress !== undefined) status.progress = progress;
    if (detail !== undefined) status.detail = detail;
    try {
      callback(status);
    } catch (_) {
      // A UI callback bug must not break camera/model setup.
    }
  }
}
