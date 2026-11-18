/* ───────────────────────────────────────────────────────────────
   AGENT FORGE — entry point.

   Wires the store, the procedural thruster, the holographic stage,
   the 3D panel HUD and the design agent into one loop.
   ─────────────────────────────────────────────────────────────── */

import * as THREE from 'three';
import { Group, Vector3, MathUtils } from 'three';

import { Store, VIEWS, PRESETS } from './state/store.js';
import { buildThruster } from './model/thruster.js';
import {
  analyseCustomPart,
  summariseCustom,
  resolveMount,
  normalisePart,
  defaultPart,
  MOUNTS,
} from './model/customPart.js';
import { FORMS } from './model/forms.js';
import { importModel, searchModels, resolveModel } from './model/importer.js';
import { solvePerformance, structuralCheck, coolingCheck, massEstimate, PROPELLANTS } from './model/physics.js';
import { createStage } from './core/scene.js';
import { createEnvironment } from './core/environment.js';
import { createHud } from './core/hud3d.js';
import { createInteraction } from './core/interaction.js';
import { createHandControl } from './core/hands.js';
import { tickMaterials, retint } from './core/holoMaterial.js';
import { createPanels } from './ui/panels.js';
import { createPartEditor } from './ui/partEditor.js';
import { createConsole } from './ui/console.js';
import { createSketchPad } from './ui/sketch.js';
import { createToolbox } from './ai/tools.js';
import { identifySketch } from './ai/agent.js';

/* Composition. The projection is the subject of the frame: it sits large and
   lifted clear of the instrument arc, the way the vehicles do in the
   reference, rather than sharing a band with the panels and competing. */
const DISPLAY_HEIGHT = 2.75;  // every design is projected at the same size
const DISPLAY_LIFT = 0.46;    // clear of the console and the arc
const PAD_Y = -1.62;

const THEMES = {
  cyan:  { color: 0x35c8ff, accent: 0xaff4ff },
  amber: { color: 0xffa93f, accent: 0xffe2b3 },
  ion:   { color: 0x9d6bff, accent: 0xddc9ff },
  alert: { color: 0xff5a48, accent: 0xffbcb0 },
};

/* ── Boot sequence ────────────────────────────────────────── */
const bootEl = document.getElementById('boot');
const bootBar = bootEl.querySelector('.boot-bar > i');

/** Covers the first geometry build and shader compile. No fake telemetry. */
function boot() {
  requestAnimationFrame(() => {
    bootBar.style.width = '100%';
    setTimeout(() => bootEl.classList.add('done'), 240);
  });
}

/* ── Stage ────────────────────────────────────────────────── */
const stage = createStage({ glRoot: document.getElementById('gl-root') });
const env = createEnvironment(stage.scene, { padY: PAD_Y, radius: 3.0 });
const hud = createHud({
  cssRoot: document.getElementById('css-root'),
  scene: stage.scene,
  camera: stage.camera,
});
const store = new Store();

/* ── Model holder: display scaling + gimbal pivot ─────────── */
const holder = new Group();
holder.name = 'holder';
stage.scene.add(holder);

const pivot = new Group();
pivot.name = 'gimbal-pivot';
holder.add(pivot);

let model = null;
let perf = null;
let checks = null;
let customById = {};
let displayScale = 1;

/**
 * Geometry rebuilds are coalesced to one per animation frame.
 *
 * A slider drag emits an `input` event far faster than a full rebuild takes
 * (13–90 ms of lathing geometry and compiling materials), so rebuilding
 * synchronously per event meant the drag was always racing a queue it could
 * never drain. Anything that needs to *read* the model calls `flushRebuild`
 * first, so deferring never hands back stale numbers.
 */
let rebuildQueued = false;

function requestRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    if (!rebuildQueued) return;
    rebuildQueued = false;
    rebuild();
  });
}

function flushRebuild() {
  if (!rebuildQueued) return;
  rebuildQueued = false;
  rebuild();
}

