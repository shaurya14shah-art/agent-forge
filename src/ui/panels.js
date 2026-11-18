/* ───────────────────────────────────────────────────────────────
   Panel content: parameters, live analysis, component inspector.

   Panels are built once and updated by writing to cached nodes. The
   previous version rebuilt `innerHTML` on every solve, which threw away
   scroll position, killed transitions, and dropped focus mid-drag —
   the solve runs on every slider frame, so that mattered.

   Placement and 3D framing are handled by core/hud3d.js.
   ─────────────────────────────────────────────────────────────── */

import { PARAM_SPEC, ENUM_SPEC, PRESETS, VIEWS } from '../state/store.js';
import { PROPELLANTS, MATERIALS } from '../model/physics.js';
import { PART_INFO } from '../model/thruster.js';
import { FORMS } from '../model/forms.js';
import { createThrustCurve, createContourPlot, createMeter } from './charts.js';

const PARAM_GROUPS = [
  { title: 'Throat & expansion', keys: ['throatRadius', 'expansionRatio', 'chamberPressure'] },
  { title: 'Chamber', keys: ['contractionRatio', 'chamberLength', 'wallThickness', 'coolingChannels'] },
  { title: 'Bell', keys: ['bellPercent'] },
  { title: 'Operating point', keys: ['altitude', 'gimbalAngle'] },
];

const PRESET_NAMES = {
  booster: 'Sea-level booster',
  vacuum: 'Vacuum stage',
  methalox: 'Full-flow methalox',
  aerospike: 'Aerospike',
  rcs: 'RCS pod',
};

const CONTOUR_NAMES = { parabolic: 'Rao bell', conical: 'Conical', aerospike: 'Aerospike' };

const PROP_SUB = {
  kerolox: 'dense · 3670 K',
  methalox: 'deep throttle',
  hydrolox: 'highest Isp',
  hypergol: 'storable',
};
const MAT_SUB = {
  inconel718: 'strong · low k',
  grcop42: 'high k liner',
  cSiC: 'radiative',
  nb_c103: '1400 K',
};

