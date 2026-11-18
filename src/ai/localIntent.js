/* ───────────────────────────────────────────────────────────────
   Offline intent engine.

   Runs whenever no ANTHROPIC_API_KEY is present so the console is
   useful from the first launch. Same toolbox as the Claude path, so
   swapping the key in changes reasoning quality, not capability.
   ─────────────────────────────────────────────────────────────── */

import { PRESETS, VIEWS } from '../state/store.js';
import { FORMS } from '../model/forms.js';
import { MOUNTS } from '../model/customPart.js';

/** Words that should land on a form, beyond the form id itself. */
const FORM_ALIASES = {
  ring: ['ring', 'flange', 'stiffener', 'collar'],
  shell: ['shell', 'skirt', 'extension', 'cone', 'barrel', 'liner'],
  dome: ['dome', 'bulkhead', 'closure', 'cap'],
  plate: ['plate', 'faceplate', 'baffle', 'orifice'],
  manifold: ['manifold', 'torus', 'collector'],
  pods: ['pod', 'pods', 'bottle', 'bay', 'housing'],
  truss: ['truss', 'strut', 'struts', 'thrust structure', 'mount'],
  impeller: ['impeller', 'rotor', 'turbine wheel', 'disc', 'disk', 'wheel'],
  vanes: ['vane', 'vanes', 'fin', 'fins', 'blade set'],
  coil: ['coil', 'helix', 'heat exchanger', 'spiral'],
};

const DUTY_ALIASES = {
  structure: ['load path', 'structural', 'load bearing'],
  pressure: ['pressure vessel', 'pressurised', 'pressurized'],
  hotgas: ['hot gas', 'hot-gas', 'gas path'],
  rotating: ['rotating', 'spinning'],
  plumbing: ['fluid line', 'plumbing', 'flow line'],
  inert: ['inert'],
};

const MOUNT_ALIASES = {
  injector: ['injector', 'dome', 'head'],
  pump: ['pump', 'powerhead', 'turbopump'],
  chamber: ['chamber', 'barrel'],
  throat: ['throat'],
  bell: ['bell', 'divergent', 'mid-bell'],
  exit: ['exit', 'lip', 'nozzle exit', 'skirt'],
  origin: ['centreline', 'centerline', 'free'],
};

const PART_ALIASES = {
  nozzle: ['nozzle', 'bell', 'skirt', 'divergent', 'diverging'],
  throat: ['throat'],
  chamber: ['chamber', 'combustion chamber', 'barrel'],
  injector: ['injector', 'head', 'faceplate', 'dome'],
  cooling: ['cooling', 'jacket', 'regen', 'channels', 'tubes'],
  gimbal: ['gimbal', 'actuator', 'tvc'],
  turbopump: ['turbopump', 'pump', 'turbine', 'powerhead'],
  feedlines: ['feedline', 'feed line', 'plumbing', 'lines', 'duct'],
  igniter: ['igniter', 'torch', 'ignition'],
  manifold: ['manifold', 'collector', 'downcomer'],
};

const PARAM_ALIASES = [
  [/\b(expansion|area)\s*ratio\b|\bepsilon\b|\bε\b/i, 'expansionRatio'],
  [/\bthroat\s*(radius|rad)\b/i, 'throatRadius'],
  [/\bthroat\s*diameter\b/i, 'throatDiameter'],
  [/\b(chamber\s*pressure|pc)\b/i, 'chamberPressure'],
  [/\bchamber\s*length\b/i, 'chamberLength'],
  [/\bcontraction\s*ratio\b/i, 'contractionRatio'],
  [/\bbell\s*(length|percent|%)\b/i, 'bellPercent'],
  [/\b(cooling\s*)?channels?\b/i, 'coolingChannels'],
  [/\bwall\s*(thickness)?\b/i, 'wallThickness'],
  [/\bgimbal\s*(angle|deflection)?\b/i, 'gimbalAngle'],
  [/\b(altitude|alt)\b/i, 'altitude'],
  [/\bthrottle\b/i, 'throttle'],
];