function rebuild() {
  const t0 = performance.now();

  if (model) {
    pivot.remove(model.group);
    model.dispose();
  }

  model = buildThruster(store.params, store.customParts);

  // Frame every design at the same projected size, whether it's an RCS
  // thruster or a booster engine — width matters as much as height once
  // the bell gets wide.
  const m = model.metrics;
  displayScale = Math.min(
    DISPLAY_HEIGHT / Math.max(0.05, m.envelopeHeight),
    (DISPLAY_HEIGHT * 0.62) / Math.max(0.05, m.envelopeRadius)
  );
  holder.scale.setScalar(displayScale);
  holder.position.y = -m.envelopeCenterY * displayScale + DISPLAY_LIFT;

  // Gimbal pivot sits at the flex-bearing plane.
  const pivotY = model.contour.yChamberEnd * 0.55;
  pivot.position.set(0, pivotY, 0);
  model.group.position.set(0, -pivotY, 0);
  pivot.add(model.group);

  // The light pool on the deck follows the hardware standing in it.
  env.setBounce(m.envelopeRadius * displayScale, 1);

  applyClipping();
  applyExplode(store.ui.explode);
  applyIsolate();
  applySelection();
  recompute();
  stage.pulseSweep();

  const ms = performance.now() - t0;
  const custom = store.customParts.length;
  document.getElementById('rail-assembly').textContent =
    `${store.params.bellType} · ${model.metrics.height.toFixed(2)} m · ` +
    `${10 + custom} parts${custom ? ` (${custom} custom)` : ''} · rebuilt in ${ms.toFixed(0)} ms`;
}

/* ── Analysis ─────────────────────────────────────────────── */
function solve(overrides = {}) {
  return solvePerformance({
    throatRadius: store.params.throatRadius,
    expansionRatio: store.params.expansionRatio,
    chamberPressure: store.params.chamberPressure,
    altitude: store.params.altitude,
    propellant: store.params.propellant,
    halfAngleExit: model?.contour?.thetaE ?? 9,
    cstarEff: 0.96,
    ...overrides,
  });
}

function recompute() {
  perf = solve();

  const cooling = coolingCheck({
    throatRadius: store.params.throatRadius,
    chamberPressure: store.params.chamberPressure,
    cstar: perf.cstar,
    channels: store.params.coolingChannels,
    mdotFuel: perf.mdotFuel,
    propellant: store.params.propellant,
    contourPoints: model.contour.all,
  });

  const structural = structuralCheck({
    chamberRadius: model.contour.Rc,
    wallThickness: model.metrics.wall,
    chamberPressure: store.params.chamberPressure,
    material: store.params.material,
    throatFlux: cooling.qThroatMW * 1e6,
    propellant: store.params.propellant,
  });

  const mass = massEstimate({
    profileArea: model.metrics.wettedArea,
    wallThickness: model.metrics.wall,
    material: store.params.material,
    extras: 0.22 * model.metrics.wettedArea * 90, // pumps, valves, jacket, gimbal
  });

  // Custom hardware is solved against the same operating point, then rolled
  // into the assembly totals — added mass moves thrust/weight, and its axial
  // station moves the centre of gravity.
  const ctx = { contour: model.contour, params: store.params, perf, cooling };
  const customStats = model.customDefs.map(({ def }) => analyseCustomPart(def, ctx));
  customById = Object.fromEntries(customStats.map((s) => [s.id, s]));
  const custom = summariseCustom(customStats, mass, model.metrics.centerY, perf.thrust);

  checks = { structural, cooling, mass, custom, customStats };
  panels.renderAnalysis(perf, checks, model.metrics, model.contour);
  panels.renderCustomParts(store.customParts, customById, editor.openId);
  editor.renderStats(editor.openId ? customById[editor.openId] : null);
  refreshInspector();
}

/* ── Display state ────────────────────────────────────────── */
const _off = new Vector3();

