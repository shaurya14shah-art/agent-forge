/* ───────────────────────────────────────────────────────────────
   Renderer, camera, controls and the post stack that turns a plain
   WebGL render into a projected hologram: bloom, chromatic split,
   scanlines, a travelling scan sweep and a soft vignette.
   ─────────────────────────────────────────────────────────────── */

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Plane,
  Vector2,
  Vector3,
  Clock,
  ACESFilmicToneMapping,
  SRGBColorSpace,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Final grade: CRT scanlines, chromatic aberration, sweep, vignette, grain. */
const HoloGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uAberration: { value: 0.0012 },
    // Scanlines, grain and flicker are per-frame noise. Enough to read as a
    // projection, low enough that the image sits still — the previous levels
    // shimmered on every static frame, which reads as breakage, not atmosphere.
    uScanline: { value: 0.055 },
    uSweep: { value: 0.0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.012 },
    // Global luminance jitter. This is literally flicker — every pixel in the
    // frame changing brightness together at 24 Hz. There is no amount of it
    // that doesn't read as a fault, so it is off.
    uFlicker: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uScanline, uSweep, uVignette, uGrain, uFlicker;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // Barrel warp — a projected volume, not a flat screen
      uv = 0.5 + c * (1.0 + r2 * 0.045);

      // Chromatic split grows toward the edges
      vec2 dir = normalize(c + 1e-6) * uAberration * (0.25 + r2 * 2.4);
      float rc = texture2D(tDiffuse, uv + dir).r;
      float gc = texture2D(tDiffuse, uv).g;
      float bc = texture2D(tDiffuse, uv - dir).b;
      vec3 col = vec3(rc, gc, bc);

      // Scanlines. Sampled on the *unwarped* coordinate: taking them from the
      // barrel-warped uv makes the line spacing vary across the frame and
      // shimmer whenever the camera moves, because the warp resamples them.
      float lines = sin(vUv.y * uResolution.y * 1.35) * 0.5 + 0.5;
      col *= 1.0 - uScanline * lines;

      // Travelling scan sweep (fires on rebuild / analysis)
      float sweepY = fract(uSweep);
      float band = smoothstep(0.06, 0.0, abs(uv.y - sweepY));
      col += vec3(0.25, 0.75, 1.0) * band * step(0.001, uSweep) * 0.55;

      // Grain + tube flicker
      col += (rand(uv * uResolution + fract(uTime)) - 0.5) * uGrain;
      col *= 1.0 - uFlicker * (rand(vec2(floor(uTime * 24.0), 3.7)) - 0.5);

      // Vignette
      col *= mix(1.0, smoothstep(0.95, 0.15, r2 * 1.6), uVignette);

      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export function createStage({ glRoot }) {
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // Keeps the back buffer readable after the frame, so screen captures and
    // stills of the design are deterministic rather than timing-dependent.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x01050a, 1);
  renderer.toneMapping = ACESFilmicToneMapping;
  // Additive hologram layers routinely sum past 1.0 where a revolved shell
  // doubles back on itself. Exposure is the cheapest place to buy that
  // headroom back without flattening the Fresnel rim that carries the read.
  renderer.toneMappingExposure = 0.82;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.localClippingEnabled = true;
  glRoot.appendChild(renderer.domElement);

  const scene = new Scene();

  // One camera drives both renderers. It is deliberately NOT parented into
  // cssScene — WebGLRenderer only auto-updates a camera whose parent is null,
  // and dock panels are placed in world space instead (see core/hud3d.js).
  const camera = new PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 400);
  camera.position.set(3.8, 2.0, 4.4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.62;
  controls.zoomSpeed = 0.75;
  controls.panSpeed = 0.6;
  controls.minDistance = 0.7;
  controls.maxDistance = 22;
  controls.target.set(0, 0.34, 0);

  // Global cutaway plane (X > 0 half removed when active)
  const clipPlane = new Plane(new Vector3(-1, 0, 0), 0);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // The projection is now large in frame, so many more additive layers stack
  // per pixel. Bloom has to come down with it or the chamber clips to white.
  const bloom = new UnrealBloomPass(
    new Vector2(window.innerWidth, window.innerHeight),
    0.30, // strength
    0.62, // radius
    0.58  // threshold — only genuine highlights bloom
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(HoloGradeShader);
  grade.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  const clock = new Clock();

  /* ── Adaptive resolution ──────────────────────────────────────
     Bloom plus two full-screen shader passes at native retina density is
     the bulk of the frame cost. Rather than pick one pixel ratio for every
     machine, watch the frame time and move between these steps. Dropping
     resolution under load is far less visible than dropping frames.        */
  const QUALITY_STEPS = [1, 1.25, 1.5, 2];
  const maxStep = QUALITY_STEPS.findLastIndex((s) => s <= Math.min(window.devicePixelRatio, 2));
  let step = Math.max(0, maxStep);
  let slow = 0;
  let fast = 0;
  let settleUntil = 0;
  let floorStep = 0;   // ratchet: never climb back above a level that failed

  function applyPixelRatio() {
    renderer.setPixelRatio(QUALITY_STEPS[step]);
    resize();
    // A resize reallocates every render target — the frames either side of it
    // are meaningless, and reacting to them is how a tuner starts oscillating.
    settleUntil = performance.now() + 900;
    slow = 0;
    fast = 0;
  }
  renderer.setPixelRatio(QUALITY_STEPS[step]);

  /**
   * @param {number} dtMs measured frame time
   *
   * Resolution changes are visible, so this is deliberately reluctant: it
   * needs sustained evidence to move, ignores the settling period after a
   * change, and will not climb back past a level that has already proven too
   * slow. A tuner that hunts between two steps is worse than one that picks
   * the wrong step and stays there.
   */
  function tuneQuality(dtMs) {
    if (performance.now() < settleUntil) return;

    // 22 ms ≈ below 45 fps; 12 ms ≈ comfortably above 80.
    if (dtMs > 22) { slow++; fast = 0; } else if (dtMs < 12) { fast++; slow = 0; } else { slow = 0; fast = 0; }

    if (slow > 45 && step > 0) {
      floorStep = Math.max(floorStep, step);   // this level is now known-bad
      step--;
      applyPixelRatio();
    } else if (fast > 600 && step < maxStep && step + 1 < floorStep) {
      step++;
      applyPixelRatio();
    }
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    grade.uniforms.uResolution.value.set(w, h);
  }
  window.addEventListener('resize', resize);

  /** Trigger the one-shot scan sweep used on rebuild / analysis. */
  let sweepStart = -1;
  function pulseSweep() { sweepStart = clock.getElapsedTime(); }

  function updateSweep(t) {
    if (sweepStart < 0) { grade.uniforms.uSweep.value = 0; return; }
    const dt = (t - sweepStart) / 1.15;
    if (dt >= 1) { sweepStart = -1; grade.uniforms.uSweep.value = 0; return; }
    grade.uniforms.uSweep.value = 1 - dt;
  }

  /** Smoothly fly the camera to a preset. */
  let flight = null;
  function flyTo(position, target, duration = 0.9) {
    flight = {
      t: 0,
      duration,
      fromPos: camera.position.clone(),
      toPos: new Vector3().fromArray(position),
      fromTarget: controls.target.clone(),
      toTarget: target ? new Vector3().fromArray(target) : controls.target.clone(),
    };
  }

  function updateFlight(dt) {
    if (!flight) return;
    flight.t = Math.min(1, flight.t + dt / flight.duration);
    const e = flight.t < 0.5
      ? 4 * flight.t ** 3
      : 1 - Math.pow(-2 * flight.t + 2, 3) / 2; // easeInOutCubic
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    if (flight.t >= 1) flight = null;
  }

  return {
    renderer, scene, camera, controls,
    composer, bloom, grade, clock, clipPlane,
    resize, pulseSweep, updateSweep, flyTo, updateFlight, tuneQuality,
    isFlying: () => Boolean(flight),
    get pixelRatio() { return QUALITY_STEPS[step]; },
  };
}
