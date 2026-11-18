/* ───────────────────────────────────────────────────────────────
   Custom parts: definition → hardware → statistics.

   A definition is small and declarative:

     { form, mount, sizing, dims, material, duty, ... }

   Everything else is derived. The mount resolves against the *live*
   contour every rebuild, and in relative sizing every length is a
   multiple of that mount's reference radius — so a flange authored at
   1.06 × chamber radius is still a flange after the throat radius
   changes and the whole engine re-scales underneath it.

   The statistics are solved from the same physics the stock engine
   uses. A custom part is not annotation: it has mass that moves the
   thrust-to-weight ratio, it shifts the centre of gravity, and it can
   fail its own duty check.
   ─────────────────────────────────────────────────────────────── */

import { Group, Vector3 } from 'three';

import { FORMS, DUTIES, DUTY_PARAMS } from './forms.js';
import {
  MATERIALS,
  PROPELLANTS,
  radiativeEquilibrium,
} from './physics.js';

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);

/* ── Mounts ────────────────────────────────────────────────────
   Reference frames on the engine. Each returns the axial station and
   the reference radius that relative sizing multiplies against.      */

export const MOUNTS = {
  injector: {
    label: 'Injector plane',
    hint: 'Top of the dome',
    at: (c) => ({ y: c.yInjector, radius: c.Rc }),
    explode: { dir: UP.clone(), dist: 0.7 },
  },
  pump: {
    label: 'Pump deck',
    hint: 'Above the injector, with the turbomachinery',
    at: (c) => ({ y: c.yInjector + c.Rc * 1.15, radius: c.Rc * 0.6 }),
    explode: { dir: new Vector3(0.25, 1, 0).normalize(), dist: 1.0 },
  },
  chamber: {
    label: 'Chamber wall',
    hint: 'Mid-barrel, at the chamber radius',
    at: (c) => ({ y: (c.yChamberStart + c.yChamberEnd) / 2, radius: c.Rc }),
    explode: { dir: new Vector3(1, 0, 0), dist: 0.4, radial: true },
  },
  throat: {
    label: 'Throat plane',
    hint: 'The station everything else is measured from',
    at: (c) => ({ y: 0, radius: c.Rt }),
    explode: { dir: new Vector3(1, 0, 0), dist: 0.45, radial: true },
  },
  bell: {
    label: 'Bell mid-span',
    hint: 'Halfway down the divergent section',
    at: (c) => ({ y: c.yExit * 0.45, radius: (c.Rt + c.Re) / 2 }),
    explode: { dir: new Vector3(1, -0.3, 0).normalize(), dist: 0.5, radial: true },
  },
  exit: {
    label: 'Exit plane',
    hint: 'The nozzle lip',
    at: (c) => ({ y: c.yExit, radius: c.Re }),
    explode: { dir: DOWN.clone(), dist: 0.62 },
  },
  origin: {
    label: 'Free / centreline',
    hint: 'Unattached — position it yourself',
    at: (c) => ({ y: 0, radius: c.Rc }),
    explode: { dir: new Vector3(1, 0.2, 0).normalize(), dist: 0.5, radial: true },
  },
};

export const MOUNT_IDS = Object.keys(MOUNTS);

/** Axial station + reference radius of a mount on the current contour. */
export function resolveMount(mountId, contour) {
  const mount = MOUNTS[mountId] ?? MOUNTS.chamber;
  const { y, radius } = mount.at(contour);
  return {
    id: MOUNTS[mountId] ? mountId : 'chamber',
    label: mount.label,
    y,
    radius: Math.max(1e-4, radius),
    explode: mount.explode,
  };
}

/* ── Definitions ───────────────────────────────────────────────── */

export const OFFSET_SPEC = { abs: [-1.5, 1.5], rel: [-5, 5] };

let seq = 0;

/**
 * A complete, legal definition for a freshly created part.
 *
 * Each form declares where it belongs and what it is usually made of, so
 * a new bladed disc lands on the pump deck in Inconel and a new vane set
 * lands at the exit in niobium. A part that opens already outside its own
 * margin reads as broken tooling, not as an interesting design problem.
 */