function applyExplode(t) {
  if (!model) return;
  const span = model.metrics.height;
  for (const [id, part] of Object.entries(model.parts)) {
    const cfg = part.userData.explode;
    if (!cfg) continue;
    const home = part.userData.home;

    if (cfg.radial) {
      let perChild = false;
      for (const child of part.children) {
        if (typeof child.userData.radialAngle === 'number') {
          perChild = true;
          const a = child.userData.radialAngle;
          if (!child.userData.home) child.userData.home = child.position.clone();
          child.position
            .copy(child.userData.home)
            .add(_off.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(cfg.dist * span * t));
        }
      }
      if (perChild) { part.position.copy(home); continue; }
    }

    part.position.copy(home).add(_off.copy(cfg.dir).multiplyScalar(cfg.dist * span * t));
    void id;
  }
}

function applyClipping() {
  if (!model) return;
  const planes = store.ui.cutaway ? [stage.clipPlane] : [];
  model.group.traverse((o) => {
    if (!o.material?.uniforms) return;
    const changed = (o.material.clippingPlanes?.length ?? 0) !== planes.length;
    o.material.clippingPlanes = planes;
    if (changed) o.material.needsUpdate = true;
  });
}

function applyIsolate() {
  if (!model) return;
  const sel = store.ui.selected;
  const on = store.ui.isolate && sel;
  for (const [id, part] of Object.entries(model.parts)) {
    part.traverse((o) => {
      const u = o.material?.uniforms;
      if (u?.uGhost) u.uGhost.value = on && id !== sel ? 1 : 0;
    });
  }
}

function applySelection() {
  if (!model) return;
  const sel = store.ui.selected;
  for (const [id, part] of Object.entries(model.parts)) {
    part.traverse((o) => {
      const u = o.material?.uniforms;
      if (u?.uSelected) u.uSelected.value = id === sel ? 1 : 0;
    });
  }
  if (sel && model.parts[sel]) {
    hud.anchorTo('inspect', model.parts[sel], new Vector3(0.95, 0.5, 0.4));
  }
  refreshInspector();
}

