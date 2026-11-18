/* ───────────────────────────────────────────────────────────────
   Gesture control + AR mode.

   Webcam → MediaPipe hand landmarks → a small gesture vocabulary that
   drives the hologram directly, with the live camera feed rendered as
   the room behind it so the assembly floats in front of you and your
   hands are visible reaching into it.

   Everything runs locally: WASM and the landmark model are served from
   /public and no video leaves the machine.

   Vocabulary
   ──────────
     ✋  one open palm, moving      orbit the assembly
     🤏  one pinch, moving          grab and swing it (faster, 1:1)
     🤏🤏 two pinches, pull apart    exploded view  ← the Stark gesture
     ✋✋ two open palms, in/out     dolly the camera
     ☝️  index point                aim the reticle; hold to select a part
     ✊  fist                       clutch — freeze, reposition, resume

   Continuous gestures are relative: the anchor is re-captured whenever a
   gesture starts, so you can clutch out with a fist, bring your hand back
   to a comfortable position, and carry on — that's what gives the full
   range of motion without running out of arm.
   ─────────────────────────────────────────────────────────────── */

import { Spherical, Vector3, VideoTexture, SRGBColorSpace, LinearFilter } from 'three';

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/hand_landmarker.task';

const DETECT_HZ = 34;
const PINCH_ON = 0.34;   // enter pinch below this (fraction of hand size)
const PINCH_OFF = 0.46;  // leave pinch above this — hysteresis

/* ── Pointing ─────────────────────────────────────────────────── */
const DWELL_MS = 620;      // point-and-hold to select
const DWELL_GRACE_MS = 260; // how long a target survives the ray slipping off it
const SNAP_RADII = [0, 22, 44];  // px — reticle magnetism rings

/* ── Motion ───────────────────────────────────────────────────────
   Base gains are deliberately modest. Fine control comes from the
   response curve below rather than from a small gain, so a slow hand
   is precise and a fast sweep still crosses the whole model.        */
const GAIN_ORBIT = 1.5;
const GAIN_GRAB = 2.4;
const GAIN_EXPLODE = 1.3;
const GAIN_DOLLY = 0.75;

/** Hand travel below this (fraction of frame) is noise, not intent. */
const DEAD_ZONE = 0.0035;

/** Hand speed, in frame-widths per second, that maps to 1.0× gain. */
const REF_SPEED = 0.65;
const CURVE = 0.45;        // pointer-acceleration exponent
const BOOST_MIN = 0.32;
const BOOST_MAX = 1.7;

/** Time constant for easing accumulated gesture input into the camera. */
const MOTION_TAU = 0.0006;

