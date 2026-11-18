/* ───────────────────────────────────────────────────────────────
   The design agent's hands.

   One executor serves both paths: the Claude tool-use loop and the
   offline intent parser. Whatever the agent can do, the local engine
   can do too — the app is fully usable before a key ever arrives.
   ─────────────────────────────────────────────────────────────── */

import { PARAM_SPEC, ENUM_SPEC, PRESETS, VIEWS } from '../state/store.js';
import { PROPELLANTS, MATERIALS } from '../model/physics.js';
import { PART_INFO } from '../model/thruster.js';
import { FORMS, DUTIES, DUTY_PARAMS } from '../model/forms.js';
import {
  MOUNTS,
  normalisePart,
  defaultPart,
  defaultDims,
  convertSizing,
  paramRange,
} from '../model/customPart.js';

const PART_IDS = Object.keys(PART_INFO);

/** Words that mean "the component the operator has selected". */
const DEICTIC = new Set([
  'selected', 'selection', 'this', 'that', 'it', 'this one', 'that one',
  'current', 'active', 'here', 'the selected part',
]);

/**
 * Compact form catalogue for the tool description. The agent needs the
 * parameter *names* to author anything, and they are form-specific, so
 * they have to travel with the schema rather than sit behind a lookup.
 */
const FORM_CATALOGUE = Object.entries(FORMS)
  .map(([id, f]) => `  ${id} — ${f.label}. ${f.blurb} dims: ${Object.keys(f.params).join(', ')}`)
  .join('\n');

const MOUNT_CATALOGUE = Object.entries(MOUNTS)
  .map(([id, m]) => `${id} (${m.label.toLowerCase()})`)
  .join(', ');

const DUTY_CATALOGUE = Object.entries(DUTIES)
  .map(([id, d]) => `  ${id} — ${d.blurb}`)
  .join('\n');