function inspectorRows(partId) {
  if (!model || !perf) return '';
  const m = model.metrics;
  const c = model.contour;
  const row = (k, v, state) =>
    `<div class="row"><span class="k">${k}</span><span class="v${state ? ` ${state}` : ''}">${v}</span></div>`;

  // Custom parts carry their own solved statistics.
  const stats = customById[partId];
  if (stats) {
    return (
      row('Mass', `${stats.mass.toFixed(2)}<span class="u">kg</span>`) +
      row('Material', stats.materialLabel) +
      row('Duty', stats.dutyLabel) +
      stats.rows.map((r) => row(r.k, r.v, r.state)).join('')
    );
  }

  switch (partId) {
    case 'throat':
      return (
        row('Diameter', `${(m.throatDiameter * 1000).toFixed(1)}<span class="u">mm</span>`) +
        row('Area', `${(perf.At * 1e4).toFixed(1)}<span class="u">cm²</span>`) +
        row('Heat flux', `${checks.cooling.qThroatMW.toFixed(1)}<span class="u">MW/m²</span>`) +
        row('Mass flow', `${perf.mdot.toFixed(1)}<span class="u">kg/s</span>`)
      );
    case 'nozzle':
      return (
        row('Expansion', `${perf.eps.toFixed(1)}:1`) +
        row('Exit dia.', `${m.exitDiameter.toFixed(3)}<span class="u">m</span>`) +
        row('Initial angle', `${c.thetaN.toFixed(1)}°`) +
        row('Exit angle', `${c.thetaE.toFixed(1)}°`) +
        row('Bell length', `${c.bellLength.toFixed(3)}<span class="u">m</span>`) +
        row('Divergence loss', `${((1 - perf.lambda) * 100).toFixed(2)}<span class="u">%</span>`)
      );
    case 'chamber':
      return (
        row('Diameter', `${m.chamberDiameter.toFixed(3)}<span class="u">m</span>`) +
        row('Pressure', `${(store.params.chamberPressure / 1e6).toFixed(1)}<span class="u">MPa</span>`) +
        row('Temperature', `${perf.Tc.toFixed(0)}<span class="u">K</span>`) +
        row('Jacket hoop', `${checks.structural.hoopStressMPa.toFixed(0)}<span class="u">MPa</span>`) +
        row('Margin', `${checks.structural.margin.toFixed(2)}×`) +
        row('Hot wall', `${checks.structural.linerTempK.toFixed(0)}<span class="u">K</span>`)
      );
    case 'injector':
      return (
        row('Propellant', PROPELLANTS[store.params.propellant].label) +
        row('O/F ratio', perf.ofRatio.toFixed(2)) +
        row('Ox flow', `${perf.mdotOx.toFixed(1)}<span class="u">kg/s</span>`) +
        row('Fuel flow', `${perf.mdotFuel.toFixed(1)}<span class="u">kg/s</span>`)
      );
    case 'cooling':
      return (
        row('Channels', String(store.params.coolingChannels)) +
        row('Coolant', `${perf.mdotFuel.toFixed(1)}<span class="u">kg/s</span>`) +
        row('Heat load', `${checks.cooling.heatLoadMW.toFixed(1)}<span class="u">MW</span>`) +
        row('Capacity used', `${(checks.cooling.utilisation * 100).toFixed(0)}<span class="u">%</span>`)
      );
    case 'gimbal':
      return row('Deflection', `${store.params.gimbalAngle.toFixed(2)}°`) + row('Authority', '±8°');
    case 'turbopump':
      return (
        row('Discharge', `${((store.params.chamberPressure * 1.35) / 1e6).toFixed(1)}<span class="u">MPa</span>`) +
        row('Total flow', `${perf.mdot.toFixed(1)}<span class="u">kg/s</span>`) +
        row('Pump power', `${((perf.mdot * store.params.chamberPressure * 1.35) / (PROPELLANTS[store.params.propellant].rhoBulk * 0.72) / 1e6).toFixed(2)}<span class="u">MW</span>`)
      );
    default:
      return row('Overall length', `${m.height.toFixed(3)}<span class="u">m</span>`);
  }
}

function refreshInspector() {
  const sel = store.ui.selected;
  panels.renderInspector(sel, {
    info: sel ? model?.partInfo?.[sel] : null,
    rows: sel ? inspectorRows(sel) : '',
    annotation: sel ? store.ui.annotations[sel] : null,
  });
  // The inspector re-shows itself on every selection change, so focus mode
  // has to reassert itself here rather than only on the toggle.
  if (store.ui.focus !== 'full') hud.show('inspect', false);
}

/* ── Static fire ──────────────────────────────────────────── */
let burn = null;

function fire(seconds = 6) {
  burn = { t: 0, duration: Math.min(20, Math.max(1, seconds)), level: 0 };
  store.setUi('firing', true);
}

function updateBurn(dt) {
  if (!burn) {
    if (model?.plume?.visible) {
      model.plumeMat.uniforms.uThrottle.value *= 0.86;
      if (model.plumeMat.uniforms.uThrottle.value < 0.01) model.plume.visible = false;
    }
    return;
  }
  burn.t += dt;
  const target = Math.max(0.05, store.params.throttle || 1);
  const ramp = Math.min(1, burn.t / 0.7);
  const tail = Math.min(1, Math.max(0, (burn.duration - burn.t) / 0.6));
  burn.level = target * ramp * tail;

  if (model) {
    model.plume.visible = true;
    model.plumeMat.uniforms.uThrottle.value = burn.level;
    model.plumeMat.uniforms.uDiamonds.value = perf?.overExpanded ? 1.6 : 0.9;

    // Throat glows, chamber follows
    for (const id of ['throat', 'nozzle', 'chamber', 'injector']) {
      const part = model.parts[id];
      if (!part) continue;
      const heat = burn.level * (id === 'throat' ? 1 : id === 'chamber' ? 0.7 : 0.45);
      part.traverse((o) => {
        const u = o.material?.uniforms;
        if (u?.uHeat) u.uHeat.value = heat;
      });
    }
    // Rumble
    const shake = burn.level * 0.006 * (perf?.separated ? 3.2 : 1);
    holder.position.x = (Math.random() - 0.5) * shake;
    holder.position.z = (Math.random() - 0.5) * shake;
  }

  if (burn.t >= burn.duration) {
    burn = null;
    store.setUi('firing', false);
    holder.position.x = 0;
    holder.position.z = 0;
    if (model) {
      for (const part of Object.values(model.parts)) {
        part.traverse((o) => {
          const u = o.material?.uniforms;
          if (u?.uHeat) u.uHeat.value = 0;
        });
      }
    }
  }
}