const PROPELLANT_ALIASES = {
  kerolox: ['kerolox', 'rp-1', 'rp1', 'kerosene'],
  methalox: ['methalox', 'methane', 'ch4'],
  hydrolox: ['hydrolox', 'hydrogen', 'lh2'],
  hypergol: ['hypergol', 'hypergolic', 'n2o4', 'mmh', 'storable'],
};

const MATERIAL_ALIASES = {
  inconel718: ['inconel'],
  grcop42: ['grcop', 'copper'],
  cSiC: ['c/sic', 'csic', 'ceramic', 'composite'],
  nb_c103: ['niobium', 'c-103', 'c103'],
};

/** Pull a number out of the text, honouring common engineering units. */
function extractNumber(text, key) {
  const m = text.match(/(-?\d+(?:\.\d+)?)\s*(mpa|bar|psi|kpa|pa|km|cm|mm|m\b|%|deg|°)?/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();

  if (key === 'chamberPressure') {
    if (unit === 'mpa' || !unit) v = unit ? v * 1e6 : (v < 100 ? v * 1e6 : v);
    else if (unit === 'bar') v *= 1e5;
    else if (unit === 'psi') v *= 6894.76;
    else if (unit === 'kpa') v *= 1e3;
  } else if (key === 'altitude') {
    if (unit === 'km') v *= 1000;
  } else if (key === 'throatRadius' || key === 'throatDiameter' || key === 'chamberLength') {
    if (unit === 'cm') v /= 100;
    else if (unit === 'mm') v /= 1000;
  } else if (key === 'throttle' || key === 'explode') {
    if (unit === '%' || v > 1.001) v /= 100;
  } else if (key === 'bellPercent') {
    if (v <= 1) v *= 100;
  }
  return v;
}

function findPart(text) {
  for (const [id, words] of Object.entries(PART_ALIASES)) {
    if (words.some((w) => text.includes(w))) return id;
  }
  return null;
}

/**
 * Longest matching alias wins, not the first one declared. "strut ring"
 * has to reach `truss` even though `ring` is a shorter alias that also
 * matches and happens to be declared earlier.
 */
/* ── Reference-model requests ──────────────────────────────────
   "generate an iron man suit model", "get me a chair", "load a 3d model
   of an oil drum". Pull out the thing being asked for, so it can go to
   the catalogue search. Everything structural — the verb, articles,
   filler and the word "model" itself — is stripped; what's left is the
   noun phrase.                                                        */

const FETCH_VERB =
  /\b(find|search for|search|look up|get|fetch|load|import|bring up|bring me|pull up|show me|give me|generate|make me|add|place|drop in|put in)\b/;

const MODEL_WORD = /\b(3d\s*)?(models?|meshes|mesh|assets?|objects?)\b/;

const NOISE =
  /\b(a|an|the|some|me|my|please|of|for|into|in|to|on|onto|scene|here|now|next|and|then|it|one|3d)\b/g;

function modelSubject(text) {
  // Needs a fetch verb, and either the word "model" or an explicit 3D cue —
  // otherwise "show me the throat" would be read as a catalogue request.
  const hasVerb = FETCH_VERB.test(text);
  const hasModelWord = MODEL_WORD.test(text);
  if (!hasVerb || !hasModelWord) return null;

  // Take everything after the last fetch verb, so a compound instruction
  // ("clear the canvas and generate an X model") keeps only the request.
  let tail = text;
  let m;
  const global = new RegExp(FETCH_VERB.source, 'g');
  while ((m = global.exec(text)) !== null) tail = text.slice(m.index + m[0].length);

  const cleaned = tail
    .replace(MODEL_WORD, ' ')
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length >= 2 ? cleaned : null;
}

function findKey(map, text) {
  let best = null;
  let bestLen = 0;
  for (const [id, words] of Object.entries(map)) {
    for (const w of words) {
      if (text.includes(w) && w.length > bestLen) {
        best = id;
        bestLen = w.length;
      }
    }
  }
  return best;
}

const HELP = `Local intent engine — no API key loaded, so I'm pattern-matching rather than reasoning.

What I understand:
  explode 60%           assemble          cutaway / section on|off
  isolate               show the throat   view nozzle | front | side | iso | top
  expansion ratio 40    throat radius 0.15 m   chamber pressure 12 MPa
  altitude 25 km        propellant methalox    contour conical|parabolic|aerospike
  channels 56           wall 0.09         gimbal 4 deg
  preset vacuum         static fire 8 s   throttle 70%
  analyse               reset             grid off
  hide the panels       show the ui       cinematic

Custom parts:
  new flange at the chamber      add a truss at the injector
  new nozzle extension at exit   add vanes at the throat
  list parts                     delete part <name>

  Forms: ${Object.keys(FORMS).join(', ')}
  Mounts: ${Object.keys(MOUNTS).join(', ')}

Pointing at something first — click it, or aim a finger at it on camera —
lets you say "this" instead of naming it:
  what is this          make this niobium       delete it
  move this to the exit

Reference models — searches a CC0 props catalogue and imports the closest
match. Never analysed, never massed:
  load a model of an oil drum      get me a chair model
  find a 3d model of a crate       clear the canvas

Drop ANTHROPIC_API_KEY into .env and restart to hand the workbench to Claude.`;

/**
 * @returns {{reply: string, calls: {name: string, input: object}[]}}
 */
export function parseIntent(raw, { store, app }) {
  const text = raw.toLowerCase().trim();
  const calls = [];
  let reply = null;

  if (/^(help|\?|commands)$/.test(text)) return { reply: HELP, calls };

  /* Display -------------------------------------------------- */
  if (/\b(assemble|reassemble|collapse|put (it )?back together)\b/.test(text)) {
    calls.push({ name: 'set_view', input: { explode: 0 } });
  } else if (/\bexplode|blow (it )?apart|pull apart|apart\b/.test(text)) {
    const v = extractNumber(text, 'explode');
    calls.push({ name: 'set_view', input: { explode: v === null ? 1 : Math.min(1, Math.max(0, v)) } });
  }

  if (/\b(cutaway|section|cross[- ]?section|cut it|slice)\b/.test(text)) {
    calls.push({ name: 'set_view', input: { cutaway: !/\b(off|no|stop|close)\b/.test(text) } });
  }
  if (/\bisolate|only show|just the\b/.test(text)) {
    calls.push({ name: 'set_view', input: { isolate: !/\b(off|no|stop)\b/.test(text) } });
  }
  if (/\bgrid\b/.test(text)) {
    calls.push({ name: 'set_view', input: { grid: !/\b(off|hide|no)\b/.test(text) } });
  }

  // Getting the interface out of the way.
  if (/\b(cinematic|immersive|presentation|hologram only|just the (model|hologram|engine))\b/.test(text)) {
    calls.push({ name: 'set_view', input: { focus: 'bare' } });
  } else if (/\b(hide|close|clear|dismiss|remove|disable)\b.*\b(ui|menus?|panels?|interface|chrome|hud)\b/.test(text)) {
    calls.push({ name: 'set_view', input: { focus: /\ball\b|\beverything\b/.test(text) ? 'bare' : 'clear' } });
  } else if (/\b(show|restore|bring back|reopen|enable)\b.*\b(ui|menus?|panels?|interface|chrome|hud)\b/.test(text)) {
    calls.push({ name: 'set_view', input: { focus: 'full' } });
  }

  const viewMatch = Object.keys(VIEWS).find((v) => new RegExp(`\\b${v}\\b`).test(text));
  if (viewMatch && /\b(view|camera|look|show me|orbit|go to)\b/.test(text)) {
    calls.push({ name: 'set_view', input: { preset: viewMatch } });
  }

  /* Subject vs destination ----------------------------------- */
  // "move this to the bell" — the bell is where it goes, not what is being
  // moved. Several mount names are also stock-component aliases, so the
  // trailing prepositional phrase has to be split off before anything else
  // reads the sentence, or the destination gets mistaken for the subject.
  const destMatch = text.match(/\b(?:to|onto|at|on|near|around)\s+(?:the\s+)?([a-z\s-]+?)\s*$/);
  const destination = destMatch ? findKey(MOUNT_ALIASES, destMatch[1]) : null;
  const subject = destination ? text.slice(0, destMatch.index) : text;

  /* Selection ------------------------------------------------ */
  const part = findPart(subject);
  if (part && /\b(select|show|inspect|look at|focus|what.?s|tell me about|explain|highlight)\b/.test(text)) {
    calls.push({ name: 'select_part', input: { part } });
  }

  /* Deictic reference to whatever is selected ----------------- */
  // "what is this", "delete it", "make this niobium" — the reticle or a click
  // already established what "this" means, so honour it.
  const deictic = /\b(this|that|it|selected|selection)\b/.test(subject);
  if (deictic && !part) {
    const sel = store.ui.selected;
    if (!sel) {
      reply = 'Nothing is selected. Point at a component and hold, or click one, then try again.';
      return { reply, calls };
    }
    if (/\b(delete|remove|scrap|bin|get rid)\b/.test(text)) {
      calls.push({ name: 'delete_part', input: { part: 'selected' } });
    } else if (/\b(what|explain|tell me|describe|why|how)\b/.test(text)) {
      calls.push({ name: 'select_part', input: { part: 'selected' } });
    } else {
      const mat = findKey(MATERIAL_ALIASES, subject);
      const duty = findKey(DUTY_ALIASES, subject);
      const patch = {};
      if (mat) patch.material = mat;
      if (duty) patch.duty = duty;
      if (destination) patch.mount = destination;
      if (Object.keys(patch).length) {
        calls.push({ name: 'modify_part', input: { part: 'selected', ...patch } });
      }
    }
  }

  /* Presets -------------------------------------------------- */
  const presetKey = Object.keys(PRESETS).find((k) => text.includes(k));
  if (presetKey && /\b(preset|load|configure|switch to|make it a?)\b/.test(text)) {
    calls.push({ name: 'apply_preset', input: { name: presetKey } });
  }

  /* Parameters ----------------------------------------------- */
  const patch = {};
  for (const [re, key] of PARAM_ALIASES) {
    if (!re.test(text)) continue;
    const idx = text.search(re);
    const tail = text.slice(idx);
    const v = extractNumber(tail.replace(re, ''), key === 'throatDiameter' ? 'throatRadius' : key);
    if (v === null) continue;
    if (key === 'throatDiameter') patch.throatRadius = v / 2;
    else patch[key] = v;
  }

  const prop = findKey(PROPELLANT_ALIASES, text);
  if (prop) patch.propellant = prop;
  const mat = findKey(MATERIAL_ALIASES, text);
  if (mat && /\b(material|wall|made of|alloy)\b/.test(text)) patch.material = mat;

  if (/\bconical\b/.test(text)) patch.bellType = 'conical';
  else if (/\baerospike|plug nozzle\b/.test(text)) patch.bellType = 'aerospike';
  else if (/\bparabolic|rao|bell contour\b/.test(text)) patch.bellType = 'parabolic';

  if (Object.keys(patch).length) calls.push({ name: 'set_parameters', input: patch });

  /* Firing --------------------------------------------------- */
  if (/\b(fire|burn|ignite|light it|static fire|hot fire)\b/.test(text)) {
    const secMatch = text.match(/(\d+(?:\.\d+)?)\s*(s|sec|second)/);
    const throttleMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
    calls.push({
      name: 'fire_engine',
      input: {
        seconds: secMatch ? parseFloat(secMatch[1]) : 6,
        throttle: throttleMatch ? parseFloat(throttleMatch[1]) / 100 : (patch.throttle ?? 1),
      },
    });
  }

  /* Custom parts --------------------------------------------- */
  if (/\b(list|show|what)\b.*\bparts?\b/.test(text)) {
    calls.push({ name: 'list_parts', input: {} });
  } else if (/\b(delete|remove|scrap|bin)\b/.test(text) && /\bpart\b/.test(text)) {
    const target = text.replace(/.*\bpart\b\s*/, '').trim();
    calls.push({ name: 'delete_part', input: { part: target } });
  } else if (/\b(new|add|create|make|build|design)\b/.test(text)) {
    // Match the form against the subject only — the destination has already
    // been split off, so "at the exit" can't be read as the form.
    const form = findKey(FORM_ALIASES, subject) ?? Object.keys(FORMS).find((f) => subject.includes(f)) ?? null;
    if (form) {
      const input = { form };
      if (destination) input.mount = destination;
      calls.push({ name: 'create_part', input });
    }
  }

  /* Reference models ----------------------------------------- */
  // Clearing the scene of imported geometry. Checked before the fetch verbs
  // so "clear the canvas and get me an X" resolves both halves.
  if (/\b(clear|empty|wipe|reset|remove)\b[^.]*\b(canvas|scene|models?|references?|imports?|everything)\b/.test(text)) {
    calls.push({ name: 'clear_reference_models', input: {} });
  }

  const wanted = modelSubject(text);
  if (wanted) {
    calls.push({ name: 'find_reference_model', input: { query: wanted } });
  }

  /* Analysis / misc ------------------------------------------ */
  if (/\b(analy[sz]e|analysis|report|status|performance|how much thrust|numbers|readout)\b/.test(text)) {
    calls.push({ name: 'run_analysis', input: {} });
  }
  if (/\breset|start over|baseline\b/.test(text)) {
    calls.push({ name: 'reset_design', input: {} });
  }
  if (/\b(amber|ion|alert|cyan)\b/.test(text) && /\b(palette|theme|colou?r)\b/.test(text)) {
    const theme = ['amber', 'ion', 'alert', 'cyan'].find((t) => text.includes(t));
    calls.push({ name: 'set_palette', input: { theme } });
  }

  if (!calls.length) {
    reply = noMatchAdvice(text);
  }

  void app;
  return { reply, calls };
}

/**
 * A failed match should say something more useful than "no pattern matched".
 * The local engine is a pattern matcher, not a reasoner, so when it misses,
 * the honest thing is to name what it *can* do with the words it saw.
 */
function noMatchAdvice(text) {
  const base =
    'This is the offline pattern matcher, not Claude — add ANTHROPIC_API_KEY to .env and restart to hand it over.';

  if (/\b(generate|create|build|design|model)\b/.test(text)) {
    return (
      `Nothing here generates geometry from a description. Two things come close:\n` +
      `  • \`new <form> at the <mount>\` builds real parametric hardware — ${Object.keys(FORMS).join(', ')}.\n` +
      `  • \`load a model of <thing>\` searches a CC0 props catalogue and imports the closest match as reference geometry.\n` +
      `The catalogue is furniture, containers, tools and everyday objects — no film props, characters or aerospace parts.\n${base}`
    );
  }
  if (/\b(rotate|spin|zoom|move|pan|look)\b/.test(text)) {
    return `Camera moves are mouse or gesture, not typed. Drag to orbit, scroll to zoom, or use \`view nozzle|front|side|iso|top\`.\n${base}`;
  }
  if (/\b(colou?r|theme|dark|light|bright)\b/.test(text)) {
    return `Try \`palette amber|ion|alert|cyan\`, or \`hide the panels\` to clear the interface.\n${base}`;
  }
  return `No pattern matched. Type \`help\` for the full local command set.\n${base}`;
}

/** Turn a raw tool result into one line of console feedback. */
export function summariseResult(name, input, result) {
  if (result?.ok === false) {
    // A near-miss is a real answer, not a failure to report as one.
    if (result.nearest?.length) {
      return `${result.error} Closest: ${result.nearest.join(', ')}. ${result.note}`;
    }
    return result.note ? `${result.error} ${result.note}` : `${name} failed — ${result.error}`;
  }

  switch (name) {
    case 'set_parameters': {
      const parts = Object.entries(result.applied || {}).map(([k, v]) => `${k} = ${v}`);
      const clamped = result.clampedKeys?.length ? ` (clamped: ${result.clampedKeys.join(', ')})` : '';
      const perf = result.performanceNow;
      return `${parts.join(', ')}${clamped}. Now ${perf.thrust_kN} kN @ Isp ${perf.isp_s} s${perf.separated ? ' — FLOW SEPARATED' : ''}.`;
    }
    case 'run_analysis':
      return `Thrust ${result.thrust_kN} kN (vac ${result.thrustVac_kN} kN) · Isp ${result.isp_s} s (vac ${result.ispVac_s} s) · Me ${result.exitMach} · Pe/Pa ${result.pressureRatio_PeOverPa}${result.flowSeparated ? ' · SEPARATED' : ''} · coolant ${(result.coolantUtilisation * 100).toFixed(0)}% · margin ${result.structuralMargin}×`;
    case 'select_part':
      return result.selected ? `Selected ${result.info.label}. ${result.info.role}` : 'Selection cleared.';
    case 'set_view':
      return `Display: ${result.applied.join(', ')}.`;
    case 'apply_preset':
      return `Loaded ${result.preset}. ${result.note} → ${result.performanceNow.thrust_kN} kN, Isp ${result.performanceNow.isp_s} s.`;
    case 'fire_engine':
      return `Static fire ${result.seconds}s @ ${(result.throttle * 100).toFixed(0)}% — ${result.thrustAtThrottle_kN} kN, ${result.propellantConsumed_kg} kg consumed. ${result.note}`;
    case 'annotate_part':
      return `Pinned a note to ${result.part}.`;
    case 'reset_design':
      return result.note;
    case 'set_palette':
      return `Palette → ${result.theme}.`;
    case 'get_design_state':
      return `Read design state: ${result.performance.thrust_kN} kN, Isp ${result.performance.isp_s} s.`;
    case 'create_part':
    case 'modify_part': {
      const p = result.part;
      const c = result.check;
      return `${result.note} ${p.formLabel} at the ${p.mount}, ${p.material}, ${p.duty} duty — ${c?.summary ?? '—'}${c?.issue ? ` · ${c.issue}` : ''}`;
    }
    case 'delete_part':
      return `Deleted ${result.deleted}. ${result.remainingCustomParts} custom part${result.remainingCustomParts === 1 ? '' : 's'} left, dry mass ${result.dryMassNow_kg} kg.`;
    case 'list_parts': {
      if (!result.custom.length) return `10 stock components, no custom parts yet.`;
      const lines = result.custom.map((p) => `  ${p.id}  ${p.name} — ${p.form} · ${p.check}${p.state === 'ok' ? '' : `  [${p.state}]`}`);
      return `10 stock components plus:\n${lines.join('\n')}\nTotal dry mass ${result.assembly.totalDryMass_kg} kg, T/W ${result.assembly.thrustToWeight}.`;
    }
    case 'list_part_forms':
      return `${result.forms.length} form${result.forms.length === 1 ? '' : 's'}: ${result.forms.map((f) => f.form).join(', ')}.`;
    case 'find_reference_model': {
      const alts = result.alternatives?.length
        ? ` Also matched: ${result.alternatives.map((a) => a.name).join(', ')}.`
        : '';
      return `Loaded ${result.loaded} for "${result.query}" — ${result.triangles.toLocaleString()} triangles, ${result.license}.${alts} ${result.note}`;
    }
    case 'search_reference_models':
      return result.count
        ? `${result.count} match${result.count === 1 ? '' : 'es'}: ${result.results.map((r) => r.name).join(', ')}.`
        : result.note;
    case 'load_reference_model':
      return `Loaded ${result.loaded} — ${result.triangles.toLocaleString()} triangles. ${result.note}`;
    case 'clear_reference_models':
      return result.removed
        ? `Removed ${result.removed} imported model${result.removed === 1 ? '' : 's'}. The engine is untouched.`
        : 'No imported models to clear.';
    case 'set_room':
      return `Room grade: ${Math.round(result.grade.exposure * 100)}% brightness, saturation ${result.grade.saturation}.`;
    default:
      return `${name} ok.`;
  }
}