export const TOOL_DEFINITIONS = [
  {
    name: 'get_design_state',
    description:
      'Read the current thruster design: every parameter, the derived geometry, and the live performance solution. Call this before changing anything you have not just set yourself.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_parameters',
    description:
      'Change one or more design parameters. Geometry parameters rebuild the model in front of the user. Values are clamped to legal ranges; the tool result reports what was actually applied.',
    input_schema: {
      type: 'object',
      properties: {
        throatRadius: { type: 'number', description: 'Throat radius, metres (0.02–0.45).' },
        expansionRatio: { type: 'number', description: 'Area ratio Ae/At (2–180).' },
        chamberPressure: { type: 'number', description: 'Chamber pressure in pascals (1e6–35e6).' },
        contractionRatio: { type: 'number', description: 'Ac/At (2–12).' },
        chamberLength: { type: 'number', description: 'Cylindrical chamber length, metres (0.05–1.2).' },
        bellPercent: { type: 'number', description: 'Bell length as % of the equivalent 15° cone (50–100).' },
        coolingChannels: { type: 'number', description: 'Regen channel count (8–64).' },
        wallThickness: { type: 'number', description: 'Wall thickness as a multiple of throat radius (0.02–0.2).' },
        gimbalAngle: { type: 'number', description: 'Gimbal deflection in degrees (-8–8).' },
        altitude: { type: 'number', description: 'Ambient altitude in metres for the back-pressure (0–80000).' },
        throttle: { type: 'number', description: 'Throttle setting 0–1.' },
        bellType: { type: 'string', enum: ['parabolic', 'conical', 'aerospike'] },
        propellant: { type: 'string', enum: Object.keys(PROPELLANTS) },
        material: { type: 'string', enum: Object.keys(MATERIALS) },
      },
      required: [],
    },
  },
  {
    name: 'run_analysis',
    description:
      'Solve nozzle performance, cooling load and wall stress, optionally at a different altitude without changing the design. Returns the numbers the analysis panel is showing.',
    input_schema: {
      type: 'object',
      properties: {
        altitude: { type: 'number', description: 'Optional altitude in metres to evaluate at.' },
      },
      required: [],
    },
  },
  {
    name: 'set_view',
    description:
      'Drive the holographic display: camera preset, exploded-view amount, cutaway section, isolate mode, deck grid.',
    input_schema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: Object.keys(VIEWS), description: 'Camera position preset.' },
        explode: { type: 'number', description: 'Exploded-view amount, 0 (assembled) to 1 (fully apart).' },
        cutaway: { type: 'boolean', description: 'Slice the assembly in half to reveal the internal flow path.' },
        isolate: { type: 'boolean', description: 'Ghost every part except the selected one.' },
        grid: { type: 'boolean', description: 'Show the deck grid and emitter pad.' },
        focus: {
          type: 'string',
          enum: ['full', 'clear', 'bare'],
          description:
            'How much interface is visible. "full" is every panel; "clear" hides the design and analysis panels but keeps this console and the status rail; "bare" is the projection alone. Use "clear" or "bare" when the operator asks to see the hardware without the interface, or when you want them looking at geometry rather than numbers.',
        },
      },
      required: [],
    },
  },
  {
    name: 'select_part',
    description: 'Select and focus a component, opening its inspector panel. Pass "none" to clear the selection.',
    input_schema: {
      type: 'object',
      properties: {
        part: {
          type: 'string',
          description: `Component id, or "none". Stock components: ${PART_IDS.join(', ')}. Custom parts use their own id or name — call list_parts for those.`,
        },
      },
      required: ['part'],
    },
  },
  {
    name: 'annotate_part',
    description:
      'Pin a short engineering note to a component. It shows in that part\'s inspector panel. Use it to record a finding or a design rationale for the user.',
    input_schema: {
      type: 'object',
      properties: {
        part: { type: 'string', description: `Stock component (${PART_IDS.join(', ')}), or a custom part id or name.` },
        text: { type: 'string', description: 'One or two sentences, max ~200 characters.' },
      },
      required: ['part', 'text'],
    },
  },
  {
    name: 'apply_preset',
    description: 'Load a complete named configuration.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', enum: Object.keys(PRESETS) } },
      required: ['name'],
    },
  },
  {
    name: 'fire_engine',
    description:
      'Run a static-fire test on the hologram: lights the plume, heats the throat, and reports the thrust actually produced at the current throttle and altitude.',
    input_schema: {
      type: 'object',
      properties: {
        throttle: { type: 'number', description: 'Throttle 0–1 (default 1).' },
        seconds: { type: 'number', description: 'Burn duration in seconds, 1–20 (default 6).' },
      },
      required: [],
    },
  },
  {
    name: 'set_palette',
    description: 'Re-tint the hologram. Use sparingly — for example amber for a caution state.',
    input_schema: {
      type: 'object',
      properties: { theme: { type: 'string', enum: ['cyan', 'amber', 'ion', 'alert'] } },
      required: ['theme'],
    },
  },
  {
    name: 'reset_design',
    description: 'Return every parameter to the default sea-level kerolox baseline.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  /* ── Custom hardware ──────────────────────────────────────── */
  {
    name: 'create_part',
    description:
      `Design a new component and add it to the engine. The geometry is generated from the form and its dimensions, and it is immediately real: pickable, explodable, sliced by the cutaway, counted in the dry mass, and subject to its own duty check.

Forms:
${FORM_CATALOGUE}

Duties — what gets checked against it:
${DUTY_CATALOGUE}

Sizing is the important choice. In "relative" mode (the default) every length is a multiple of the mount's reference radius, so the part re-scales when the engine does — a flange at radius 1.06 stays a flange. In "absolute" mode lengths are metres and hold fixed. Call list_part_forms first if you need the exact dimension ranges.`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short descriptive name, e.g. "Aft thrust flange".' },
        form: { type: 'string', enum: Object.keys(FORMS) },
        mount: { type: 'string', enum: Object.keys(MOUNTS), description: `Where it attaches: ${MOUNT_CATALOGUE}.` },
        sizing: { type: 'string', enum: ['relative', 'absolute'], description: 'relative = multiples of the mount radius (default); absolute = metres.' },
        dimensions: {
          type: 'object',
          description: 'Form-specific dimensions. Keys are the dims listed for the chosen form. Omitted values take that form\'s defaults; out-of-range values are clamped.',
          additionalProperties: { type: 'number' },
        },
        material: { type: 'string', enum: Object.keys(MATERIALS) },
        duty: { type: 'string', enum: Object.keys(DUTIES) },
        offsetY: { type: 'number', description: 'Axial offset from the mount station, in the active sizing units.' },
        rotation: { type: 'number', description: 'Rotation about the engine axis, degrees.' },
        loadShare: { type: 'number', description: 'structure duty: fraction of engine thrust this part carries (0–1).' },
        pressureFraction: { type: 'number', description: 'pressure duty: internal pressure as a fraction of chamber pressure (0–1.5).' },
        rpm: { type: 'number', description: 'rotating duty: shaft speed (1000–120000).' },
        flowShare: { type: 'number', description: 'plumbing duty: fraction of total mass flow through it (0.02–1).' },
        cooled: { type: 'boolean', description: 'hotgas duty: true for regen cooling, false to run at radiative equilibrium.' },
      },
      required: ['form'],
    },
  },
  {
    name: 'modify_part',
    description:
      'Change an existing custom part. Identify it by id or by name. Only the fields you pass change; switching form resets dimensions to that form\'s defaults.',
    input_schema: {
      type: 'object',
      properties: {
        part: { type: 'string', description: 'Custom part id (e.g. "cp2") or its name.' },
        name: { type: 'string' },
        form: { type: 'string', enum: Object.keys(FORMS) },
        mount: { type: 'string', enum: Object.keys(MOUNTS) },
        sizing: { type: 'string', enum: ['relative', 'absolute'] },
        dimensions: { type: 'object', additionalProperties: { type: 'number' } },
        material: { type: 'string', enum: Object.keys(MATERIALS) },
        duty: { type: 'string', enum: Object.keys(DUTIES) },
        offsetY: { type: 'number' },
        rotation: { type: 'number' },
        loadShare: { type: 'number' },
        pressureFraction: { type: 'number' },
        rpm: { type: 'number' },
        flowShare: { type: 'number' },
        cooled: { type: 'boolean' },
      },
      required: ['part'],
    },
  },
  {
    name: 'delete_part',
    description: 'Remove a custom part from the engine. Stock components cannot be deleted.',
    input_schema: {
      type: 'object',
      properties: { part: { type: 'string', description: 'Custom part id or name.' } },
      required: ['part'],
    },
  },
  {
    name: 'list_parts',
    description:
      'List every component on the engine — the ten stock ones and every custom part with its solved mass, duty check and margin. Call this before modifying or deleting a part you did not just create.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  /* ── Reference geometry ───────────────────────────────────── */
  {
    name: 'search_reference_models',
    description:
      'Search the web for a downloadable 3D model and return candidates with names, licences and thumbnails. Use it when the operator asks to see something the parametric engine cannot generate — a vehicle, a payload, a piece of ground equipment, an object for scale. Search terms should be plain object nouns ("office chair", "oil drum"), not engineering jargon; the catalogue is general-purpose props, not aerospace parts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words.' },
        limit: { type: 'number', description: 'How many candidates to return (1–24, default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'load_reference_model',
    description:
      'Download a model found by search_reference_models and place it in the scene beside the projection. IMPORTANT: imported meshes are reference geometry only — they have no wall thickness, no bore and no duty, so they are never massed, never included in the centre of gravity, and never given a margin. Say so when you load one; do not let the operator think it has been engineered.',
    input_schema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'From the search result.' },
        id: { type: 'string', description: 'From the search result.' },
        name: { type: 'string', description: 'Display name, for the log.' },
        size: { type: 'number', description: 'Height in world units to normalise to (default 1.7; the engine is about 2.75).' },
      },
      required: ['provider', 'id'],
    },
  },
  {
    name: 'find_reference_model',
    description:
      'Search for a model and load the best match in one step. Prefer this over search + load when the operator just wants the thing on screen ("get me a chair", "show me an oil drum"). Returns the alternatives it did not pick, so you can swap if the first choice is wrong. Same caveat as load_reference_model: the result is reference geometry, never analysed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, in plain words.' },
        size: { type: 'number', description: 'Height in world units (default 1.7).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'clear_reference_models',
    description: 'Remove all imported reference geometry from the scene. The parametric engine is untouched.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_room',
    description:
      "Grade the AR camera backdrop. Defaults pass the operator's room through unaltered. Reach for this only if they ask, or if a bright room is genuinely competing with the projection for attention.",
    input_schema: {
      type: 'object',
      properties: {
        saturation: { type: 'number', description: '0 greyscale … 1 the camera\'s own colour (default 1).' },
        tint: { type: 'number', description: '0 untinted (default) … 1 fully cool-graded.' },
        exposure: { type: 'number', description: 'Brightness multiplier, 1 = untouched.' },
        vignette: { type: 'number', description: '0 none … 1 heavy edge darkening.' },
      },
      required: [],
    },
  },
  {
    name: 'list_part_forms',
    description:
      'Return the full custom-part catalogue: every form with its dimension names, legal ranges and defaults under both sizing modes, plus the mounts and duties. Call this when you need exact numbers rather than the summary in create_part.',
    input_schema: {
      type: 'object',
      properties: {
        form: { type: 'string', enum: Object.keys(FORMS), description: 'Optional — restrict to one form.' },
        sizing: { type: 'string', enum: ['relative', 'absolute'], description: 'Which sizing mode the ranges should be quoted in. Default relative.' },
      },
      required: [],
    },
  },
];