/* ── Panels, interaction, agent ───────────────────────────── */
const panels = createPanels({
  hud,
  store,
  onPreset: (name) => {
    store.applyPreset(name);
    forge.log?.sys(`Loaded preset: ${PRESETS[name].label} — ${PRESETS[name].note}`);
  },
  onFire: () => fire(6),
  onView: (v) => setView(v),
  onNewPart: () => newPart({}, { announce: true }),
  onEditPart: (id) => editor.open(id),
});

const editor = createPartEditor({
  hud,
  store,
  // The mount's reference radius is what relative sizing multiplies against,
  // so converting between sizing modes has to read it from the live contour.
  getMountRadius: (def) => (flushRebuild(), resolveMount(def.mount, model.contour).radius),
  getStats: (id) => (flushRebuild(), customById[id] ?? null),
  onSelect: (id) => interaction.select(id),
});

/**
 * Author a new part and open it for editing.
 *
 * Only the operator-initiated path announces itself. A part created through
 * the agent's create_part tool already gets a summary line describing its
 * final configuration, and this one would describe the blank it started from.
 */
function newPart(seed = {}, { announce = false } = {}) {
  const def = normalisePart({ ...defaultPart(), ...seed });
  store.addCustomPart(def);
  editor.open(def.id);
  if (announce) {
    forge.log?.sys(
      `New part: ${FORMS[def.form].label} at the ${MOUNTS[def.mount].label.toLowerCase()}. Set it up in the editor.`
    );
  }
  return def;
}

const interaction = createInteraction({
  renderer: stage.renderer,
  camera: stage.camera,
  controls: stage.controls,
  store,
  getModel: () => model,
  hud,
});

function setView(name) {
  const v = VIEWS[name];
  if (!v) return;
  stage.flyTo(v.pos, [0, 0.34, 0], 0.95);
}

/* ── Reference geometry ───────────────────────────────────────────
   Imported meshes live in their own group beside the projection. They
   are never part of `model.parts`, so they cannot be selected into the
   inspector, cannot be exploded, and — the point — never reach the mass,
   CG or margin numbers. An imported mesh has no wall thickness and no
   duty; pretending otherwise would quietly corrupt the analysis.        */
const referenceRoot = new Group();
referenceRoot.name = 'reference';
stage.scene.add(referenceRoot);

const references = new Map();   // id -> { group, stats, dispose, meta }
let referenceSeq = 0;

async function loadReference(url, meta = {}) {
  const id = meta.id ?? `ref${++referenceSeq}`;
  const t0 = performance.now();
  const imported = await importModel(url, { size: meta.size ?? 1.7, include: meta.include });

  removeReference(id);

  // Stand it on the deck behind the projection, not in front of it. Lanes
  // are explicit rather than computed from an angle: the near-camera arc is
  // exactly where the panels are, so anything placed there is invisible.
  const LANES = [
    [-3.1, -1.3], [3.1, -1.3],
    [-2.0, -3.6], [2.0, -3.6],
    [0, -4.4],
  ];
  const size = meta.size ?? 1.7;
  const [lx, lz] = LANES[references.size % LANES.length];
  imported.group.position.set(lx, PAD_Y + size * 0.5, lz);
  imported.group.userData.noPick = true;
  imported.group.traverse((o) => { o.userData.noPick = true; });

  referenceRoot.add(imported.group);
  references.set(id, { ...imported, meta: { ...meta, id, url } });

  const ms = performance.now() - t0;
  forge.log?.sys(
    `Loaded ${meta.name ?? 'reference model'} — ${imported.stats.triangles.toLocaleString()} triangles, ${ms.toFixed(0)} ms.` +
      (meta.license ? ` ${meta.license}${meta.author ? `, ${meta.author}` : ''}.` : '') +
      ' Reference geometry only: not analysed, not massed.'
  );
  return { id, stats: imported.stats };
}