function fmt(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function trimNumber(v, step) {
  const decimals = step >= 1 ? 0 : String(step).split('.')[1]?.length ?? 2;
  return Number(v).toFixed(decimals);
}

function displayValue(key, value) {
  const spec = PARAM_SPEC[key];
  if (!spec) return { text: String(value), unit: '' };
  return {
    text: spec.display ? spec.display(value) : trimNumber(value, spec.step),
    unit: spec.displayUnit ?? spec.unit,
  };
}

/** Small helper: a labelled row whose value node is returned for updating. */
function addRow(host, label) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="k"></span><span class="v"></span>`;
  row.querySelector('.k').textContent = label;
  host.appendChild(row);
  return row.querySelector('.v');
}

function setValue(node, text, unit, state) {
  node.textContent = text;
  if (unit) {
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = unit;
    node.appendChild(u);
  }
  node.className = `v${state ? ` ${state}` : ''}`;
}

export function createPanels({ hud, store, onPreset, onFire, onView, onNewPart, onEditPart }) {
  /* ═══ Parameters ═══════════════════════════════════════════ */
  const paramsPanel = hud.panel('params', { anchor: 'left', title: 'Design', tag: '' });
  paramsPanel.body.classList.add('scroll');

  const controls = new Map();
  const P = paramsPanel.body;

  // — Presets
  P.insertAdjacentHTML('beforeend', `<div class="sect">Start from</div>`);
  const presetHost = document.createElement('div');
  presetHost.className = 'grid-2';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.dataset.preset = key;
    b.title = preset.note;
    b.innerHTML = `${PRESET_NAMES[key] ?? preset.label}`;
    b.addEventListener('click', () => onPreset?.(key));
    presetHost.appendChild(b);
  }
  P.appendChild(presetHost);

  // — Live contour preview: the shape the parameters are producing
  P.insertAdjacentHTML('beforeend', `<div class="sect">Wall contour</div>`);
  const contourHost = document.createElement('div');
  contourHost.className = 'chart-host';
  P.appendChild(contourHost);
  const contourPlot = createContourPlot(contourHost);

  const contourSeg = document.createElement('div');
  contourSeg.className = 'seg';
  contourSeg.dataset.enum = 'bellType';
  for (const option of ENUM_SPEC.bellType.options) {
    const b = document.createElement('button');
    b.dataset.value = option;
    b.textContent = CONTOUR_NAMES[option] ?? option;
    b.addEventListener('click', () => store.set('bellType', option));
    contourSeg.appendChild(b);
  }
  P.appendChild(contourSeg);

  // — Propellant / material
  const enumGrid = (key, subs, labelOf) => {
    const host = document.createElement('div');
    host.className = 'grid-2';
    host.dataset.enum = key;
    for (const option of ENUM_SPEC[key].options) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.dataset.value = option;
      b.innerHTML = `${labelOf(option)}<span class="btn-sub">${subs[option] ?? ''}</span>`;
      b.addEventListener('click', () => store.set(key, option));
      host.appendChild(b);
    }
    return host;
  };

  P.insertAdjacentHTML('beforeend', `<div class="sect">Propellant</div>`);
  P.appendChild(enumGrid('propellant', PROP_SUB, (o) => PROPELLANTS[o].label));

  P.insertAdjacentHTML('beforeend', `<div class="sect">Hot-wall liner</div>`);
  P.appendChild(enumGrid('material', MAT_SUB, (o) => MATERIALS[o].label));

  // — Grouped sliders
  for (const group of PARAM_GROUPS) {
    P.insertAdjacentHTML('beforeend', `<div class="sect">${group.title}</div>`);
    for (const key of group.keys) {
      const spec = PARAM_SPEC[key];
      if (!spec) continue;
      const wrap = document.createElement('div');
      wrap.className = 'ctl';
      wrap.innerHTML = `
        <div class="ctl-top"><label for="p-${key}"></label><output></output></div>
        <input id="p-${key}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" />
      `;
      wrap.querySelector('label').textContent = spec.label;
      P.appendChild(wrap);
      const input = wrap.querySelector('input');
      const out = wrap.querySelector('output');
      input.addEventListener('input', () => store.set(key, Number(input.value)));
      controls.set(key, { input, out });
    }
  }

  // — Custom parts
  P.insertAdjacentHTML('beforeend', `<div class="sect">Custom parts</div>`);
  const partListHost = document.createElement('div');
  partListHost.className = 'part-list';
  P.appendChild(partListHost);

  const newPartBtn = document.createElement('button');
  newPartBtn.className = 'btn primary new-part';
  newPartBtn.textContent = 'New part';
  newPartBtn.addEventListener('click', () => onNewPart?.());
  P.appendChild(newPartBtn);

  // — Assembly
  P.insertAdjacentHTML('beforeend', `<div class="sect">Assembly</div>`);
  const assembly = document.createElement('div');
  assembly.innerHTML = `
    <div class="ctl">
      <div class="ctl-top"><label for="p-explode">Exploded view</label><output id="o-explode"></output></div>
      <input id="p-explode" type="range" min="0" max="1" step="0.01" />
    </div>
    <div class="grid-2" style="margin-top:6px">
      <button class="btn" data-toggle="cutaway">Cutaway</button>
      <button class="btn" data-toggle="isolate">Isolate</button>
      <button class="btn" data-toggle="grid">Deck grid</button>
      <button class="btn" data-action="fire">Static fire</button>
    </div>
  `;
  P.appendChild(assembly);

  const explodeInput = assembly.querySelector('#p-explode');
  const explodeOut = assembly.querySelector('#o-explode');
  explodeInput.addEventListener('input', () => store.setUi('explode', Number(explodeInput.value)));
  assembly.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => store.setUi(b.dataset.toggle, !store.ui[b.dataset.toggle]))
  );
  assembly.querySelector('[data-action="fire"]').addEventListener('click', () => onFire?.());

  P.insertAdjacentHTML('beforeend', `<div class="sect">View</div>`);
  const viewSeg = document.createElement('div');
  viewSeg.className = 'seg';
  for (const key of ['iso', 'front', 'side', 'nozzle', 'injector']) {
    const b = document.createElement('button');
    b.textContent = VIEWS[key]?.label ?? key;
    b.addEventListener('click', () => onView?.(key));
    viewSeg.appendChild(b);
  }
  P.appendChild(viewSeg);

  /* ═══ Analysis ═════════════════════════════════════════════ */
  const analysisPanel = hud.panel('analysis', { anchor: 'right', title: 'Analysis', tag: '' });
  analysisPanel.body.classList.add('scroll', 'short');
  const A = analysisPanel.body;

  // — Hero figures
  const hero = document.createElement('div');
  hero.className = 'hero';
  hero.innerHTML = `
    <div>
      <div class="h-label">Thrust</div>
      <div class="h-value" data-f="thrust">—<span class="u">kN</span></div>
      <div class="h-sub" data-f="thrustSub"></div>
    </div>
    <div>
      <div class="h-label">Specific impulse</div>
      <div class="h-value" data-f="isp">—<span class="u">s</span></div>
      <div class="h-sub" data-f="ispSub"></div>
    </div>
  `;
  A.appendChild(hero);
  const heroThrust = hero.querySelector('[data-f="thrust"]');
  const heroThrustSub = hero.querySelector('[data-f="thrustSub"]');
  const heroIsp = hero.querySelector('[data-f="isp"]');
  const heroIspSub = hero.querySelector('[data-f="ispSub"]');

  // — Thrust curve
  A.insertAdjacentHTML('beforeend', `<div class="sect">Thrust vs altitude</div>`);
  const curveHost = document.createElement('div');
  curveHost.className = 'chart-host';
  A.appendChild(curveHost);
  const thrustCurve = createThrustCurve(curveHost);

  // — Nozzle flow
  A.insertAdjacentHTML('beforeend', `<div class="sect">Nozzle flow</div>`);
  const rExpansion = addRow(A, 'Expansion state');
  const rMach = addRow(A, 'Exit Mach');
  const rVe = addRow(A, 'Exit velocity');
  const rPePa = addRow(A, 'Pe / Pa');
  const rMatched = addRow(A, 'Matched at');
  const rMdot = addRow(A, 'Mass flow');
  const rCstar = addRow(A, 'c*');

  // — Margins
  A.insertAdjacentHTML('beforeend', `<div class="sect">Margins</div>`);
  const meterHost = document.createElement('div');
  A.appendChild(meterHost);
  const coolantMeter = createMeter(meterHost, {
    label: 'Regen jacket load',
    threshold: 0.85,
    format: (r) => `${(r * 100).toFixed(0)}% of capacity`,
  });
  const jacketMeter = createMeter(meterHost, {
    label: 'Closeout jacket stress',
    threshold: 1 / 1.5,
    format: () => jacketMeter._text,
  });
  const wallMeter = createMeter(meterHost, {
    label: 'Hot-wall temperature',
    threshold: 1,
    format: () => wallMeter._text,
  });

  // — Envelope
  A.insertAdjacentHTML('beforeend', `<div class="sect">Envelope</div>`);
  const rLength = addRow(A, 'Overall length');
  const rExitDia = addRow(A, 'Exit diameter');
  const rThroatDia = addRow(A, 'Throat diameter');
  const rMass = addRow(A, 'Engine dry mass');
  const rTW = addRow(A, 'Thrust / weight');

  // — Custom hardware. Hidden entirely until something has been authored;
  //   an empty section is worse than no section.
  const customSect = document.createElement('div');
  customSect.className = 'sect';
  customSect.textContent = 'Custom hardware';
  A.appendChild(customSect);
  const customHost = document.createElement('div');
  A.appendChild(customHost);
  const rCustomMass = addRow(customHost, 'Added mass');
  const rTotalMass = addRow(customHost, 'Total dry mass');
  const rCgShift = addRow(customHost, 'CG shift');
  const customBreakdown = document.createElement('div');
  customBreakdown.className = 'part-breakdown';
  customHost.appendChild(customBreakdown);
  customSect.hidden = true;
  customHost.hidden = true;

  // — Flags
  A.insertAdjacentHTML('beforeend', `<div class="sect">Flags</div>`);
  const flagsHost = document.createElement('div');
  flagsHost.className = 'flags';
  A.appendChild(flagsHost);

  /* ═══ Inspector (world-anchored) ═══════════════════════════ */
  const inspectPanel = hud.panel('inspect', {
    anchor: 'world',
    title: 'Component',
    tag: '',
    size: 'small',
    // Dock panels sit at margin 46 and are 306 wide, so their inner edge is at
    // 352 — the keep-out has to clear that, not sit just inside it.
    keepOut: { left: 372, right: 372, bottom: 300 },
  });
  inspectPanel.body.innerHTML = `
    <div class="note" data-f="role"></div>
    <div class="sect" data-f="detailLabel">Why it matters</div>
    <div class="note" data-f="detail"></div>
    <div class="sect" data-f="measuredLabel">Measured</div>
    <div data-f="rows"></div>
    <div class="sect" data-f="annLabel" hidden>Annotation</div>
    <div class="note" data-f="annotation" hidden></div>
  `;
  const insRole = inspectPanel.body.querySelector('[data-f="role"]');
  const insDetail = inspectPanel.body.querySelector('[data-f="detail"]');
  const insRows = inspectPanel.body.querySelector('[data-f="rows"]');
  const insMeasuredLabel = inspectPanel.body.querySelector('[data-f="measuredLabel"]');
  const insAnnLabel = inspectPanel.body.querySelector('[data-f="annLabel"]');
  const insAnn = inspectPanel.body.querySelector('[data-f="annotation"]');
  hud.show('inspect', false);

  /* ═══ Sync ═════════════════════════════════════════════════ */
  function syncParams() {
    for (const [key, { input, out }] of controls) {
      const v = store.params[key];
      if (document.activeElement !== input) input.value = String(v);
      const d = displayValue(key, v);
      out.textContent = d.text;
      if (d.unit) {
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = d.unit;
        out.appendChild(u);
      }
    }
    for (const key of Object.keys(ENUM_SPEC)) {
      P.querySelectorAll(`[data-enum="${key}"] [data-value]`).forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.value === store.params[key]))
      );
    }
  }

  function syncUi() {
    if (document.activeElement !== explodeInput) explodeInput.value = String(store.ui.explode);
    explodeOut.textContent = `${(store.ui.explode * 100).toFixed(0)}%`;
    assembly.querySelectorAll('[data-toggle]').forEach((b) =>
      b.setAttribute('aria-pressed', String(Boolean(store.ui[b.dataset.toggle])))
    );
  }

  /* ═══ Analysis update ══════════════════════════════════════ */
  function renderAnalysis(perf, checks, metrics, contour) {
    heroThrust.textContent = fmt(perf.thrust / 1000, 1);
    heroThrust.appendChild(unit('kN'));
    heroThrustSub.textContent = `${fmt(perf.thrustVac / 1000, 1)} kN vacuum`;

    heroIsp.textContent = fmt(perf.isp, 1);
    heroIsp.appendChild(unit('s'));
    heroIspSub.textContent = `${fmt(perf.ispVac, 1)} s vacuum`;

    thrustCurve.update(perf, store.params.altitude);
    if (contour) contourPlot.update(contour);

    const state = perf.separated
      ? { text: 'Flow separated', cls: 'bad' }
      : perf.overExpanded
      ? { text: 'Over-expanded', cls: 'warn' }
      : perf.Pe > perf.Pa * 1.15
      ? { text: 'Under-expanded', cls: 'warn' }
      : { text: 'Near optimal', cls: 'ok' };
    setValue(rExpansion, state.text, '', state.cls);

    setValue(rMach, fmt(perf.Me, 2), '');
    setValue(rVe, fmt(perf.ve, 0), 'm/s');
    setValue(rPePa, fmt(perf.sepRatio, 2), '');
    setValue(rMatched, fmt(perf.optimalAltitude / 1000, 1), 'km');
    setValue(rMdot, fmt(perf.mdot, 1), 'kg/s');
    setValue(rCstar, fmt(perf.cstar, 0), 'm/s');

    coolantMeter.update(checks.cooling.utilisation);

    // Stress and temperature are shown as fraction-of-limit so all three
    // meters read the same way: full bar means you are at the limit.
    const stressRatio = 1 / Math.max(0.01, checks.structural.margin);
    jacketMeter._text = `${checks.structural.margin.toFixed(2)}× margin`;
    jacketMeter.update(
      stressRatio,
      checks.structural.margin < 1 ? 'bad' : checks.structural.margin < 1.5 ? 'warn' : 'ok'
    );

    const tempRatio = checks.structural.linerTempK / checks.structural.linerLimitK;
    wallMeter._text = `${checks.structural.linerTempK.toFixed(0)} / ${checks.structural.linerLimitK} K`;
    wallMeter.update(tempRatio, tempRatio > 1 ? 'bad' : tempRatio > 0.85 ? 'warn' : 'ok');

    setValue(rLength, fmt(metrics.height, 3), 'm');
    setValue(rExitDia, fmt(metrics.exitDiameter, 3), 'm');
    setValue(rThroatDia, fmt(metrics.throatDiameter * 1000, 0), 'mm');
    setValue(rMass, fmt(checks.mass, 0), 'kg');

    const custom = checks.custom;
    const totalMass = custom?.count ? custom.totalMass : checks.mass;
    setValue(rTW, fmt(perf.thrust / (totalMass * 9.80665), 0), '');

    customSect.hidden = !custom?.count;
    customHost.hidden = !custom?.count;
    if (custom?.count) {
      setValue(rCustomMass, fmt(custom.mass, 1), 'kg');
      setValue(rTotalMass, fmt(totalMass, 0), 'kg');
      setValue(
        rCgShift,
        `${custom.centroidShift >= 0 ? '+' : ''}${fmt(custom.centroidShift * 1000, 0)}`,
        'mm'
      );
      customBreakdown.replaceChildren(
        ...(checks.customStats ?? []).map((s) => {
          const d = document.createElement('div');
          d.className = `part-chip ${s.state}`;
          const n = document.createElement('span');
          n.className = 'part-chip-name';
          n.textContent = s.name;
          const v = document.createElement('span');
          v.className = 'part-chip-val';
          v.textContent = s.headline;
          d.append(n, v);
          return d;
        })
      );
    }

    renderFlags(perf, checks);
    hud.setTag('analysis', PROPELLANTS[store.params.propellant]?.label ?? '');
  }

  function unit(text) {
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = text;
    return u;
  }

  function renderFlags(perf, checks) {
    const flags = [];

    if (perf.separated)
      flags.push([
        'bad',
        `Exit pressure is ${(perf.sepRatio * 100).toFixed(0)}% of ambient. The flow will detach inside the bell and load it sideways — cut expansion ratio or fly higher.`,
      ]);
    if (checks.cooling.utilisation > 1)
      flags.push([
        'bad',
        `Regen jacket is over capacity at ${(checks.cooling.utilisation * 100).toFixed(0)}%. Add channels, drop chamber pressure, or add film cooling.`,
      ]);
    else if (checks.cooling.utilisation > 0.85)
      flags.push(['warn', 'Coolant margin is under 15% at the throat.']);

    if (checks.structural.margin < 1.5)
      flags.push([
        checks.structural.margin < 1 ? 'bad' : 'warn',
        `Closeout jacket has ${checks.structural.margin.toFixed(2)}× on hoop stress at ${(store.params.chamberPressure / 1e6).toFixed(1)} MPa. Thicken the wall or drop chamber pressure.`,
      ]);

    if (!checks.structural.thermalOk)
      flags.push([
        'bad',
        `${checks.structural.materialLabel} hot wall reaches ${checks.structural.linerTempK.toFixed(0)} K against a ${checks.structural.linerLimitK} K limit. Move to a higher-conductivity liner or cut throat heat flux.`,
      ]);
    else if (checks.structural.thermalMargin < 1.2)
      flags.push([
        'warn',
        `Hot wall is within ${((checks.structural.thermalMargin - 1) * 100).toFixed(0)}% of the ${checks.structural.materialLabel} limit.`,
      ]);

    // Custom hardware reports through the same channel as the stock engine —
    // a part you authored yourself is not exempt from its own duty check.
    for (const s of checks.custom?.failing ?? []) {
      flags.push(['bad', `${s.name} (${s.dutyLabel.toLowerCase()}) — ${s.note ?? 'is outside its margin.'}`]);
    }
    for (const s of checks.custom?.marginal ?? []) {
      flags.push(['warn', `${s.name} is marginal: ${s.headline}.`]);
    }

    if (!flags.length) flags.push(['ok', 'All checks within margin at the current operating point.']);

    flagsHost.replaceChildren(
      ...flags.map(([cls, text]) => {
        const d = document.createElement('div');
        d.className = `flag ${cls}`;
        d.textContent = text;
        return d;
      })
    );
  }

  /* ═══ Custom part list ═════════════════════════════════════ */

  /**
   * One row per authored part: what it is, and the one number that
   * decides whether it survives the current operating point.
   */
  function renderCustomParts(defs, statsById, activeId) {
    if (!defs.length) {
      partListHost.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'note part-empty',
          textContent:
            'Nothing authored yet. A custom part is generated from its form and mount, so it re-scales with the engine and gets its own margin check.',
        })
      );
      return;
    }

    partListHost.replaceChildren(
      ...defs.map((def) => {
        const s = statsById?.[def.id];
        const b = document.createElement('button');
        b.className = 'part-row';
        b.dataset.id = def.id;
        b.setAttribute('aria-pressed', String(def.id === activeId));

        const dot = document.createElement('i');
        dot.className = `part-dot ${s?.state ?? 'none'}`;

        const text = document.createElement('span');
        text.className = 'part-text';
        const name = document.createElement('b');
        name.textContent = def.name;
        const sub = document.createElement('span');
        sub.textContent = s ? `${s.formLabel} · ${s.mountLabel}` : FORMS[def.form]?.label ?? def.form;
        text.append(name, sub);

        const val = document.createElement('span');
        val.className = 'part-val';
        val.textContent = s?.headline ?? '';

        b.append(dot, text, val);
        b.addEventListener('click', () => onEditPart?.(def.id));
        return b;
      })
    );
  }

  /* ═══ Inspector update ═════════════════════════════════════ */
  function renderInspector(partId, context) {
    if (!partId) {
      hud.show('inspect', false);
      return;
    }
    const info = context.info ?? PART_INFO[partId] ?? { label: partId, role: '', detail: '' };
    hud.show('inspect', true);
    hud.setTitle('inspect', info.label);
    hud.setTag('inspect', partId);

    insRole.textContent = info.role;
    insDetail.textContent = info.detail;
    insRows.innerHTML = context.rows ?? '';
    insMeasuredLabel.hidden = !context.rows;

    const hasNote = Boolean(context.annotation);
    insAnnLabel.hidden = !hasNote;
    insAnn.hidden = !hasNote;
    if (hasNote) insAnn.textContent = context.annotation;
  }

  return {
    paramsPanel,
    analysisPanel,
    inspectPanel,
    syncParams,
    syncUi,
    renderAnalysis,
    renderInspector,
    renderCustomParts,
  };
}
