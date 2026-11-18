/* ───────────────────────────────────────────────────────────────
   Central design state + event bus.

   Anything that mutates the design goes through here so the panels,
   the 3D scene and the AI agent all observe the same source of truth
   and undo works uniformly.
   ─────────────────────────────────────────────────────────────── */

export const PARAM_SPEC = {
  throatRadius:     { label: 'Throat radius',     min: 0.02, max: 0.45, step: 0.005, unit: 'm',   rebuild: true },
  expansionRatio:   { label: 'Expansion ratio',   min: 2,    max: 180,  step: 0.5,   unit: ':1',  rebuild: true },
  chamberPressure:  { label: 'Chamber pressure',  min: 1e6,  max: 35e6, step: 1e5,   unit: 'Pa',  rebuild: false, display: (v) => (v / 1e6).toFixed(1), displayUnit: 'MPa' },
  contractionRatio: { label: 'Contraction ratio', min: 2,    max: 12,   step: 0.1,   unit: ':1',  rebuild: true },
  chamberLength:    { label: 'Chamber length',    min: 0.05, max: 1.2,  step: 0.01,  unit: 'm',   rebuild: true },
  bellPercent:      { label: 'Bell length',       min: 50,   max: 100,  step: 1,     unit: '%',   rebuild: true },
  coolingChannels:  { label: 'Cooling channels',  min: 8,    max: 64,   step: 1,     unit: '',    rebuild: true },
  wallThickness:    { label: 'Wall thickness',    min: 0.02, max: 0.2,  step: 0.005, unit: '×Rt', rebuild: true },
  gimbalAngle:      { label: 'Gimbal deflection', min: -8,   max: 8,    step: 0.25,  unit: '°',   rebuild: false },
  altitude:         { label: 'Ambient altitude',  min: 0,    max: 80000, step: 250,  unit: 'm',   rebuild: false },
  throttle:         { label: 'Throttle',          min: 0,    max: 1,    step: 0.01,  unit: '',    rebuild: false, display: (v) => (v * 100).toFixed(0), displayUnit: '%' },
};

export const ENUM_SPEC = {
  bellType:   { label: 'Contour', options: ['parabolic', 'conical', 'aerospike'], rebuild: true },
  propellant: { label: 'Propellant', options: ['kerolox', 'methalox', 'hydrolox', 'hypergol'], rebuild: false },
  material:   { label: 'Wall material', options: ['inconel718', 'grcop42', 'cSiC', 'nb_c103'], rebuild: false },
};

export const DEFAULTS = Object.freeze({
  throatRadius: 0.13,
  expansionRatio: 16,
  chamberPressure: 9.7e6,
  contractionRatio: 4.0,
  chamberLength: 0.26,
  bellType: 'parabolic',
  bellPercent: 80,
  coolingChannels: 40,
  wallThickness: 0.075,
  gimbalAngle: 0,
  altitude: 0,
  throttle: 0,
  propellant: 'kerolox',
  material: 'grcop42',
});