function removeReference(id) {
  const existing = references.get(id);
  if (!existing) return false;
  referenceRoot.remove(existing.group);
  existing.dispose();
  references.delete(id);
  return true;
}

function clearReferences() {
  const n = references.size;
  for (const id of [...references.keys()]) removeReference(id);
  return n;
}

/* ── Focus mode ───────────────────────────────────────────────────
   How much interface is in the way, in three steps. `full` is the
   workbench; `clear` keeps the console and the status rail so you can
   still talk to the agent while looking at bare hardware; `bare` is the
   projection alone.

   This is a display state, not a design state — it never touches the
   model or the solve, so entering and leaving it is always free.        */
const FOCUS_MODES = ['full', 'clear', 'bare'];
const FOCUS_LABEL = {
  full: 'all panels',
  clear: 'console only',
  bare: 'projection only',
};

const focusExit = document.getElementById('focus-exit');
focusExit.addEventListener('click', () => setFocus('full'));

function setFocus(mode) {
  const next = FOCUS_MODES.includes(mode) ? mode : 'full';
  document.body.dataset.focus = next;
  focusExit.style.pointerEvents = next === 'full' ? 'none' : 'auto';
  store.setUi('focus', next);
  // The inspector is world-anchored, so it has to be told rather than
  // hidden by a class — it re-shows itself whenever selection changes.
  hud.show('inspect', next === 'full' && Boolean(store.ui.selected));
  return next;
}

function cycleFocus(dir = 1) {
  const i = FOCUS_MODES.indexOf(store.ui.focus ?? 'full');
  const next = FOCUS_MODES[(i + dir + FOCUS_MODES.length) % FOCUS_MODES.length];
  setFocus(next);
  forge.log?.sys(`Display: ${FOCUS_LABEL[next]}.`);
  return next;
}

function setTheme(theme) {
  const t = THEMES[theme] || THEMES.cyan;
  document.body.dataset.theme = theme === 'cyan' ? '' : theme;
  retint(t.color, t.accent);
  store.setUi('theme', theme);
}

// Every accessor flushes first: a deferred rebuild must never be observable
// as stale geometry or stale numbers to a tool, the editor, or the panels.
const app = {
  getPerformance: () => (flushRebuild(), perf),
  getChecks: () => (flushRebuild(), checks),
  getMetrics: () => (flushRebuild(), model.metrics),
  getContour: () => (flushRebuild(), model.contour),
  solveAt: (o) => (flushRebuild(), solve(o)),
  setView,
  selectPart: (id) => interaction.select(id),
  refreshInspector,
  fire,
  setTheme,

  // Custom parts — the same surface the editor drives, so the agent and the
  // operator are genuinely working the same controls.
  getPartIds: () => (flushRebuild(), Object.keys(model.parts)),
  partLabel: (id) => model?.partInfo?.[id]?.label ?? id,
  getCustomStats: (id) => (flushRebuild(), id ? customById[id] ?? null : customById),
  getMountRadius: (mountId) => (flushRebuild(), resolveMount(mountId, model.contour).radius),
  createPart: (seed) => newPart(seed),
  openPartEditor: (id) => editor.open(id),
  closePartEditor: () => editor.close(),

  setFocus,
  cycleFocus,
  focusModes: FOCUS_MODES,
  focusLabel: (m) => FOCUS_LABEL[m],

  // Reference geometry
  searchModels,
  resolveModel,
  loadReference,
  removeReference,
  clearReferences,
  listReferences: () => [...references.values()].map((r) => ({ ...r.meta, ...r.stats })),

  resetPanelLayout: () => hud.resetLayout(),
  setRoomGrade: (g) => env.setRoomGrade(g),
  getRoomGrade: () => env.getRoomGrade(),
};

