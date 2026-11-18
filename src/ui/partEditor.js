/* ───────────────────────────────────────────────────────────────
   Custom part editor.

   Docks as a second left-hand column, beside the design panel, and
   only exists while a part is open — an authoring surface shouldn't
   hold a column of the workbench hostage when nothing is being
   authored.

   Every control writes straight through the store, so the hologram
   rebuilds under your hand while you drag. Structure that changes the
   control set (form, sizing mode, duty) rebuilds its section; nothing
   else does, so a slider drag never destroys the slider.
   ─────────────────────────────────────────────────────────────── */

import { FORMS, DUTIES, DUTY_PARAMS } from '../model/forms.js';
import {
  MOUNTS,
  OFFSET_SPEC,
  normalisePart,
  convertSizing,
  paramRange,
} from '../model/customPart.js';
import { MATERIALS } from '../model/physics.js';
import { createMeter } from './charts.js';

const MAT_SUB = {
  inconel718: '1030 MPa · 980 K',
  grcop42: 'k = 320 · 800 K',
  cSiC: 'light · 1650 K',
  nb_c103: 'radiative · 1400 K',
};

/** Length display depends on the sizing mode, so it lives in one place. */
function showLength(value, sizing) {
  return sizing === 'relative'
    ? { text: `×${value.toFixed(3)}`, unit: '' }
    : { text: (value * 1000).toFixed(1), unit: 'mm' };
}

function showParam(spec, value, sizing) {
  if (spec.kind === 'len') return showLength(value, sizing);
  if (spec.kind === 'angle') return { text: value.toFixed(0), unit: '°' };
  return { text: String(Math.round(value)), unit: '' };
}