export const PRESETS = {
  booster: {
    label: 'Sea-level booster',
    note: 'Kerolox, low expansion so it stays attached at sea level.',
    params: { throatRadius: 0.13, expansionRatio: 16, chamberPressure: 9.7e6, bellPercent: 80, bellType: 'parabolic', propellant: 'kerolox', material: 'grcop42', altitude: 0, coolingChannels: 40 },
  },
  vacuum: {
    label: 'Vacuum upper stage',
    note: 'Huge area ratio — would flow-separate violently at sea level.',
    params: { throatRadius: 0.09, expansionRatio: 110, chamberPressure: 6.2e6, bellPercent: 88, bellType: 'parabolic', propellant: 'hydrolox', material: 'nb_c103', altitude: 60000, coolingChannels: 52 },
  },
  methalox: {
    label: 'Full-flow methalox',
    note: 'High chamber pressure, deep-throttling booster engine.',
    params: { throatRadius: 0.115, expansionRatio: 34, chamberPressure: 30e6, bellPercent: 82, bellType: 'parabolic', propellant: 'methalox', material: 'grcop42', altitude: 0, coolingChannels: 60 },
  },
  aerospike: {
    label: 'Truncated aerospike',
    note: 'Altitude-compensating plug. Short, wide, thermally brutal.',
    params: { throatRadius: 0.1, expansionRatio: 55, chamberPressure: 14e6, bellPercent: 70, bellType: 'aerospike', propellant: 'kerolox', material: 'grcop42', altitude: 12000, coolingChannels: 64 },
  },
  rcs: {
    label: 'Hypergolic RCS pod',
    note: 'Storable, restartable, tiny. Reliability over performance.',
    params: { throatRadius: 0.026, expansionRatio: 40, chamberPressure: 1.4e6, bellPercent: 75, bellType: 'conical', propellant: 'hypergol', material: 'nb_c103', altitude: 40000, coolingChannels: 12 },
  },
};