const toolbox = createToolbox({ store, app });
const forge = createConsole({ hud, store, app, toolbox });

const sketch = createSketchPad({
  hud,
  app,
  log: forge.log,
  isAgentReady: () => forge.ready,
  identify: identifySketch,
});

// Webcam gesture control — opt-in, starts only when the operator asks.
const hands = createHandControl({
  root: document.getElementById('hand-deck'),
  overlay: document.getElementById('hand-overlay'),
  stage,
  env,
  store,
  interaction,
  log: (msg, kind) => (kind === 'err' ? forge.log.err(msg) : forge.log.sys(msg)),
  // Selecting by pointing is only half of it — say what was locked on, so the
  // operator knows they can now talk about "this".
  onSelect: (id) => forge.log.sys(`Locked on ${app.partLabel(id)}. Say "this" to act on it.`),
});

/* ── Store wiring ─────────────────────────────────────────── */
store.on('param', ({ rebuild: needsRebuild }) => {
  if (needsRebuild) requestRebuild();
  else recompute();
  panels.syncParams();
});

// Authoring a part changes geometry, so it takes the same path a geometry
// slider does. `recompute` inside `rebuild` refreshes the list and the editor.
store.on('parts', ({ action, id }) => {
  requestRebuild();
  editor.sync();
  if (action === 'remove' && editor.openId === id) editor.close();
  if (action === 'undo' && editor.openId && !store.getCustomPart(editor.openId)) editor.close();
});

store.on('ui', ({ key, value }) => {
  switch (key) {
    case 'explode':
      applyExplode(value);
      // A dispersed assembly casts a weaker, wider pool.
      if (model) {
        env.setBounce(
          model.metrics.envelopeRadius * displayScale * (1 + value * 0.9),
          1 - value * 0.45
        );
      }
      break;
    case 'cutaway': applyClipping(); break;
    case 'isolate': applyIsolate(); break;
    case 'grid': env.setGridVisible(value); break;
    case 'selected': applySelection(); applyIsolate(); break;
    default: break;
  }
  panels.syncUi();
  const mode = store.ui.firing
    ? 'static fire'
    : store.ui.cutaway
    ? 'section'
    : store.ui.isolate
    ? 'isolated'
    : store.ui.explode > 0.02
    ? `exploded ${(store.ui.explode * 100).toFixed(0)}%`
    : 'assembled';
  document.getElementById('rail-mode').textContent = mode;
});

/* ── Keyboard ─────────────────────────────────────────────── */

/**
 * The X-key toggle eases the exploded view rather than snapping it. It is a
 * one-shot animation, not a persistent target: any other source (slider, AI
 * tool, gesture) writing to `explode` cancels it, so they never fight.
 */
let explodeAnim = null;
let explodeAnimWriting = false;

store.on('ui', ({ key }) => {
  if (key === 'explode' && !explodeAnimWriting) explodeAnim = null;
});