const FINGERS = [
  { tip: 8, pip: 6 },   // index
  { tip: 12, pip: 10 }, // middle
  { tip: 16, pip: 14 }, // ring
  { tip: 20, pip: 18 }, // pinky
];

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const GESTURE_LABEL = {
  idle: 'READY',
  orbit: 'ORBIT',
  grab: 'GRAB',
  explode: 'PULL APART',
  zoom: 'DOLLY',
  aim: 'AIM',
  clutch: 'CLUTCH',
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * One Euro filter — low lag when the hand moves fast, heavy smoothing when
 * it is nearly still. A plain EMA has to trade one for the other, which is
 * why raw landmark tracking either jitters or feels like treacle.
 */
class OneEuro {
  // A lower minCutoff smooths harder when the hand is nearly still; a higher
  // beta lets genuine fast movement through without lag. The previous pair
  // (1.1 / 0.012) barely engaged the adaptive term, so resting jitter survived.
  constructor(minCutoff = 0.7, beta = 0.05, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(value, tMs) {
    if (this.x === null) { this.x = value; this.t = tMs; return value; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;

    const dxRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dxRaw - this.dx);

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.root      container for the gesture deck UI
 * @param {HTMLCanvasElement} deps.overlay  full-screen skeleton canvas
 * @param {object} deps.stage
 * @param {object} deps.env
 * @param {object} deps.store
 * @param {object} deps.interaction
 * @param {(msg: string, kind?: string) => void} [deps.log]
 */
export function createHandControl({ root, overlay, stage, env, store, interaction, log, onSelect }) {
  const els = buildDeck(root);

  let landmarker = null;
  let stream = null;
  let running = false;
  let arEnabled = true;
  let videoTexture = null;
  let lastDetect = 0;
  let lastVideoTime = -1;

  const handState = [makeHand(), makeHand()];

  let mode = 'idle';
  let anchor = null;
  let dwellStart = 0;
  let dwellTarget = null;
  let dwellSeen = 0;
  let latest = [];
  let sensitivity = 1;
  let lastFrame = 0;
  let lastDriveAt = 0;
  let skeletonAccent = null;

  /**
   * Gesture output is accumulated here and eased into the camera on the
   * render clock. Detection runs at 34 Hz and rendering at 60+, so applying
   * camera deltas straight from the detector stamped its slower cadence onto
   * every movement — which is most of what read as "glitchy".
   */
  const pending = { theta: 0, phi: 0 };
  const target = { radius: null, explode: null };

  const _sph = new Spherical();
  const _off = new Vector3();

  function makeHand() {
    return { fx: new OneEuro(), fy: new OneEuro(), x: 0, y: 0, pinched: false, seen: false };
  }

  /**
   * Pointer acceleration. A slow, deliberate hand gets a fraction of the gain
   * so you can land on a specific bolt flange; a fast sweep gets more than
   * full gain so you can still spin the model right round. Below the dead
   * zone nothing moves at all, which is what stops a resting hand drifting.
   */
  function respond(delta, dt, gain) {
    const a = Math.abs(delta);
    if (a < DEAD_ZONE) return 0;
    const travel = Math.sign(delta) * (a - DEAD_ZONE);
    const speed = a / Math.max(1e-3, dt);
    const boost = clamp(Math.pow(speed / REF_SPEED, CURVE), BOOST_MIN, BOOST_MAX);
    return travel * gain * boost * sensitivity;
  }

  /* ── Lifecycle ────────────────────────────────────────────── */

  async function enable() {
    if (running) return;
    setState('starting', 'Requesting camera…');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      setState('error', 'Camera denied');
      els.hint.textContent = 'Camera permission denied — gestures unavailable.';
      log?.(`Gesture control: camera access denied (${err.name}).`, 'err');
      return;
    }

    els.video.srcObject = stream;
    await els.video.play().catch(() => {});
    await new Promise((r) => {
      if (els.video.videoWidth) return r();
      els.video.onloadedmetadata = () => r();
    });

    if (!landmarker) {
      setState('starting', 'Loading model…');
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (err) {
        setState('error', 'Model failed');
        els.hint.textContent = 'Hand model failed to load.';
        log?.(`Gesture control: ${err.message}`, 'err');
        stopStream();
        return;
      }
    }

    videoTexture = new VideoTexture(els.video);
    videoTexture.colorSpace = SRGBColorSpace;
    videoTexture.minFilter = LinearFilter;
    videoTexture.magFilter = LinearFilter;
    videoTexture.generateMipmaps = false;

    applyAr();

    running = true;
    els.toggle.textContent = 'Disable camera';
    els.deck.classList.add('live');
    document.body.classList.add('hands-live');
    setState('live', 'READY');
    els.hint.textContent = '';
    log?.(
      'Gesture control online. Open palm orbits, pinch grabs, two pinches pull the assembly apart. The room behind the hologram is your camera.'
    );
  }

  function applyAr() {
    const on = arEnabled && running !== false && Boolean(videoTexture);
    env.setArMode(on, videoTexture);
    if (on) env.setVideoAspect(els.video.videoWidth, els.video.videoHeight);
    overlay.style.display = on ? '' : 'none';
    els.ar.setAttribute('aria-pressed', String(arEnabled));
    document.body.classList.toggle('ar', on);
  }

  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
  }

  function disable() {
    running = false;
    mode = 'idle';
    anchor = null;
    latest = [];
    // Drop queued motion, or re-enabling the camera would resume a gesture
    // the operator abandoned however long ago.
    pending.theta = 0;
    pending.phi = 0;
    target.radius = null;
    target.explode = null;
    dwellTarget = null;
    lastFrame = 0;
    stopStream();
    videoTexture?.dispose();
    videoTexture = null;
    env.setArMode(false, null);
    document.body.classList.remove('ar');
    overlay.style.display = 'none';
    clearCanvas(overlay);
    clearCanvas(els.canvas);
    els.toggle.textContent = 'Enable camera';
    els.deck.classList.remove('live');
    document.body.classList.remove('hands-live');
    setState('off', 'OFF');
    els.reticle.style.display = 'none';
  }

  function toggle() { running ? disable() : enable(); }

  function setState(kind, text) {
    els.state.textContent = text;
    els.state.dataset.kind = kind;
  }

  /* ── Gesture classification ───────────────────────────────── */

  function classify(landmarks, hand, now) {
    const wrist = landmarks[0];
    const size = Math.max(1e-4, dist(wrist, landmarks[9]));

    const extended = FINGERS.map(
      (f) => dist(landmarks[f.tip], wrist) > dist(landmarks[f.pip], wrist) * 1.07
    );
    const extCount = extended.filter(Boolean).length;

    const pinchRatio = dist(landmarks[4], landmarks[8]) / size;
    const pinched = hand.pinched ? pinchRatio < PINCH_OFF : pinchRatio < PINCH_ON;

    let pose = 'idle';
    if (pinched) pose = 'pinch';
    else if (extended[0] && extCount === 1) pose = 'point';
    else if (extCount >= 3) pose = 'open';
    else if (extCount === 0) pose = 'fist';

    const src = pinched
      ? { x: (landmarks[4].x + landmarks[8].x) / 2, y: (landmarks[4].y + landmarks[8].y) / 2 }
      : pose === 'point'
      ? landmarks[8]
      : landmarks[9];

    // Mirror X so the hologram tracks your hand the way a mirror would.
    hand.x = hand.fx.filter(1 - src.x, now);
    hand.y = hand.fy.filter(src.y, now);
    hand.pinched = pinched;
    hand.seen = true;

    return { pose, pinched, size, x: hand.x, y: hand.y, landmarks };
  }

  /* ── Camera helpers ───────────────────────────────────────── */

  /** Deltas arrive already gain- and curve-adjusted by `respond`. */
  function orbitBy(dx, dy) {
    const { camera, controls } = stage;
    _off.copy(camera.position).sub(controls.target);
    _sph.setFromVector3(_off);
    _sph.theta -= dx;
    _sph.phi = clamp(_sph.phi - dy, 0.12, Math.PI - 0.12);
    _off.setFromSpherical(_sph);
    camera.position.copy(controls.target).add(_off);
  }

  function dollyTo(radius) {
    const { camera, controls } = stage;
    _off.copy(camera.position).sub(controls.target);
    _sph.setFromVector3(_off);
    _sph.radius = clamp(radius, controls.minDistance, controls.maxDistance);
    _off.setFromSpherical(_sph);
    camera.position.copy(controls.target).add(_off);
  }

  const cameraRadius = () => stage.camera.position.distanceTo(stage.controls.target);

  /* ── Per-frame ────────────────────────────────────────────── */

  /** Ease whatever the detector has queued into the camera, on the render clock. */
  function applyMotion(dt) {
    const k = 1 - Math.pow(MOTION_TAU, dt);

    if (Math.abs(pending.theta) > 1e-6 || Math.abs(pending.phi) > 1e-6) {
      const dTheta = pending.theta * k;
      const dPhi = pending.phi * k;
      orbitBy(dTheta, dPhi);
      pending.theta -= dTheta;
      pending.phi -= dPhi;
    }

    if (target.radius !== null) {
      const r = cameraRadius();
      const next = r + (target.radius - r) * k;
      dollyTo(next);
      if (Math.abs(next - target.radius) < 1e-3) target.radius = null;
    }

    if (target.explode !== null) {
      const e = store.ui.explode;
      const next = e + (target.explode - e) * k;
      if (Math.abs(next - e) > 0.0015) store.setUi('explode', clamp(next, 0, 1));
      else target.explode = null;
    }
  }

  function update(now) {
    if (!running || !landmarker || els.video.readyState < 2) return;

    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;
    applyMotion(dt);

    if (now - lastDetect >= 1000 / DETECT_HZ && els.video.currentTime !== lastVideoTime) {
      lastDetect = now;
      lastVideoTime = els.video.currentTime;

      let result;
      try {
        result = landmarker.detectForVideo(els.video, now);
      } catch {
        return;
      }

      latest = result?.landmarks ?? [];
      const hands = latest.slice(0, 2).map((lm, i) => classify(lm, handState[i], now));

      if (!hands.length) {
        handState.forEach((h) => { h.seen = false; h.pinched = false; h.fx.reset(); h.fy.reset(); });
        mode = 'idle';
        anchor = null;
        dwellTarget = null;
        target.radius = null;
        target.explode = null;
        els.reticle.style.display = 'none';
      } else {
        drive(hands, Math.max(1e-3, (now - (lastDriveAt || now - 30)) / 1000));
        lastDriveAt = now;
      }

      els.mode.textContent = GESTURE_LABEL[mode] ?? mode;
      els.mode.dataset.mode = mode;
    }

    // Overlays redraw every frame so the skeleton never lags the feed.
    drawSkeleton(els.canvas, latest, 1.8, false);
    if (arEnabled) drawSkeleton(overlay, latest, 2.6, true);
  }

  function drive(hands, dt) {
    const two = hands.length === 2;
    const bothPinched = two && hands[0].pinched && hands[1].pinched;
    const bothOpen = two && hands[0].pose === 'open' && hands[1].pose === 'open';
    const h = hands[0];

    if (bothPinched || bothOpen) {
      const span = Math.hypot(hands[0].x - hands[1].x, hands[0].y - hands[1].y);
      const next = bothPinched ? 'explode' : 'zoom';
      if (mode !== next || !anchor) {
        mode = next;
        anchor = { span, explode: store.ui.explode, radius: cameraRadius() };
      }
      if (bothPinched) {
        target.explode = clamp(
          anchor.explode + (span - anchor.span) * GAIN_EXPLODE * sensitivity,
          0, 1
        );
      } else {
        const ratio = Math.pow(anchor.span / Math.max(0.05, span), GAIN_DOLLY * sensitivity);
        target.radius = clamp(anchor.radius * ratio, stage.controls.minDistance, stage.controls.maxDistance);
      }
      clearAim();
      return;
    }

    // Fist = clutch. Dropping the anchor is what lets you re-centre your
    // arm mid-gesture and keep going without the model snapping.
    if (h.pose === 'fist') {
      mode = 'clutch';
      anchor = null;
      clearAim();
      return;
    }

    if (h.pose === 'open' || h.pose === 'pinch') {
      const next = h.pose === 'pinch' ? 'grab' : 'orbit';
      if (mode !== next || !anchor) {
        mode = next;
        anchor = { x: h.x, y: h.y };
      }
      const gain = next === 'grab' ? GAIN_GRAB : GAIN_ORBIT;
      pending.theta += respond(h.x - anchor.x, dt, gain);
      pending.phi += respond(h.y - anchor.y, dt, gain);
      anchor.x = h.x;
      anchor.y = h.y;
      clearAim();
      return;
    }

    if (h.pose === 'point') {
      mode = 'aim';
      anchor = null;
      aim(h);
      return;
    }

    mode = 'idle';
    clearAim();
  }

  function clearAim() {
    els.reticle.style.display = 'none';
    els.reticleLabel.textContent = '';
    dwellTarget = null;
  }

  /**
   * Point-and-hold selection.
   *
   * Two things make this usable rather than infuriating: the ray snaps to a
   * nearby component instead of demanding a pixel-perfect hit, and a target
   * survives the ray slipping off it for a moment, so the dwell doesn't reset
   * every time your hand wavers.
   */
  function aim(h) {
    const px = h.x * window.innerWidth;
    const py = h.y * window.innerHeight;
    els.reticle.style.display = '';
    els.reticle.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;

    const hit = snapPick(px, py);
    const now = performance.now();
    let id = hit?.partId ?? null;

    // Grace: keep the previous target briefly so a wobble doesn't restart it.
    if (!id && dwellTarget && now - dwellSeen < DWELL_GRACE_MS) id = dwellTarget;

    interaction.setHover(id, hit?.point);
    els.reticleLabel.textContent = id ? partLabel(id) : '';

    if (id && id === dwellTarget) {
      dwellSeen = now;
      const held = now - dwellStart;
      els.reticle.style.setProperty('--dwell', `${Math.min(1, held / DWELL_MS)}`);
      if (held >= DWELL_MS) {
        interaction.select(id);
        onSelect?.(id);
        dwellTarget = null;
        els.reticle.classList.add('locked');
        setTimeout(() => els.reticle.classList.remove('locked'), 350);
      }
    } else {
      dwellTarget = id;
      dwellStart = now;
      dwellSeen = now;
      els.reticle.style.setProperty('--dwell', '0');
    }
  }

  /** Reticle magnetism: probe outward rings until something is hit. */
  function snapPick(px, py) {
    for (const r of SNAP_RADII) {
      if (r === 0) {
        const hit = interaction.pickAt(px, py);
        if (hit) return hit;
        continue;
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const hit = interaction.pickAt(px + Math.cos(a) * r, py + Math.sin(a) * r);
        if (hit) return hit;
      }
    }
    return null;
  }

  function partLabel(id) {
    return interaction.labelFor?.(id) ?? id;
  }

  /* ── Skeleton overlays ────────────────────────────────────── */

  function clearCanvas(c) {
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }

  /**
   * @param {boolean} cover  match the AR backdrop's cover-fit + mirror so the
   *                         drawn skeleton sits exactly on the real hand.
   */
  function drawSkeleton(canvas, allLandmarks, dotScale, cover) {
    const ctx = canvas.getContext('2d');
    // The AR overlay is full-screen and redrawn every frame; rasterising it at
    // full retina density costs more than it shows.
    const dpr = Math.min(window.devicePixelRatio, cover ? 1.5 : 2);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!allLandmarks.length) return;

    let sx = 1;
    let sy = 1;
    if (cover) {
      const va = (els.video.videoWidth || 4) / (els.video.videoHeight || 3);
      const sa = W / H;
      if (va > sa) sx = sa / va;
      else sy = va / sa;
    }
    const mapX = (nx) => (cover ? (1 - nx - 0.5) / sx + 0.5 : 1 - nx) * W;
    const mapY = (ny) => (cover ? 0.5 - (0.5 - ny) / sy : ny) * H;

    // Read once, not every frame — getComputedStyle forces a style recalc.
    const accent = (skeletonAccent ||=
      getComputedStyle(document.body).getPropertyValue('--live').trim() || '#7fd4ff');
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineWidth = cover ? 2.2 : 1.4;
    // Canvas shadowBlur is rasterised per draw call — on a full-screen overlay
    // with ~40 segments and 21 dots per hand it was the single most expensive
    // thing in the frame. One cheap glow pass on the bones only, none on dots.
    ctx.shadowColor = accent;
    ctx.shadowBlur = cover ? 6 : 0;
    ctx.globalAlpha = cover ? 0.85 : 1;

    for (const lm of allLandmarks) {
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(mapX(lm[a].x), mapY(lm[a].y));
        ctx.lineTo(mapX(lm[b].x), mapY(lm[b].y));
      }
      ctx.stroke();

      ctx.shadowBlur = 0;
      for (let i = 0; i < lm.length; i++) {
        const r = i === 4 || i === 8 ? dotScale * 1.8 : dotScale;
        ctx.beginPath();
        ctx.arc(mapX(lm[i].x), mapY(lm[i].y), r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pinch indicator between thumb and index
      const pinchX = (mapX(lm[4].x) + mapX(lm[8].x)) / 2;
      const pinchY = (mapY(lm[4].y) + mapY(lm[8].y)) / 2;
      const gap = Math.hypot(mapX(lm[4].x) - mapX(lm[8].x), mapY(lm[4].y) - mapY(lm[8].y));
      if (cover && gap < 46) {
        ctx.beginPath();
        ctx.arc(pinchX, pinchY, 14 + gap * 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  /* ── Wiring ───────────────────────────────────────────────── */

  els.toggle.addEventListener('click', toggle);
  els.ar.addEventListener('click', () => {
    arEnabled = !arEnabled;
    applyAr();
  });

  // Reach, camera field of view and how steady your hand is all vary, so the
  // right gain is a personal setting rather than a constant. Remembered across
  // sessions — nobody wants to re-find it every time.
  const SENS_KEY = 'agent-forge:gesture-sensitivity';
  function setSensitivity(v) {
    sensitivity = clamp(Number(v) || 1, 0.3, 1.8);
    els.sens.value = String(sensitivity);
    els.sensOut.textContent = `${sensitivity.toFixed(2)}×`;
    try { localStorage.setItem(SENS_KEY, String(sensitivity)); } catch { /* private mode */ }
  }
  els.sens.addEventListener('input', () => setSensitivity(els.sens.value));
  let stored = null;
  try { stored = localStorage.getItem(SENS_KEY); } catch { /* private mode */ }
  setSensitivity(stored ?? 1);

  // How bright your room is behind the projection. Rooms vary enormously and
  // the hologram is additive, so there is no single value that works for a
  // sunlit desk and a dark study alike.
  const ROOM_KEY = 'agent-forge:room-brightness';
  function setRoomBrightness(v) {
    const exposure = clamp(Number(v) || 0.62, 0.05, 1.3);
    els.room.value = String(exposure);
    els.roomOut.textContent = `${Math.round(exposure * 100)}%`;
    env.setRoomGrade({ exposure });
    try { localStorage.setItem(ROOM_KEY, String(exposure)); } catch { /* private mode */ }
  }
  els.room.addEventListener('input', () => setRoomBrightness(els.room.value));
  let storedRoom = null;
  try { storedRoom = localStorage.getItem(ROOM_KEY); } catch { /* private mode */ }
  setRoomBrightness(storedRoom ?? 0.62);
  window.addEventListener('resize', () => {
    if (running) env.setVideoAspect(els.video.videoWidth, els.video.videoHeight);
  });

  return {
    enable, disable, toggle, update, setSensitivity, setRoomBrightness,
    get sensitivity() { return sensitivity; },
    get running() { return running; },
  };
}

/* ── Deck UI ─────────────────────────────────────────────────── */

function buildDeck(root) {
  root.innerHTML = `
    <div class="deck-head">
      <span class="glyph">◈</span><span>Gesture Control</span>
      <span class="spacer"></span>
      <span class="deck-state" data-kind="off">OFF</span>
    </div>
    <div class="deck-view">
      <video playsinline muted autoplay></video>
      <canvas></canvas>
      <div class="deck-mode" data-mode="idle">—</div>
      <div class="deck-hint">Camera off</div>
    </div>
    <div class="deck-actions">
      <button class="btn deck-toggle">Enable camera</button>
      <button class="btn deck-ar" aria-pressed="true">AR room</button>
    </div>
    <div class="ctl deck-tune">
      <div class="ctl-top"><label for="deck-sens">Sensitivity</label><output>1.00×</output></div>
      <input id="deck-sens" type="range" min="0.3" max="1.8" step="0.05" value="1" />
    </div>
    <div class="ctl deck-tune deck-room">
      <div class="ctl-top"><label for="deck-room">Room brightness</label><output>62%</output></div>
      <input id="deck-room" type="range" min="0.05" max="1.3" step="0.05" value="0.62" />
    </div>
    <div class="deck-legend">
      <div><b>✋</b> orbit</div>
      <div><b>🤏</b> grab &amp; swing</div>
      <div><b>🤏🤏</b> pull apart</div>
      <div><b>✋✋</b> dolly</div>
      <div><b>☝︎</b> aim · hold to select</div>
      <div><b>✊</b> clutch</div>
    </div>
  `;

  const reticle = document.createElement('div');
  reticle.className = 'reticle';
  reticle.style.display = 'none';
  // The label names what the reticle is currently over, so you know what you
  // are about to select before the dwell ring completes.
  reticle.innerHTML = '<i></i><b></b><s class="reticle-label"></s>';
  document.body.appendChild(reticle);

  return {
    deck: root,
    video: root.querySelector('video'),
    canvas: root.querySelector('canvas'),
    state: root.querySelector('.deck-state'),
    mode: root.querySelector('.deck-mode'),
    hint: root.querySelector('.deck-hint'),
    toggle: root.querySelector('.deck-toggle'),
    ar: root.querySelector('.deck-ar'),
    sens: root.querySelector('#deck-sens'),
    sensOut: root.querySelector('.deck-tune output'),
    room: root.querySelector('#deck-room'),
    roomOut: root.querySelector('.deck-room output'),
    reticle,
    reticleLabel: reticle.querySelector('.reticle-label'),
  };
}