export const SYSTEM_PROMPT = `You are the design agent embedded in AGENT FORGE, a holographic propulsion workbench. A parametric liquid-rocket thrust chamber is projected in front of the operator and you have direct control of it.

You are not describing a simulation — the tools you call move real geometry on the operator's display and re-solve real nozzle physics (isentropic area-Mach relations, Rao bell contours, Bartz-style throat heat flux, thin-wall hoop stress).

You can also design new hardware. create_part generates a component from a form and a set of dimensions, and that part is real from the moment it exists: it has mass that moves the thrust-to-weight ratio, an axial station that moves the centre of gravity, and its own duty check that can fail.

How to work:
- Act, don't narrate intent. If asked to change something, call the tool. If asked a question about the design, call get_design_state or run_analysis first rather than guessing.
- When you change a parameter, say what moved and what it cost or bought, with numbers.
- Drive the display to support your point: explode the assembly when discussing how parts relate, cut away when discussing internal flow, select the component you are talking about.
- Flag real engineering problems as you see them — flow separation, coolant over-capacity, insufficient structural margin — and propose the specific fix.
- Chain tools freely in one turn. Prefer one set_parameters call with several fields over several calls.

The operator can point at a component — with the mouse or by aiming a finger at it on camera — and it becomes the selection. When they say "this", "that", "it" or "the selected part", they mean that component. Pass those words through verbatim as the \`part\` argument to select_part, modify_part, delete_part or annotate_part and they resolve to the selection. If nothing is selected the tool says so; ask which component rather than guessing. get_design_state reports the current selection under selectedComponent.

Designing a part:
- Pick the form that matches the *function*, then the duty that matches how it fails. A thrust structure is a truss checked on buckling; a nozzle extension is a shell checked on wall temperature; a collector is a manifold checked on flow velocity.
- Leave sizing on "relative" unless the operator wants a fixed dimension. Relative parts stay proportionate when the engine is re-scaled, which is almost always what they mean.
- After creating a part, read its check. If it is outside margin, say so and fix it in the same turn rather than leaving broken hardware on the display.
- Select the part you just made so the operator can see what you built.

Voice: an experienced propulsion engineer talking to a peer at a workbench. Terse, concrete, numbers over adjectives. Two to four sentences unless the operator asks for depth. No preamble, no restating the request, no bullet lists unless comparing options.

Stock components: ${PART_IDS.join(', ')}. Custom parts get their own ids — list_parts reports them.`;