export function createPartEditor({ hud, store, getMountRadius, getStats, onSelect }) {
  const panel = hud.panel('editor', {
    anchor: 'left',
    offsetX: 318,          // clears the 306px design panel plus a hairline gap
    title: 'Part editor',
    tag: '',
  });
  panel.body.classList.add('scroll', 'editor-body');
  hud.show('editor', false);

  const E = panel.body;
  let openId = null;
  let built = { form: null, sizing: null, duty: null };
  let suppress = false;   // guard against sync() writing back while dragging

  /* ── Identity ─────────────────────────────────────────────── */
  const nameWrap = document.createElement('div');
  nameWrap.className = 'field';
  nameWrap.innerHTML = `<label for="cp-name">Name</label><input id="cp-name" type="text" maxlength="40" spellcheck="false" />`;
  E.appendChild(nameWrap);
  const nameInput = nameWrap.querySelector('input');
  nameInput.addEventListener('input', () => patch({ name: nameInput.value }));

  /* ── Form ─────────────────────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Form</div>`);
  const formGrid = grid(E, 'form');
  for (const [id, form] of Object.entries(FORMS)) {
    formGrid.appendChild(
      choice(id, form.label, DUTIES[form.duty].label.toLowerCase(), form.blurb, () =>
        patch({ form: id, duty: form.duty, dims: undefined })
      )
    );
  }

  const formNote = document.createElement('div');
  formNote.className = 'note editor-note';
  E.appendChild(formNote);

  /* ── Mount ────────────────────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Mount</div>`);
  const mountGrid = grid(E, 'mount');
  for (const [id, mount] of Object.entries(MOUNTS)) {
    mountGrid.appendChild(choice(id, mount.label, '', mount.hint, () => patch({ mount: id })));
  }

  const offsetCtl = slider(E, 'Axial offset');
  const rotationCtl = slider(E, 'Rotation');
  offsetCtl.input.addEventListener('input', () => patch({ offsetY: Number(offsetCtl.input.value) }));
  rotationCtl.input.addEventListener('input', () => patch({ rotation: Number(rotationCtl.input.value) }));

  /* ── Sizing + dimensions ──────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Sizing</div>`);
  const sizingSeg = document.createElement('div');
  sizingSeg.className = 'seg';
  for (const [value, label] of [['relative', 'Relative to mount'], ['absolute', 'Absolute mm']]) {
    const b = document.createElement('button');
    b.dataset.value = value;
    b.textContent = label;
    b.addEventListener('click', () => {
      const def = current();
      if (!def || def.sizing === value) return;
      // Convert rather than reinterpret, so the hardware doesn't jump.
      store.updateCustomPart(def.id, convertSizing(def, value, getMountRadius(def)), { record: true });
    });
    sizingSeg.appendChild(b);
  }
  E.appendChild(sizingSeg);

  const sizingNote = document.createElement('div');
  sizingNote.className = 'note editor-note';
  E.appendChild(sizingNote);

  E.insertAdjacentHTML('beforeend', `<div class="sect">Dimensions</div>`);
  const dimHost = document.createElement('div');
  E.appendChild(dimHost);
  let dimControls = new Map();

  /* ── Material ─────────────────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Material</div>`);
  const matGrid = grid(E, 'material');
  for (const [id, mat] of Object.entries(MATERIALS)) {
    matGrid.appendChild(choice(id, mat.label, MAT_SUB[id] ?? '', '', () => patch({ material: id })));
  }

  /* ── Duty ─────────────────────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Duty</div>`);
  const dutyGrid = grid(E, 'duty');
  for (const [id, duty] of Object.entries(DUTIES)) {
    dutyGrid.appendChild(choice(id, duty.label, '', duty.blurb, () => patch({ duty: id })));
  }

  const dutyNote = document.createElement('div');
  dutyNote.className = 'note editor-note';
  E.appendChild(dutyNote);

  const dutyHost = document.createElement('div');
  E.appendChild(dutyHost);
  let dutyControls = new Map();
  let cooledBtn = null;

  /* ── Solved ───────────────────────────────────────────────── */
  E.insertAdjacentHTML('beforeend', `<div class="sect">Solved</div>`);
  const meterHost = document.createElement('div');
  E.appendChild(meterHost);
  const meter = createMeter(meterHost, { label: 'Duty check', threshold: 1 });
  meter.el.hidden = true;

  const statHost = document.createElement('div');
  statHost.className = 'stat-rows';
  E.appendChild(statHost);

  const adviceEl = document.createElement('div');
  adviceEl.className = 'flag warn editor-advice';
  adviceEl.hidden = true;
  E.appendChild(adviceEl);

  /* ── Actions ──────────────────────────────────────────────── */
  const actions = document.createElement('div');
  actions.className = 'grid-2 editor-actions';
  actions.innerHTML = `
    <button class="btn" data-act="duplicate">Duplicate</button>
    <button class="btn danger" data-act="delete">Delete</button>
    <button class="btn primary" data-act="done" style="grid-column:1/-1">Done</button>
  `;
  E.appendChild(actions);

  actions.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
    const def = current();
    if (!def) return;
    const copy = normalisePart({ ...def, id: undefined, name: `${def.name} copy` });
    store.addCustomPart(copy);
    open(copy.id);
  });
  actions.querySelector('[data-act="delete"]').addEventListener('click', () => {
    const def = current();
    if (!def) return;
    store.removeCustomPart(def.id);
    close();
  });
  actions.querySelector('[data-act="done"]').addEventListener('click', () => close());

  /* ── Behaviour ────────────────────────────────────────────── */

  function current() {
    return openId ? store.getCustomPart(openId) : null;
  }

  function patch(fields) {
    const def = current();
    if (!def || suppress) return;
    // `undefined` dims means "reset to this form's defaults" — normalisePart
    // handles the transition, including keeping same-named parameters.
    const next = normalisePart({ ...def, ...fields }, def);
    store.updateCustomPart(def.id, next);
  }

  function renderDims(def) {
    dimHost.replaceChildren();
    dimControls = new Map();
    for (const [key, spec] of Object.entries(FORMS[def.form].params)) {
      const r = paramRange(spec, def.sizing);
      const ctl = slider(dimHost, spec.label);
      ctl.input.min = r.min;
      ctl.input.max = r.max;
      ctl.input.step = r.step;
      ctl.input.addEventListener('input', () =>
        patch({ dims: { ...current().dims, [key]: Number(ctl.input.value) } })
      );
      dimControls.set(key, { ctl, spec });
    }
  }

  function renderDuty(def) {
    dutyHost.replaceChildren();
    dutyControls = new Map();
    cooledBtn = null;

    for (const [key, spec] of Object.entries(DUTY_PARAMS[def.duty] ?? {})) {
      const ctl = slider(dutyHost, spec.label);
      ctl.input.min = spec.min;
      ctl.input.max = spec.max;
      ctl.input.step = spec.step;
      ctl.input.addEventListener('input', () => patch({ [key]: Number(ctl.input.value) }));
      dutyControls.set(key, { ctl, spec });
    }

    if (def.duty === 'hotgas') {
      cooledBtn = document.createElement('button');
      cooledBtn.className = 'btn';
      cooledBtn.style.width = '100%';
      cooledBtn.style.textAlign = 'center';
      cooledBtn.style.marginTop = '6px';
      cooledBtn.addEventListener('click', () => patch({ cooled: !current().cooled }));
      dutyHost.appendChild(cooledBtn);
    }
  }

  /** Reflect the stored definition into every control. */
  function sync() {
    const def = current();
    if (!def) return;

    if (built.form !== def.form || built.sizing !== def.sizing) renderDims(def);
    if (built.duty !== def.duty) renderDuty(def);
    built = { form: def.form, sizing: def.sizing, duty: def.duty };

    suppress = true;
    hud.setTag('editor', def.id);
    if (document.activeElement !== nameInput) nameInput.value = def.name;

    press(formGrid, def.form);
    press(mountGrid, def.mount);
    press(matGrid, def.material);
    press(dutyGrid, def.duty);
    press(sizingSeg, def.sizing);

    formNote.textContent = FORMS[def.form].blurb;
    dutyNote.textContent = DUTIES[def.duty].blurb;
    sizingNote.textContent =
      def.sizing === 'relative'
        ? `Lengths are multiples of the ${MOUNTS[def.mount].label.toLowerCase()} radius, so this part re-scales with the engine.`
        : 'Lengths are fixed in millimetres. This part keeps its size when the engine changes.';

    const offsetRange = def.sizing === 'relative' ? OFFSET_SPEC.rel : OFFSET_SPEC.abs;
    offsetCtl.input.min = offsetRange[0];
    offsetCtl.input.max = offsetRange[1];
    offsetCtl.input.step = def.sizing === 'relative' ? 0.01 : 0.001;
    setCtl(offsetCtl, def.offsetY, showLength(def.offsetY, def.sizing));

    rotationCtl.input.min = -180;
    rotationCtl.input.max = 180;
    rotationCtl.input.step = 1;
    setCtl(rotationCtl, def.rotation, { text: def.rotation.toFixed(0), unit: '°' });

    for (const [key, { ctl, spec }] of dimControls) {
      setCtl(ctl, def.dims[key], showParam(spec, def.dims[key], def.sizing));
    }
    for (const [key, { ctl, spec }] of dutyControls) {
      setCtl(ctl, def[key], { text: spec.display ? spec.display(def[key]) : String(def[key]), unit: spec.unit ?? '' });
    }
    if (cooledBtn) {
      cooledBtn.textContent = def.cooled ? 'Regeneratively cooled' : 'Uncooled — radiates';
      cooledBtn.setAttribute('aria-pressed', String(def.cooled));
    }
    suppress = false;
  }

  /** Write the solved statistics for the open part into the panel. */
  function renderStats(stats) {
    if (!openId) return;
    if (!stats) {
      meter.el.hidden = true;
      statHost.replaceChildren();
      adviceEl.hidden = true;
      return;
    }

    if (stats.meter) {
      meter.el.hidden = false;
      meter.setLabel(stats.meter.label);
      meter.setThreshold(stats.meter.threshold);
      meter.update(stats.meter.ratio, stats.meter.state, stats.meter.text);
    } else {
      meter.el.hidden = true;
    }

    const rows = [
      { k: 'Mass', v: `${stats.mass.toFixed(2)} kg`, state: null },
      ...stats.rows,
    ];
    statHost.replaceChildren(
      ...rows.map(({ k, v, state }) => {
        const d = document.createElement('div');
        d.className = 'row';
        const kn = document.createElement('span');
        kn.className = 'k';
        kn.textContent = k;
        const vn = document.createElement('span');
        vn.className = `v${state ? ` ${state}` : ''}`;
        vn.textContent = v;
        d.append(kn, vn);
        return d;
      })
    );

    adviceEl.hidden = !stats.note;
    adviceEl.className = `flag ${stats.state === 'bad' ? 'bad' : 'warn'} editor-advice`;
    if (stats.note) adviceEl.textContent = stats.note;
  }

  /** Keep the world-anchored inspector clear of whatever the editor covers. */
  function reserveSpace(open) {
    hud.setKeepOut('inspect', {
      left: open ? panel.margin + panel.offsetX + (panel.el.offsetWidth || 306) + 22 : 372,
    });
  }

  function open(id) {
    if (!store.getCustomPart(id)) return false;
    openId = id;
    built = { form: null, sizing: null, duty: null };
    hud.show('editor', true);
    document.body.classList.add('editing');
    reserveSpace(true);
    sync();
    // The solve that ran when this part was added did so before it was the
    // open one, so pull its statistics rather than showing the last part's.
    renderStats(getStats?.(id) ?? null);
    onSelect?.(id);
    return true;
  }

  function close() {
    openId = null;
    hud.show('editor', false);
    document.body.classList.remove('editing');
    reserveSpace(false);
  }

  return {
    open,
    close,
    sync,
    renderStats,
    get openId() { return openId; },
    isOpen: () => openId !== null,
    panel,
  };
}

/* ── small builders ──────────────────────────────────────────── */

function grid(host, key) {
  const g = document.createElement('div');
  g.className = 'grid-2';
  g.dataset.choice = key;
  host.appendChild(g);
  return g;
}

function choice(value, label, sub, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.dataset.value = value;
  if (title) b.title = title;
  b.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'btn-sub';
    s.textContent = sub;
    b.appendChild(s);
  }
  b.addEventListener('click', onClick);
  return b;
}

function press(host, value) {
  host.querySelectorAll('[data-value]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.value === value))
  );
}

function slider(host, label) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  wrap.innerHTML = `<div class="ctl-top"><label></label><output></output></div><input type="range" />`;
  wrap.querySelector('label').textContent = label;
  host.appendChild(wrap);
  return { wrap, input: wrap.querySelector('input'), out: wrap.querySelector('output') };
}

function setCtl(ctl, value, display) {
  if (document.activeElement !== ctl.input) ctl.input.value = String(value);
  ctl.out.textContent = display.text;
  if (display.unit) {
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = display.unit;
    ctl.out.appendChild(u);
  }
}