window.addEventListener('keydown', (e) => {
  // Shortcuts are single letters, so any text field — the console, or the
  // part name in the editor — has to swallow them first.
  const focused = document.activeElement;
  const typing =
    focused?.tagName === 'TEXTAREA' ||
    (focused?.tagName === 'INPUT' && focused.type !== 'range');
  if (forge.isFocused() || typing) return;
  if (e.metaKey && !e.ctrlKey && e.key !== 'z') return;

  switch (e.key.toLowerCase()) {
    case 'x':
      explodeAnim = { target: store.ui.explode > 0.5 ? 0 : 1 };
      break;
    case 'c':
      store.setUi('cutaway', !store.ui.cutaway);
      break;
    case 'i':
      store.setUi('isolate', !store.ui.isolate);
      break;
    case 'g':
      store.setUi('grid', !store.ui.grid);
      break;
    case 'h':
      hands.toggle();
      break;
    case 'f':
      setView('iso');
      break;
    case 'n':
      newPart({}, { announce: true });
      break;
    case 'd':
      sketch.toggle();
      break;
    case 'tab':
      e.preventDefault();
      cycleFocus(e.shiftKey ? -1 : 1);
      break;
    case 'escape':
      // Innermost first: the editor, then the selection, then back out of
      // focus mode. Escape should always feel like exactly one step back.
      if (sketch.isOpen()) sketch.close();
      else if (editor.isOpen()) editor.close();
      else if (store.ui.selected) interaction.select(null);
      else if (store.ui.focus !== 'full') setFocus('full');
      break;
    case ' ':
      e.preventDefault();
      fire(6);
      break;
    case '/':
      e.preventDefault();
      forge.focus();
      break;
    case 'z':
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); store.undo(); }
      break;
    case '1': setView('iso'); break;
    case '2': setView('front'); break;
    case '3': setView('side'); break;
    case '4': setView('top'); break;
    case '5': setView('nozzle'); break;
    case '6': setView('injector'); break;
    default: break;
  }
});

/* ── Boot + loop ──────────────────────────────────────────── */
rebuild();
panels.syncParams();
panels.syncUi();
env.setGridVisible(store.ui.grid);
setTheme('cyan');
setFocus('full');
hud.layout();
requestAnimationFrame(() => hud.layout());
boot();

let last = performance.now();

// Any camera movement — mouse, gesture or a view preset — parks the idle drift.
let lastInteractionAt = performance.now();
stage.controls.addEventListener('change', () => { lastInteractionAt = performance.now(); });

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  const frameMs = now - last;
  const dt = Math.min(0.05, frameMs / 1000);
  last = now;
  const t = stage.clock.getElapsedTime();

  // Trade resolution for frame rate before dropping frames.
  stage.tuneQuality(frameMs);

  if (explodeAnim) {
    const next = MathUtils.lerp(store.ui.explode, explodeAnim.target, 1 - Math.pow(0.0015, dt));
    const done = Math.abs(next - explodeAnim.target) < 0.004;
    explodeAnimWriting = true;
    store.setUi('explode', done ? explodeAnim.target : next);
    explodeAnimWriting = false;
    if (done) explodeAnim = null;
  }

  // Gimbal deflection, eased
  pivot.rotation.z = MathUtils.lerp(
    pivot.rotation.z,
    MathUtils.degToRad(-store.params.gimbalAngle),
    1 - Math.pow(0.0001, dt)
  );

  // Idle drift so the projection never looks frozen — but it has to yield to
  // the operator. Drifting under a hand that is trying to hold a part steady
  // is the difference between "alive" and "won't sit still".
  const idleFor = (now - lastInteractionAt) / 1000;
  if (!stage.isFlying() && idleFor > 2.2) {
    const ease = Math.min(1, (idleFor - 2.2) / 1.4);
    holder.rotation.y += dt * 0.045 * ease;
  }

  hands.update(now);
  updateBurn(dt);
  tickMaterials(t);
  env.update(t, dt);
  hud.update(t);
  stage.updateFlight(dt);
  stage.updateSweep(t);
  stage.grade.uniforms.uTime.value = t;
  stage.controls.update();

  stage.composer.render();
}

frame();

// requestAnimationFrame is throttled to a stop while the tab is hidden, which
// can leave a stale frame on screen when it comes back. Render once on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  last = performance.now();
  hud.update(stage.clock.getElapsedTime());
  stage.controls.update();
  stage.composer.render();
});

// Handy for poking at the design from the devtools console.
window.FORGE = { store, app, toolbox, stage, env, hud, hands, THREE, get model() { return model; } };