export function defaultPart(formId = 'ring', mountId = null) {
  const form = FORMS[formId] ?? FORMS.ring;
  const id = `cp${++seq}`;
  const def = {
    id,
    name: form.label,
    form: FORMS[formId] ? formId : 'ring',
    mount: MOUNTS[mountId] ? mountId : form.mount ?? 'chamber',
    sizing: 'relative',
    offsetY: 0,
    rotation: 0,
    material: form.material ?? 'inconel718',
    duty: form.duty,
    // Hot-gas hardware in a liquid engine is normally cooled; radiative
    // equilibrium is the deliberate choice, not the default.
    cooled: form.duty === 'hotgas',
    dims: {},
  };
  def.dims = defaultDims(def.form, def.sizing);
  applyDutyDefaults(def);
  return def;
}

/** Default dimensions for a form, in whichever sizing mode is active. */
export function defaultDims(formId, sizing) {
  const form = FORMS[formId] ?? FORMS.ring;
  const dims = {};
  for (const [key, spec] of Object.entries(form.params)) {
    dims[key] = spec.kind === 'len' ? (sizing === 'relative' ? spec.relDef : spec.def) : spec.def;
  }
  return dims;
}

/** Slider bounds for one parameter under the active sizing mode. */
export function paramRange(spec, sizing) {
  if (spec.kind !== 'len') return { min: spec.min, max: spec.max, step: spec.step ?? 1 };
  const [min, max] = sizing === 'relative' ? spec.rel : spec.abs;
  return { min, max, step: sizing === 'relative' ? 0.005 : 0.0005 };
}

