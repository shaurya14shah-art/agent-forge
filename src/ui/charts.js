/* ───────────────────────────────────────────────────────────────
   Inline SVG instrumentation.

   A nozzle designer reads two things constantly: the thrust curve
   against altitude (where does this engine actually want to fly?) and
   the wall contour (what did my parameters just do to the shape?).
   Both are drawn here rather than listed as numbers, because the
   shape of the answer is the answer.

   Charts are built once and updated by mutating path data — no
   innerHTML churn, so scroll position and transitions survive.
   ─────────────────────────────────────────────────────────────── */

import { ambientPressure } from '../model/physics.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Thrust and Isp against altitude, with the current operating point,
 * the matched altitude, and any flow-separation region marked.
 */
export function createThrustCurve(host) {
  const W = 100;
  const H = 46;
  const PAD_L = 2;
  const PAD_R = 2;
  const PAD_T = 4;
  const PAD_B = 9;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    class: 'chart',
  });

  const gridG = el('g', { class: 'chart-grid' });
  for (let i = 0; i <= 3; i++) {
    const y = PAD_T + ((H - PAD_T - PAD_B) * i) / 3;
    gridG.appendChild(el('line', { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y }));
  }
  svg.appendChild(gridG);

  const sepBand = el('rect', { class: 'chart-band-bad', x: 0, y: PAD_T, width: 0, height: H - PAD_T - PAD_B });
  svg.appendChild(sepBand);

  const areaPath = el('path', { class: 'chart-area' });
  const thrustPath = el('path', { class: 'chart-line' });
  const ispPath = el('path', { class: 'chart-line-2' });
  svg.appendChild(areaPath);
  svg.appendChild(ispPath);
  svg.appendChild(thrustPath);

  const matchLine = el('line', { class: 'chart-marker', y1: PAD_T, y2: H - PAD_B });
  svg.appendChild(matchLine);

  const nowLine = el('line', { class: 'chart-now', y1: PAD_T - 2, y2: H - PAD_B });
  const nowDot = el('circle', { class: 'chart-dot', r: 1.5 });
  svg.appendChild(nowLine);
  svg.appendChild(nowDot);

  host.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = `
    <span><i class="k-thrust"></i>thrust</span>
    <span><i class="k-isp"></i>Isp</span>
    <span class="chart-x"><b>0</b><b>20</b><b>40</b><b>60 km</b></span>
  `;
  host.appendChild(legend);

  const MAX_ALT = 60000;
  const N = 72;

  function update(perf, altitude) {
    // Thrust at a given back-pressure, reusing the already-solved exit
    // conditions — only the pressure term varies with altitude.
    const { Cf, Pe, Pa, At, eps, pRatio, cstar } = perf;
    const Pc = Pe / pRatio;
    const cfMomentum = Cf - (pRatio - Pa / Pc) * eps;

    const thrustAt = (pa) => (cfMomentum + (pRatio - pa / Pc) * eps) * Pc * At;
    const ispAt = (pa) => ((cfMomentum + (pRatio - pa / Pc) * eps) * cstar) / 9.80665;

    const pts = [];
    for (let i = 0; i <= N; i++) {
      const alt = (MAX_ALT * i) / N;
      const pa = ambientPressure(alt);
      pts.push({ alt, pa, F: thrustAt(pa), isp: ispAt(pa) });
    }

    const fMin = Math.min(...pts.map((p) => p.F));
    const fMax = Math.max(...pts.map((p) => p.F));
    const iMin = Math.min(...pts.map((p) => p.isp));
    const iMax = Math.max(...pts.map((p) => p.isp));

    const x = (alt) => PAD_L + ((W - PAD_L - PAD_R) * alt) / MAX_ALT;
    const yF = (F) => PAD_T + (H - PAD_T - PAD_B) * (1 - (F - fMin) / Math.max(1e-6, fMax - fMin));
    const yI = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - iMin) / Math.max(1e-6, iMax - iMin));

    const line = (fn, key) =>
      pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.alt).toFixed(2)} ${fn(p[key]).toFixed(2)}`).join('');

    const d = line(yF, 'F');
    thrustPath.setAttribute('d', d);
    ispPath.setAttribute('d', line(yI, 'isp'));
    areaPath.setAttribute('d', `${d}L${x(MAX_ALT)} ${H - PAD_B}L${x(0)} ${H - PAD_B}Z`);

    // Separation region: below the altitude where Pe drops under 0.35·Pa.
    let sepAlt = 0;
    for (const p of pts) {
      if (Pe < 0.35 * p.pa) sepAlt = p.alt;
    }
    sepBand.setAttribute('width', sepAlt > 0 ? (x(sepAlt) - PAD_L).toFixed(2) : 0);
    sepBand.setAttribute('x', PAD_L);

    const matched = Math.min(MAX_ALT, perf.optimalAltitude);
    matchLine.setAttribute('x1', x(matched).toFixed(2));
    matchLine.setAttribute('x2', x(matched).toFixed(2));

    const nowAlt = Math.min(MAX_ALT, altitude);
    const nowX = x(nowAlt);
    nowLine.setAttribute('x1', nowX.toFixed(2));
    nowLine.setAttribute('x2', nowX.toFixed(2));
    nowDot.setAttribute('cx', nowX.toFixed(2));
    nowDot.setAttribute('cy', yF(thrustAt(ambientPressure(nowAlt))).toFixed(2));
  }

  return { update, svg };
}

/**
 * Meridian wall contour, mirrored about the axis — the actual shape the
 * current parameters produce, with the throat station called out.
 */
export function createContourPlot(host) {
  const W = 100;
  const H = 52;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'chart chart-contour' });

  const axis = el('line', { class: 'chart-axis' });
  const wallTop = el('path', { class: 'chart-wall' });
  const wallBottom = el('path', { class: 'chart-wall' });
  const fill = el('path', { class: 'chart-wall-fill' });
  const throatTick = el('line', { class: 'chart-marker' });

  svg.appendChild(fill);
  svg.appendChild(axis);
  svg.appendChild(wallTop);
  svg.appendChild(wallBottom);
  svg.appendChild(throatTick);
  host.appendChild(svg);

  function update(contour) {
    const pts = contour.all;
    if (!pts?.length) return;

    const ys = pts.map((p) => p.y);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const rMax = Math.max(...pts.map((p) => p.x));

    // Engine axis runs left→right; radius maps to vertical half-height.
    const pad = 3;
    const sx = (W - pad * 2) / Math.max(1e-6, yMax - yMin);
    const sy = (H / 2 - pad) / Math.max(1e-6, rMax);
    const s = Math.min(sx, sy * 1.6);

    const px = (p) => pad + (yMax - p.y) * s;
    const pyTop = (p) => H / 2 - p.x * Math.min(sy, s);
    const pyBot = (p) => H / 2 + p.x * Math.min(sy, s);

    const top = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p).toFixed(2)} ${pyTop(p).toFixed(2)}`).join('');
    const bot = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p).toFixed(2)} ${pyBot(p).toFixed(2)}`).join('');

    wallTop.setAttribute('d', top);
    wallBottom.setAttribute('d', bot);
    fill.setAttribute(
      'd',
      `${top}L${px(pts[pts.length - 1])} ${pyBot(pts[pts.length - 1])}` +
        pts.slice().reverse().map((p) => `L${px(p).toFixed(2)} ${pyBot(p).toFixed(2)}`).join('') +
        'Z'
    );

    axis.setAttribute('x1', pad);
    axis.setAttribute('y1', H / 2);
    axis.setAttribute('x2', W - pad);
    axis.setAttribute('y2', H / 2);

    const throat = pts.reduce((a, b) => (b.x < a.x ? b : a), pts[0]);
    const tx = px(throat);
    throatTick.setAttribute('x1', tx.toFixed(2));
    throatTick.setAttribute('x2', tx.toFixed(2));
    throatTick.setAttribute('y1', 1);
    throatTick.setAttribute('y2', H - 1);
  }

  return { update, svg };
}

/** Horizontal margin bar with a threshold tick — used for cooling / stress. */
export function createMeter(host, { label, threshold = 1, format }) {
  const wrap = document.createElement('div');
  wrap.className = 'meter';
  wrap.innerHTML = `
    <div class="meter-top"><span class="meter-label">${label}</span><span class="meter-value"></span></div>
    <div class="meter-track"><i class="meter-fill"></i><u class="meter-threshold"></u></div>
  `;
  host.appendChild(wrap);

  const valueEl = wrap.querySelector('.meter-value');
  const labelEl = wrap.querySelector('.meter-label');
  const fillEl = wrap.querySelector('.meter-fill');
  const thrEl = wrap.querySelector('.meter-threshold');
  thrEl.style.left = `${Math.min(100, threshold * 100)}%`;

  /** @param {number} ratio 0..1+ where 1 is the limit */
  function update(ratio, state, text) {
    const pct = Math.max(0, Math.min(1.25, ratio)) * 100;
    fillEl.style.width = `${Math.min(100, pct)}%`;
    wrap.dataset.state = state ?? (ratio > 1 ? 'bad' : ratio > 0.85 ? 'warn' : 'ok');
    valueEl.textContent = text ?? (format ? format(ratio) : `${(ratio * 100).toFixed(0)}%`);
  }

  // The custom-part meter re-labels itself when the duty changes, so the
  // same element serves buckling margin, wall temperature and flow velocity.
  const setLabel = (text) => { labelEl.textContent = text; };
  const setThreshold = (t) => { thrEl.style.left = `${Math.min(100, t * 100)}%`; };

  return { update, setLabel, setThreshold, el: wrap };
}