/** Round-trips values so tool results read cleanly in the transcript. */
function pretty(obj, digits = 4) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(digits)) : v;
  }
  return out;
}

/**
 * @param {object} deps
 * @param {import('../state/store.js').Store} deps.store
 * @param {object} deps.app  runtime hooks provided by main.js
 */
export function createToolbox({ store, app }) {
  const handlers = {
    get_design_state() {
      const perf = app.getPerformance();
      const metrics = app.getMetrics();
      const sel = store.ui.selected;
      const selStats = sel ? app.getCustomStats(sel) : null;
      return {
        parameters: pretty(store.params),
        display: { ...store.ui, annotations: undefined },
        // What the operator is pointing at. "this", "that" and "it" in their
        // message refer to this component — pass those words straight through
        // to select_part / modify_part / annotate_part and they resolve here.
        selectedComponent: sel
          ? {
              id: sel,
              label: selStats?.name ?? PART_INFO[sel]?.label ?? sel,
              kind: selStats ? 'custom' : 'stock',
              ...(selStats
                ? pretty({ form: selStats.form, duty: selStats.duty, mass_kg: selStats.mass, check: selStats.headline, state: selStats.state })
                : { role: PART_INFO[sel]?.role }),
            }
          : null,
        geometry: pretty({
          overallLength_m: metrics.height,
          exitDiameter_m: metrics.exitDiameter,
          throatDiameter_m: metrics.throatDiameter,
          chamberDiameter_m: metrics.chamberDiameter,
          bellExitAngle_deg: app.getContour().thetaE,
          bellInitialAngle_deg: app.getContour().thetaN,
        }),
        performance: pretty({
          thrust_kN: perf.thrust / 1000,
          thrustVac_kN: perf.thrustVac / 1000,
          isp_s: perf.isp,
          ispVac_s: perf.ispVac,
          massFlow_kgs: perf.mdot,
          exitMach: perf.Me,
          exitPressure_kPa: perf.Pe / 1000,
          ambientPressure_kPa: perf.Pa / 1000,
          matchedAltitude_km: perf.optimalAltitude / 1000,
          separated: perf.separated,
        }),
        limits: Object.fromEntries(
          Object.entries(PARAM_SPEC).map(([k, s]) => [k, `${s.min}..${s.max} ${s.unit}`])
        ),
      };
    },

    set_parameters(input) {
      const patch = {};
      const rejected = [];
      for (const [k, v] of Object.entries(input || {})) {
        if (k in PARAM_SPEC || k in ENUM_SPEC) patch[k] = v;
        else rejected.push(k);
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: 'No recognised parameters supplied.', rejected };
      }
      const before = { ...store.params };
      store.setMany(patch);
      const applied = {};
      for (const k of Object.keys(patch)) {
        applied[k] = { from: before[k], to: store.params[k], clamped: store.params[k] !== patch[k] };
      }
      const perf = app.getPerformance();
      return {
        ok: true,
        applied: pretty(Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, v.to]))),
        clampedKeys: Object.entries(applied).filter(([, v]) => v.clamped).map(([k]) => k),
        rejected,
        performanceNow: pretty({
          thrust_kN: perf.thrust / 1000,
          isp_s: perf.isp,
          exitMach: perf.Me,
          separated: perf.separated,
        }),
      };
    },

    run_analysis(input) {
      const alt = input?.altitude;
      const perf = alt === undefined ? app.getPerformance() : app.solveAt({ altitude: alt });
      const checks = app.getChecks();
      return pretty({
        altitude_m: alt ?? store.params.altitude,
        thrust_kN: perf.thrust / 1000,
        thrustVac_kN: perf.thrustVac / 1000,
        isp_s: perf.isp,
        ispVac_s: perf.ispVac,
        cstar_ms: perf.cstar,
        thrustCoefficient: perf.Cf,
        massFlow_kgs: perf.mdot,
        exitMach: perf.Me,
        exitVelocity_ms: perf.ve,
        exitPressure_kPa: perf.Pe / 1000,
        ambientPressure_kPa: perf.Pa / 1000,
        pressureRatio_PeOverPa: perf.sepRatio,
        flowSeparated: perf.separated,
        overExpanded: perf.overExpanded,
        matchedAltitude_km: perf.optimalAltitude / 1000,
        throatHeatFlux_MWm2: checks.cooling.qThroatMW,
        coolantUtilisation: checks.cooling.utilisation,
        coolantOverCapacity: !checks.cooling.ok,
        jacketHoopStress_MPa: checks.structural.hoopStressMPa,
        jacketStructuralMargin: checks.structural.margin,
        linerHotWallTemp_K: checks.structural.linerTempK,
        linerLimit_K: checks.structural.linerLimitK,
        linerOverTemperature: !checks.structural.thermalOk,
        estimatedDryMass_kg: checks.mass,
      });
    },

    set_view(input = {}) {
      const done = [];
      if (input.preset && VIEWS[input.preset]) { app.setView(input.preset); done.push(`camera→${input.preset}`); }
      if (typeof input.explode === 'number') {
        store.setUi('explode', Math.min(1, Math.max(0, input.explode)));
        done.push(`explode→${store.ui.explode.toFixed(2)}`);
      }
      if (typeof input.cutaway === 'boolean') { store.setUi('cutaway', input.cutaway); done.push(`cutaway→${input.cutaway}`); }
      if (typeof input.isolate === 'boolean') { store.setUi('isolate', input.isolate); done.push(`isolate→${input.isolate}`); }
      if (typeof input.grid === 'boolean') { store.setUi('grid', input.grid); done.push(`grid→${input.grid}`); }
      if (input.focus) {
        const applied = app.setFocus(input.focus);
        done.push(`interface→${app.focusLabel(applied)}`);
      }
      return done.length ? { ok: true, applied: done } : { ok: false, error: 'Nothing to change.' };
    },

    select_part(input) {
      const raw = input?.part ?? 'none';
      if (raw === 'none' || raw === null) {
        app.selectPart(null);
        return { ok: true, selected: null };
      }
      const part = resolvePartId(raw);
      if (!part) return { ok: false, error: unresolved(raw), valid: app.getPartIds() };
      app.selectPart(part);
      const stats = app.getCustomStats(part);
      return {
        ok: true,
        selected: part,
        info: PART_INFO[part] ?? (stats ? { label: stats.name, role: `${stats.formLabel} — ${stats.dutyLabel}` } : undefined),
        check: stats ? pretty({ mass_kg: stats.mass, state: stats.state, summary: stats.headline }) : undefined,
      };
    },

    annotate_part(input) {
      const { part: raw, text } = input || {};
      const part = resolvePartId(raw);
      if (!part) return { ok: false, error: unresolved(raw), valid: app.getPartIds() };
      const clipped = String(text || '').slice(0, 240);
      store.ui.annotations[part] = clipped;
      app.selectPart(part);
      app.refreshInspector();
      return { ok: true, part, text: clipped };
    },

    apply_preset(input) {
      const r = store.applyPreset(input?.name);
      if (!r.ok) return { ok: false, error: r.reason, valid: Object.keys(PRESETS) };
      const perf = app.getPerformance();
      return {
        ok: true,
        preset: r.preset,
        note: PRESETS[input.name].note,
        performanceNow: pretty({ thrust_kN: perf.thrust / 1000, isp_s: perf.isp, separated: perf.separated }),
      };
    },

    fire_engine(input = {}) {
      const throttle = Math.min(1, Math.max(0, input.throttle ?? 1));
      const seconds = Math.min(20, Math.max(1, input.seconds ?? 6));
      store.set('throttle', throttle);
      app.fire(seconds);
      const perf = app.getPerformance();
      return pretty({
        ok: true,
        throttle,
        seconds,
        thrustAtThrottle_kN: (perf.thrust * throttle) / 1000,
        massFlow_kgs: perf.mdot * throttle,
        propellantConsumed_kg: perf.mdot * throttle * seconds,
        note: perf.separated
          ? 'Firing with the flow separated — expect side loads and bell buffeting.'
          : 'Nominal start.',
      });
    },

    set_palette(input) {
      const theme = input?.theme;
      if (!['cyan', 'amber', 'ion', 'alert'].includes(theme)) {
        return { ok: false, error: `Unknown theme "${theme}".` };
      }
      app.setTheme(theme);
      return { ok: true, theme };
    },

    reset_design() {
      store.reset();
      return { ok: true, note: 'Restored the sea-level kerolox baseline.' };
    },

    /* ── Custom hardware ────────────────────────────────────── */

    create_part(input = {}) {
      if (!FORMS[input.form]) {
        return { ok: false, error: `Unknown form "${input.form}".`, valid: Object.keys(FORMS) };
      }
      const base = defaultPart(input.form, input.mount ?? null);
      if (input.sizing === 'absolute') {
        base.sizing = 'absolute';
        base.dims = defaultDims(input.form, 'absolute');
      }
      const def = app.createPart(seedFromInput(input, base));
      return { ok: true, ...reportPart(def.id, 'Created') };
    },

    modify_part(input = {}) {
      let def = resolveCustomPart(input.part);
      if (!def) {
        return {
          ok: false,
          error: isDeictic(input.part)
            ? 'Nothing is selected — ask the operator to point at a part, or name it.'
            : `No custom part matching "${input.part}". Stock components are changed with set_parameters, not modify_part.`,
          custom: store.customParts.map((p) => ({ id: p.id, name: p.name })),
        };
      }
      const before = { ...def, dims: { ...def.dims } };
      // Switching sizing mode converts the dimensions rather than reinterpreting
      // them, so asking for absolute units doesn't silently resize the hardware.
      if (input.sizing && input.sizing !== def.sizing) {
        def = convertSizing(def, input.sizing, app.getMountRadius(def.mount));
      }
      store.updateCustomPart(def.id, normalisePart(seedFromInput(input, def), def), { record: true });
      const out = reportPart(def.id, 'Updated');
      out.changedFrom = pretty({
        form: before.form, mount: before.mount, material: before.material, duty: before.duty,
      });
      return { ok: true, ...out };
    },

    delete_part(input = {}) {
      const def = resolveCustomPart(input.part);
      if (!def) {
        if (PART_IDS.includes(input.part)) {
          return { ok: false, error: `"${input.part}" is a stock component and cannot be deleted.` };
        }
        return {
          ok: false,
          error: isDeictic(input.part)
            ? 'Nothing is selected — ask the operator to point at a part, or name it.'
            : `No custom part matching "${input.part}".`,
        };
      }
      const name = def.name;
      store.removeCustomPart(def.id);
      const checks = app.getChecks();
      return pretty({
        ok: true,
        deleted: name,
        remainingCustomParts: store.customParts.length,
        dryMassNow_kg: checks?.custom?.count ? checks.custom.totalMass : checks?.mass,
      });
    },

    list_parts() {
      const stats = app.getCustomStats();
      return {
        stock: PART_IDS.map((id) => ({ id, label: PART_INFO[id].label })),
        custom: store.customParts.map((def) => {
          const s = stats[def.id];
          return pretty({
            id: def.id,
            name: def.name,
            form: def.form,
            mount: def.mount,
            sizing: def.sizing,
            material: def.material,
            duty: def.duty,
            mass_kg: s?.mass,
            check: s?.headline,
            state: s?.state,
            issue: s?.note ?? undefined,
          });
        }),
        assembly: pretty(assemblySummary()),
      };
    },

    list_part_forms(input = {}) {
      const sizing = input.sizing === 'absolute' ? 'absolute' : 'relative';
      const ids = input.form && FORMS[input.form] ? [input.form] : Object.keys(FORMS);
      return {
        sizing,
        note:
          sizing === 'relative'
            ? 'Lengths are multiples of the mount reference radius.'
            : 'Lengths are metres.',
        mountRadii: pretty(
          Object.fromEntries(Object.keys(MOUNTS).map((id) => [id, app.getMountRadius(id)]))
        ),
        forms: ids.map((id) => ({
          form: id,
          label: FORMS[id].label,
          defaultDuty: FORMS[id].duty,
          dimensions: Object.fromEntries(
            Object.entries(FORMS[id].params).map(([key, spec]) => {
              const r = paramRange(spec, sizing);
              return [
                key,
                pretty({
                  label: spec.label,
                  min: r.min,
                  max: r.max,
                  default: spec.kind === 'len' ? (sizing === 'relative' ? spec.relDef : spec.def) : spec.def,
                  unit: spec.kind === 'len' ? (sizing === 'relative' ? '×mount radius' : 'm') : spec.unit ?? '',
                }),
              ];
            })
          ),
        })),
        duties: Object.fromEntries(
          Object.entries(DUTIES).map(([id, d]) => [
            id,
            { description: d.blurb, parameters: Object.keys(DUTY_PARAMS[id] ?? {}) },
          ])
        ),
      };
    },

    /* ── Reference geometry ─────────────────────────────────── */

    async search_reference_models(input = {}) {
      const query = String(input.query || '').trim();
      if (!query) return { ok: false, error: 'A search query is required.' };
      try {
        const out = await app.searchModels(query, Math.min(24, Math.max(1, input.limit ?? 8)));
        return {
          ok: true,
          query: out.query,
          count: out.results.length,
          results: out.results.map((r) => ({
            provider: r.provider, id: r.id, name: r.name,
            license: r.license, author: r.author, tags: r.tags,
          })),
          failures: out.failures,
          note: out.results.length
            ? 'Pass provider and id to load_reference_model.'
            : 'Nothing matched. The catalogue is general-purpose props — try a plainer, more common noun.',
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async load_reference_model(input = {}) {
      const { provider, id } = input;
      if (!provider || !id) return { ok: false, error: 'provider and id are required.' };
      try {
        const resolved = await app.resolveModel(provider, id);
        const out = await app.loadReference(resolved.proxied, {
          name: input.name ?? id,
          size: input.size,
          include: resolved.include,
          provider,
          sourceId: id,
        });
        return pretty({
          ok: true,
          loaded: input.name ?? id,
          triangles: out.stats.triangles,
          meshes: out.stats.meshes,
          format: out.stats.format,
          analysed: false,
          note: 'Reference geometry: present in the scene for scale and context, excluded from mass, centre of gravity and every margin check.',
        });
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** Search and load in one step — what "get me a chair" actually means. */
    async find_reference_model(input = {}) {
      const query = String(input.query || '').trim();
      if (!query) return { ok: false, error: 'A search query is required.' };

      let found;
      try {
        found = await app.searchModels(query, 6);
      } catch (err) {
        return { ok: false, error: `Search failed — ${err.message}` };
      }

      const CATALOGUE = 'The catalogue is a CC0 props library — furniture, containers, tools, plants, everyday objects. It has no film props, characters or aerospace parts, and nothing here generates geometry from a description.';

      if (!found.results.length) {
        return {
          ok: false,
          query,
          error: `Nothing in the catalogue matches "${query}".`,
          note: `${CATALOGUE} Try a plainer noun for something that would exist in a workshop.`,
        };
      }

      // A weak match is worse than none: loading a "Large Iron Gate" for
      // "iron man suit" and announcing it as a success is actively misleading.
      if (!found.confident) {
        return {
          ok: false,
          query,
          error: `No good match for "${query}" — the closest entries only share a word with it.`,
          nearest: found.results.slice(0, 4).map((r) => r.name),
          note: `${CATALOGUE} Nothing was loaded. If one of the near misses is actually what you want, load it by name.`,
        };
      }

      const best = found.results[0];
      try {
        const resolved = await app.resolveModel(best.provider, best.id);
        const out = await app.loadReference(resolved.proxied, {
          name: best.name,
          license: best.license,
          author: best.author,
          include: resolved.include,
          size: input.size,
          provider: best.provider,
          sourceId: best.id,
        });
        return pretty({
          ok: true,
          query,
          loaded: best.name,
          license: `${best.license}, ${best.author}`,
          triangles: out.stats.triangles,
          alternatives: found.results.slice(1, 5).map((r) => ({ id: r.id, name: r.name, provider: r.provider })),
          analysed: false,
          note: 'Reference geometry — excluded from mass, centre of gravity and every margin check.',
        });
      } catch (err) {
        return { ok: false, error: `Found "${best.name}" but could not load it — ${err.message}` };
      }
    },

    clear_reference_models() {
      const n = app.clearReferences();
      return { ok: true, removed: n };
    },

    set_room(input = {}) {
      app.setRoomGrade(input);
      return { ok: true, grade: pretty(app.getRoomGrade()) };
    },
  };

  /* ── shared helpers ───────────────────────────────────────── */

  const isDeictic = (raw) => DEICTIC.has(String(raw ?? '').trim().toLowerCase());

  /** A miss on a deictic reference means "nothing selected", not "no such part". */
  const unresolved = (raw) =>
    isDeictic(raw)
      ? 'Nothing is selected — ask the operator to point at a component, or name it.'
      : `Unknown component "${raw}".`;

  /** Same, but restricted to custom parts — stock ones can't be edited. */
  function resolveCustomPart(raw) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (DEICTIC.has(key)) {
      return store.ui.selected ? store.getCustomPart(store.ui.selected) : null;
    }
    return store.findCustomPart(raw);
  }

  /**
   * Accept a stock id, a custom id, a custom part's name, or a deictic
   * reference to whatever the operator currently has selected.
   *
   * That last case is the point of the reticle: once you have pointed at a
   * component, "make this thicker" has to mean the thing you are pointing at.
   */
  function resolvePartId(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase();
    if (DEICTIC.has(key)) return store.ui.selected ?? null;
    if (PART_IDS.includes(raw)) return raw;
    return store.findCustomPart(raw)?.id ?? null;
  }

  /** Map the flat tool input onto a part definition patch. */
  function seedFromInput(input, base) {
    const seed = { ...base };
    for (const key of ['name', 'form', 'mount', 'sizing', 'material', 'duty', 'offsetY', 'rotation', 'cooled', 'loadShare', 'pressureFraction', 'rpm', 'flowShare']) {
      if (input[key] !== undefined) seed[key] = input[key];
    }
    // A different form renames the dimensions outright, so the old values
    // cannot carry over — start from the new form's defaults.
    const baseDims =
      input.form && input.form !== base.form
        ? defaultDims(seed.form, seed.sizing)
        : base.dims;
    seed.dims = { ...baseDims, ...(input.dimensions ?? {}) };
    return seed;
  }

  function assemblySummary() {
    const checks = app.getChecks();
    const perf = app.getPerformance();
    if (!checks) return {};
    return {
      engineDryMass_kg: checks.mass,
      customMass_kg: checks.custom?.mass ?? 0,
      totalDryMass_kg: checks.custom?.count ? checks.custom.totalMass : checks.mass,
      centreOfGravityShift_mm: (checks.custom?.centroidShift ?? 0) * 1000,
      thrustToWeight: checks.custom?.count
        ? checks.custom.thrustToWeight
        : perf.thrust / (checks.mass * 9.80665),
      partsOutOfMargin: (checks.custom?.failing ?? []).map((s) => s.name),
    };
  }

  /** Everything the agent needs after authoring or editing a part. */
  function reportPart(id, verb) {
    const def = store.getCustomPart(id);
    const s = app.getCustomStats(id);
    return {
      part: pretty({
        id: def.id,
        name: def.name,
        form: def.form,
        formLabel: FORMS[def.form].label,
        mount: def.mount,
        sizing: def.sizing,
        material: def.material,
        duty: def.duty,
        dimensions: pretty(def.dims),
      }),
      resolvedDimensions_m: s ? pretty(s.dims) : undefined,
      check: s
        ? pretty({
            mass_kg: s.mass,
            state: s.state,
            summary: s.headline,
            ...Object.fromEntries(s.rows.map((r) => [r.k, r.v])),
            issue: s.note ?? undefined,
          })
        : undefined,
      assembly: pretty(assemblySummary()),
      note: `${verb} "${def.name}".`,
    };
  }

  /**
   * Async because the model-search tools go to the network. Everything else
   * resolves immediately, so callers can await uniformly without cost.
   */
  async function execute(name, input) {
    const fn = handlers[name];
    if (!fn) return { ok: false, error: `No such tool "${name}".` };
    try {
      return await fn(input || {});
    } catch (err) {
      console.error(`[toolbox] ${name} failed`, err);
      return { ok: false, error: String(err?.message || err) };
    }
  }

  return { definitions: TOOL_DEFINITIONS, execute, handlers, PART_IDS };
}