function applyDutyDefaults(def) {
  for (const [key, spec] of Object.entries(DUTY_PARAMS[def.duty] ?? {})) {
    if (typeof def[key] !== 'number') def[key] = spec.def;
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Fill in anything missing and clamp everything into range. Every path
 * that mutates a part — editor, AI tool, undo — goes through here, so a
 * malformed definition can never reach the geometry builder.
 */
export function normalisePart(raw, previous = null) {
  const base = previous ? { ...previous } : defaultPart();
  const def = { ...base, ...raw };

  // `{...raw}` with an explicit `id: undefined` is how a duplicate asks for a
  // fresh identity; anything else keeps the one it came in with.
  def.id = def.id || defaultPart().id;
  def.form = FORMS[def.form] ? def.form : base.form;
  def.mount = MOUNTS[def.mount] ? def.mount : base.mount;
  def.sizing = def.sizing === 'absolute' ? 'absolute' : 'relative';
  def.material = MATERIALS[def.material] ? def.material : 'inconel718';
  def.duty = DUTIES[def.duty] ? def.duty : FORMS[def.form].duty;
  def.cooled = Boolean(def.cooled);
  def.name = String(def.name ?? FORMS[def.form].label).slice(0, 40) || FORMS[def.form].label;

  // A name the operator never touched should follow the form, so switching a
  // ring to a truss doesn't leave a strut ring labelled "Ring / flange". Still
  // carrying the old form's label is the evidence it was never customised — a
  // name they actually typed is theirs and survives everything.
  if (def.form !== base.form && def.name === FORMS[base.form]?.label) {
    def.name = FORMS[def.form].label;
  }

  const offsetRange = def.sizing === 'relative' ? OFFSET_SPEC.rel : OFFSET_SPEC.abs;
  def.offsetY = clamp(Number(def.offsetY) || 0, offsetRange[0], offsetRange[1]);
  def.rotation = clamp(Number(def.rotation) || 0, -180, 180);

  // Dimensions are per-form: switching form starts from that form's defaults
  // and keeps any same-named value the caller supplied.
  const form = FORMS[def.form];
  const fallback = defaultDims(def.form, def.sizing);
  const dims = {};
  for (const [key, spec] of Object.entries(form.params)) {
    const supplied = raw?.dims?.[key] ?? (base.form === def.form ? base.dims?.[key] : undefined);
    const n = Number(supplied);
    const r = paramRange(spec, def.sizing);
    dims[key] = Number.isFinite(n) ? clamp(n, r.min, r.max) : fallback[key];
    if (spec.kind === 'count') dims[key] = Math.round(dims[key]);
  }
  def.dims = dims;

  applyDutyDefaults(def);
  for (const [key, spec] of Object.entries(DUTY_PARAMS[def.duty] ?? {})) {
    const n = Number(def[key]);
    def[key] = clamp(Number.isFinite(n) ? n : spec.def, spec.min, spec.max);
  }
  return def;
}

/**
 * Convert between sizing modes without moving the hardware: an absolute
 * 220 mm ring on a 210 mm chamber becomes a 1.048 × ring, and back.
 */
export function convertSizing(def, sizing, mountRadius) {
  if (def.sizing === sizing) return def;
  const form = FORMS[def.form];
  const factor = sizing === 'relative' ? 1 / Math.max(1e-6, mountRadius) : mountRadius;
  const dims = { ...def.dims };
  for (const [key, spec] of Object.entries(form.params)) {
    if (spec.kind === 'len') dims[key] = dims[key] * factor;
  }
  return normalisePart({ ...def, sizing, dims, offsetY: def.offsetY * factor }, def);
}

/** Dimensions in metres, whichever mode the definition is authored in. */
export function resolveDims(def, mountRadius) {
  const form = FORMS[def.form];
  const out = {};
  for (const [key, spec] of Object.entries(form.params)) {
    const v = def.dims[key];
    out[key] = spec.kind === 'len' && def.sizing === 'relative' ? v * mountRadius : v;
  }
  return out;
}

/* ── Geometry ──────────────────────────────────────────────────── */

/**
 * @returns {{group: Group, explode: object, dims: object, mount: object}}
 */
export function buildCustomPart(def, contour) {
  const mount = resolveMount(def.mount, contour);
  const dims = resolveDims(def, mount.radius);
  const form = FORMS[def.form];

  const group = new Group();
  group.userData.geometries = [];
  try {
    form.build(dims, group);
  } catch (err) {
    console.error(`[customPart] "${def.name}" failed to build`, err);
  }

  const offset = def.sizing === 'relative' ? def.offsetY * mount.radius : def.offsetY;
  group.position.y = mount.y + offset;
  group.rotation.y = (def.rotation * Math.PI) / 180;

  return { group, explode: { ...mount.explode }, dims, mount, y: group.position.y };
}

/* ── Statistics ────────────────────────────────────────────────── */

const row = (k, v, state) => ({ k, v, state });

/**
 * Solve a custom part against the live operating point.
 *
 * @param {object} def       the definition
 * @param {object} ctx       { contour, params, perf, cooling }
 */
export function analyseCustomPart(def, ctx) {
  const { contour, params, perf, cooling } = ctx;
  const form = FORMS[def.form];
  const mount = resolveMount(def.mount, contour);
  const dims = resolveDims(def, mount.radius);
  const m = form.measure(dims);
  const mat = MATERIALS[def.material];

  const mass = m.volume * mat.rho;
  const offset = def.sizing === 'relative' ? def.offsetY * mount.radius : def.offsetY;
  const y = mount.y + offset;

  const base = {
    id: def.id,
    name: def.name,
    form: def.form,
    formLabel: form.label,
    duty: def.duty,
    dutyLabel: DUTIES[def.duty].label,
    material: def.material,
    materialLabel: mat.label,
    mountLabel: mount.label,
    mass,
    volume: m.volume,
    area: m.area,
    tipRadius: m.tipRadius,
    span: m.span,
    y,
    dims,
    rows: [],
    meter: null,
    state: 'none',
    headline: `${mass.toFixed(1)} kg`,
    note: null,
  };

  switch (def.duty) {
    case 'structure':  return dutyStructure(base, def, m, mat, perf);
    case 'pressure':   return dutyPressure(base, def, m, mat, params);
    case 'hotgas':     return dutyHotGas(base, def, m, mat, contour, cooling, params, mount);
    case 'rotating':   return dutyRotating(base, def, m, mat);
    case 'plumbing':   return dutyPlumbing(base, def, m, params, perf);
    default:
      base.rows = [
        row('Material volume', `${(m.volume * 1e6).toFixed(0)} cm³`),
        row('Exposed area', `${m.area.toFixed(3)} m²`),
      ];
      base.headline = `${mass.toFixed(1)} kg inert`;
      return base;
  }
}

function verdict(margin) {
  return margin >= 1.5 ? 'ok' : margin >= 1 ? 'warn' : 'bad';
}

/**
 * Materials that would actually survive this temperature. Advice that
 * recommends the alloy the part is already made of is worse than none.
 */
function hotterThan(current, temp) {
  const limit = MATERIALS[current]?.tMax ?? 0;
  return Object.entries(MATERIALS)
    .filter(([id, m]) => id !== current && m.tMax > limit && m.tMax >= temp)
    .sort((a, b) => a[1].tMax - b[1].tMax)
    .map(([, m]) => m.label);
}

function dutyStructure(base, def, m, mat, perf) {
  const load = perf.thrust * def.loadShare;
  const stress = m.section > 0 ? load / m.section : Infinity;
  const yieldMargin = mat.sigmaY / stress;

  base.rows = [
    row('Axial load', `${(load / 1000).toFixed(1)} kN`),
    row('Load section', `${(m.section * 1e4).toFixed(1)} cm²`),
    row('Compressive stress', `${(stress / 1e6).toFixed(0)} MPa`),
    row('Yield margin', `${yieldMargin.toFixed(2)}×`, verdict(yieldMargin)),
  ];

  let governing = yieldMargin;
  let mode = 'yield';

  if (m.struts) {
    // Thin-walled tube: I ≈ π r³ t. Pinned ends, so K = 1.
    const s = m.struts;
    const I = Math.PI * Math.pow(s.radius, 3) * s.wall;
    const pcr = (Math.PI * Math.PI * mat.E * I) / (s.length * s.length);
    const perStrut = s.count > 0 && s.cos > 0 ? load / (s.count * s.cos) : Infinity;
    const bucklingMargin = perStrut > 0 ? pcr / perStrut : Infinity;

    base.rows.push(
      row('Load per strut', `${(perStrut / 1000).toFixed(1)} kN`),
      row('Euler critical', `${(pcr / 1000).toFixed(1)} kN`),
      row('Buckling margin', `${bucklingMargin.toFixed(2)}×`, verdict(bucklingMargin))
    );
    if (bucklingMargin < yieldMargin) { governing = bucklingMargin; mode = 'buckling'; }
  }

  base.state = verdict(governing);
  base.headline = `${base.mass.toFixed(1)} kg · ${governing.toFixed(2)}× on ${mode}`;
  base.meter = {
    label: `${mode === 'buckling' ? 'Buckling' : 'Compressive'} load`,
    ratio: 1 / Math.max(0.01, governing),
    text: `${governing.toFixed(2)}× margin`,
    threshold: 1 / 1.5,
    state: base.state,
  };
  if (governing < 1.5) {
    base.note = mode === 'buckling'
      ? 'Buckling governs — a bigger strut diameter buys margin far faster than a thicker wall, because I goes as r³.'
      : 'Increase the load-bearing section or move to a higher-yield alloy.';
  }
  return base;
}

function dutyPressure(base, def, m, mat, params) {
  const p = params.chamberPressure * def.pressureFraction;
  const hoop = m.boreWall > 0 ? (m.boreFactor * p * m.boreRadius) / m.boreWall : Infinity;
  const margin = mat.sigmaY / hoop;

  base.rows = [
    row('Internal pressure', `${(p / 1e6).toFixed(2)} MPa`),
    row('Membrane radius', `${(m.boreRadius * 1000).toFixed(0)} mm`),
    row('Wall', `${(m.boreWall * 1000).toFixed(2)} mm`),
    row('Membrane stress', `${(hoop / 1e6).toFixed(0)} MPa`),
    row('Yield margin', `${margin.toFixed(2)}×`, verdict(margin)),
  ];
  base.state = verdict(margin);
  base.headline = `${base.mass.toFixed(1)} kg · ${margin.toFixed(2)}× on pressure`;
  base.meter = {
    label: 'Membrane stress',
    ratio: 1 / Math.max(0.01, margin),
    text: `${margin.toFixed(2)}× margin`,
    threshold: 1 / 1.5,
    state: base.state,
  };
  if (margin < 1.5) {
    base.note = `Wall is too thin for ${(p / 1e6).toFixed(1)} MPa at this radius. Stress scales with r/t — thickening the wall and shrinking the bore both work.`;
  }
  return base;
}

function dutyHotGas(base, def, m, mat, contour, cooling, params, mount) {
  // Bartz flux falls off away from the throat with the local area ratio.
  const r = Math.max(contour.Rt, mount.radius);
  const q = cooling.qThroatMW * 1e6 * Math.min(1, Math.pow(contour.Rt / r, 1.8));
  const gasSide = m.area / 2;
  const heatLoad = q * gasSide;

  let temp;
  let mode;
  if (def.cooled) {
    const bulk = PROPELLANTS[params.propellant].label.startsWith('LH2') ? 160 : 420;
    temp = bulk + (mat.k > 0 ? (q * m.boreWall) / mat.k : Infinity);
    mode = 'regen-cooled';
  } else {
    temp = radiativeEquilibrium(q);
    mode = 'radiation-cooled';
  }
  const margin = temp > 0 ? mat.tMax / temp : Infinity;

  base.rows = [
    row('Local heat flux', `${(q / 1e6).toFixed(2)} MW/m²`),
    row('Gas-side area', `${gasSide.toFixed(3)} m²`),
    row('Heat load', `${(heatLoad / 1e6).toFixed(2)} MW`),
    row('Cooling', mode),
    row('Wall temperature', `${temp.toFixed(0)} K`, verdict(margin)),
    row('Material limit', `${mat.tMax} K`),
  ];
  base.state = margin >= 1.2 ? 'ok' : margin >= 1 ? 'warn' : 'bad';
  base.headline = `${base.mass.toFixed(1)} kg · ${temp.toFixed(0)} K wall`;
  base.meter = {
    label: 'Wall temperature',
    ratio: temp / mat.tMax,
    text: `${temp.toFixed(0)} / ${mat.tMax} K`,
    threshold: 1,
    state: base.state,
  };
  if (margin < 1) {
    const hotter = hotterThan(def.material, temp);
    const escape = hotter.length
      ? `move to ${hotter.join(' or ')}`
      : 'nothing in the material list survives it — the flux itself has to come down';
    base.note = def.cooled
      ? `${mat.label} cannot hold ${temp.toFixed(0)} K. A thinner wall or a higher-conductivity liner cuts the conduction rise; otherwise ${escape}.`
      : `Uncooled, this settles at ${temp.toFixed(0)} K — past the ${mat.tMax} K limit for ${mat.label}. Either regen-cool it, mount it further down the bell where the flux is lower, or ${escape}.`;
  }
  base.heatLoadMW = heatLoad / 1e6;
  return base;
}

function dutyRotating(base, def, m, mat) {
  const omega = (def.rpm * TAU) / 60;
  const u = omega * m.tipRadius;
  // Hoop stress in a rotating rim is ρU² exactly — the classic result that
  // caps turbomachinery tip speed regardless of how big you build it.
  const stress = mat.rho * u * u;
  const margin = stress > 0 ? mat.sigmaY / stress : Infinity;

  base.rows = [
    row('Shaft speed', `${def.rpm.toFixed(0)} rpm`),
    row('Tip radius', `${(m.tipRadius * 1000).toFixed(0)} mm`),
    row('Tip speed', `${u.toFixed(0)} m/s`),
    row('Rim stress', `${(stress / 1e6).toFixed(0)} MPa`),
    row('Burst margin', `${margin.toFixed(2)}×`, verdict(margin)),
  ];
  base.state = verdict(margin);
  base.headline = `${base.mass.toFixed(1)} kg · ${u.toFixed(0)} m/s tip`;
  base.meter = {
    label: 'Rim stress',
    ratio: 1 / Math.max(0.01, margin),
    text: `${margin.toFixed(2)}× margin`,
    threshold: 1 / 1.5,
    state: base.state,
  };
  if (margin < 1.5) {
    base.note = `Rim stress goes as tip speed squared, so trimming the tip radius pays twice. At ${def.rpm.toFixed(0)} rpm the limit radius in ${mat.label} is ${((Math.sqrt(mat.sigmaY / mat.rho / 1.5) / omega) * 1000).toFixed(0)} mm.`;
  }
  return base;
}

function dutyPlumbing(base, def, m, params, perf) {
  const prop = PROPELLANTS[params.propellant];
  const mdot = perf.mdot * def.flowShare;
  const rho = prop.rhoBulk;
  const v = m.flowArea > 0 ? mdot / (rho * m.flowArea) : Infinity;
  // Darcy–Weisbach with a friction factor typical of drawn metal tube.
  const f = 0.02;
  const dp = m.hydraulicD > 0 ? f * (m.flowLength / m.hydraulicD) * ((rho * v * v) / 2) : Infinity;
  const dpFrac = dp / params.chamberPressure;

  base.rows = [
    row('Mass flow', `${mdot.toFixed(2)} kg/s`),
    row('Flow area', `${(m.flowArea * 1e4).toFixed(1)} cm²`),
    row('Path length', `${m.flowLength.toFixed(3)} m`),
    row('Velocity', `${v.toFixed(1)} m/s`, v > 25 ? 'bad' : v > 15 ? 'warn' : 'ok'),
    row('Pressure drop', `${(dp / 1e5).toFixed(2)} bar`),
    row('Drop vs Pc', `${(dpFrac * 100).toFixed(1)}%`, dpFrac > 0.15 ? 'bad' : dpFrac > 0.08 ? 'warn' : 'ok'),
  ];
  base.state = v > 25 || dpFrac > 0.15 ? 'bad' : v > 15 || dpFrac > 0.08 ? 'warn' : 'ok';
  base.headline = `${base.mass.toFixed(1)} kg · ${v.toFixed(1)} m/s`;
  base.meter = {
    label: 'Flow velocity',
    ratio: v / 25,
    text: `${v.toFixed(1)} m/s of 25 max`,
    threshold: 15 / 25,
    state: base.state,
  };
  if (v > 15) {
    base.note = `Above about 15 m/s a shutdown transient starts water-hammering the line. Widen the bore — velocity falls with the square of radius.`;
  } else if (dpFrac > 0.08) {
    base.note = 'Pressure drop is eating pump discharge. Shorten the run or open up the hydraulic diameter.';
  }
  base.pressureDropBar = dp / 1e5;
  return base;
}

/** Roll a set of solved parts into the numbers the analysis panel wants. */
export function summariseCustom(stats, engineMass, engineCentroidY, thrust) {
  const mass = stats.reduce((a, s) => a + s.mass, 0);
  const total = engineMass + mass;
  const moment = engineMass * engineCentroidY + stats.reduce((a, s) => a + s.mass * s.y, 0);
  const worst = stats.reduce(
    (a, s) => (rank(s.state) > rank(a) ? s.state : a),
    'ok'
  );
  return {
    count: stats.length,
    mass,
    totalMass: total,
    centroidY: total > 0 ? moment / total : engineCentroidY,
    centroidShift: total > 0 ? moment / total - engineCentroidY : 0,
    worstState: stats.length ? worst : 'none',
    failing: stats.filter((s) => s.state === 'bad'),
    marginal: stats.filter((s) => s.state === 'warn'),
    thrustToWeight: total > 0 ? thrust / (total * 9.80665) : 0,
  };
}

function rank(state) {
  return state === 'bad' ? 3 : state === 'warn' ? 2 : state === 'ok' ? 1 : 0;
}