export const VIEWS = {
  iso:      { label: 'Isometric',  pos: [3.8, 2.0, 4.4] },
  front:    { label: 'Front',      pos: [0, 0.75, 6.1] },
  side:     { label: 'Side',       pos: [6.1, 0.75, 0.01] },
  top:      { label: 'Top',        pos: [0.01, 6.3, 0.01] },
  nozzle:   { label: 'Nozzle',     pos: [1.1, -2.5, 2.7] },
  injector: { label: 'Injector',   pos: [1.7, 3.3, 2.3] },
};

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export class Store {
  constructor(initial = DEFAULTS) {
    this.params = { ...initial };
    /** Operator- and agent-authored hardware. @see model/customPart.js */
    this.customParts = [];
    this.ui = {
      explode: 0,
      cutaway: false,
      isolate: false,
      grid: true,
      selected: null,
      hovered: null,
      firing: false,
      theme: 'cyan',
      focus: 'full',   // 'full' | 'clear' | 'bare' — how much interface shows
      annotations: {},
    };
    this.history = [];
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (err) { console.error(`[store] ${event} listener failed`, err); }
    });
    if (event !== '*') this.emit('*', { event, payload });
  }

  /** Coerce + clamp a parameter into legal range. Returns the applied value. */
  coerce(key, value) {
    const spec = PARAM_SPEC[key];
    if (spec) {
      const n = Number(value);
      if (!Number.isFinite(n)) return this.params[key];
      return clamp(n, spec.min, spec.max);
    }
    const en = ENUM_SPEC[key];
    if (en) return en.options.includes(value) ? value : this.params[key];
    return value;
  }

  set(key, value, { record = true, silent = false } = {}) {
    if (!(key in this.params)) return { ok: false, reason: `unknown parameter "${key}"` };
    const applied = this.coerce(key, value);
    const previous = this.params[key];
    if (applied === previous) return { ok: true, changed: false, value: applied };

    if (record) this.history.push({ type: 'param', key, previous });
    if (this.history.length > 120) this.history.shift();

    this.params[key] = applied;
    const rebuild = Boolean(PARAM_SPEC[key]?.rebuild || ENUM_SPEC[key]?.rebuild);
    if (!silent) this.emit('param', { key, value: applied, previous, rebuild });
    return { ok: true, changed: true, value: applied, rebuild };
  }

  setMany(patch, opts = {}) {
    const changed = [];
    let rebuild = false;
    const snapshot = { ...this.params };
    for (const [k, v] of Object.entries(patch)) {
      const r = this.set(k, v, { ...opts, record: false, silent: true });
      if (r.ok && r.changed) {
        changed.push(k);
        rebuild = rebuild || r.rebuild;
      }
    }
    if (!changed.length) return { ok: true, changed: [] };
    if (opts.record !== false) this.history.push({ type: 'bulk', snapshot });
    this.emit('param', { key: changed, bulk: true, rebuild });
    return { ok: true, changed, rebuild };
  }

  setUi(key, value, { silent = false } = {}) {
    const previous = this.ui[key];
    if (previous === value) return false;
    this.ui[key] = value;
    if (!silent) this.emit('ui', { key, value, previous });
    return true;
  }

  /* ── Custom parts ────────────────────────────────────────────
     Definitions are opaque here: normalisation and clamping live in
     model/customPart.js, which owns the schema. The store's job is
     identity, ordering, change notification and undo.                */

  /** Snapshot for undo. Definitions are flat data, so a deep copy is cheap. */
  #snapshotParts() {
    return this.customParts.map((p) => ({ ...p, dims: { ...p.dims } }));
  }

  #emitParts(action, id) {
    this.emit('parts', { action, id, parts: this.customParts, rebuild: true });
  }

  addCustomPart(def, { record = true } = {}) {
    if (record) this.history.push({ type: 'parts', snapshot: this.#snapshotParts() });
    this.customParts.push(def);
    this.#emitParts('add', def.id);
    return def;
  }

  updateCustomPart(id, def, { record = false } = {}) {
    const i = this.customParts.findIndex((p) => p.id === id);
    if (i < 0) return null;
    if (record) this.history.push({ type: 'parts', snapshot: this.#snapshotParts() });
    this.customParts[i] = def;
    this.#emitParts('update', id);
    return def;
  }

  removeCustomPart(id, { record = true } = {}) {
    const i = this.customParts.findIndex((p) => p.id === id);
    if (i < 0) return false;
    if (record) this.history.push({ type: 'parts', snapshot: this.#snapshotParts() });
    this.customParts.splice(i, 1);
    if (this.ui.selected === id) this.setUi('selected', null);
    this.#emitParts('remove', id);
    return true;
  }

  getCustomPart(id) {
    return this.customParts.find((p) => p.id === id) ?? null;
  }

  /** Look a part up by id first, then by case-insensitive name — the AI names them. */
  findCustomPart(key) {
    if (!key) return null;
    const needle = String(key).toLowerCase();
    return (
      this.customParts.find((p) => p.id.toLowerCase() === needle) ??
      this.customParts.find((p) => p.name.toLowerCase() === needle) ??
      this.customParts.find((p) => p.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  clearCustomParts({ record = true } = {}) {
    if (!this.customParts.length) return false;
    if (record) this.history.push({ type: 'parts', snapshot: this.#snapshotParts() });
    this.customParts = [];
    this.#emitParts('clear', null);
    return true;
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    if (entry.type === 'parts') {
      this.customParts = entry.snapshot;
      if (this.ui.selected && !this.customParts.some((p) => p.id === this.ui.selected)) {
        // The selected part may have just been undone out of existence.
        if (this.ui.selected.startsWith('cp')) this.setUi('selected', null);
      }
      this.#emitParts('undo', null);
      return true;
    }
    if (entry.type === 'param') {
      this.params[entry.key] = entry.previous;
      this.emit('param', {
        key: entry.key,
        value: entry.previous,
        rebuild: Boolean(PARAM_SPEC[entry.key]?.rebuild || ENUM_SPEC[entry.key]?.rebuild),
        undo: true,
      });
    } else {
      this.params = { ...entry.snapshot };
      this.emit('param', { key: Object.keys(entry.snapshot), bulk: true, rebuild: true, undo: true });
    }
    return true;
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return { ok: false, reason: `unknown preset "${name}"` };
    this.setMany({ ...DEFAULTS, ...preset.params });
    this.emit('preset', { name, preset });
    return { ok: true, preset: preset.label };
  }

  reset() {
    this.history.push({ type: 'bulk', snapshot: { ...this.params } });
    this.params = { ...DEFAULTS };
    this.emit('param', { key: Object.keys(DEFAULTS), bulk: true, rebuild: true });
  }

  snapshot() {
    return { params: { ...this.params }, ui: { ...this.ui }, customParts: this.#snapshotParts() };
  }
}
