/* ───────────────────────────────────────────────────────────────
   Thrust-chamber contour generation.

   Everything is produced in the (r, y) meridian plane with y = 0 at
   the throat, +y toward the injector and -y toward the exit. The
   whole assembly is then revolved with THREE.LatheGeometry.

   The bell uses Rao's thrust-optimised parabolic approximation:
   a 0.382·Rt downstream throat arc that turns the flow to θn, then a
   quadratic Bézier out to the exit lip where the wall angle is θe.
   ─────────────────────────────────────────────────────────────── */

import { Vector2 } from 'three';

const DEG = Math.PI / 180;

/**
 * Rao initial/exit wall angles for an 80 % length bell, tabulated
 * against area ratio, log-interpolated. Corrected toward the conical
 * limits for other bell percentages.
 */
const RAO_TABLE = [
  //  eps,  θn,   θe   (degrees, 80 % bell)
  [4, 20.5, 14.6],
  [5, 21.4, 13.7],
  [7, 22.4, 12.4],
  [10, 23.0, 11.5],
  [15, 23.9, 10.6],
  [20, 24.3, 10.0],
  [25, 24.6, 9.6],
  [30, 24.9, 9.2],
  [40, 25.3, 8.7],
  [50, 25.6, 8.3],
  [70, 26.0, 7.8],
  [100, 26.3, 7.4],
  [150, 26.6, 7.0],
  [200, 26.8, 6.7],
];

function raoAngles(eps, bellPercent) {
  const e = Math.min(200, Math.max(4, eps));
  let lo = RAO_TABLE[0];
  let hi = RAO_TABLE[RAO_TABLE.length - 1];
  for (let i = 0; i < RAO_TABLE.length - 1; i++) {
    if (e >= RAO_TABLE[i][0] && e <= RAO_TABLE[i + 1][0]) {
      lo = RAO_TABLE[i];
      hi = RAO_TABLE[i + 1];
      break;
    }
  }
  const t =
    hi[0] === lo[0] ? 0 : (Math.log(e) - Math.log(lo[0])) / (Math.log(hi[0]) - Math.log(lo[0]));
  let thetaN = lo[1] + (hi[1] - lo[1]) * t;
  let thetaE = lo[2] + (hi[2] - lo[2]) * t;

  // Shorter bells turn harder at the throat and leave more residual swirl.
  const d = (80 - bellPercent) / 100;
  thetaN *= 1 + d * 0.42;
  thetaE *= 1 + d * 1.35;

  return { thetaN: thetaN * DEG, thetaE: thetaE * DEG };
}

function quadBezier(p0, p1, p2, t) {
  const u = 1 - t;
  return new Vector2(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
  );
}

/**
 * Build the inner (gas-side) wall contour, split into named segments.
 *
 * @returns {{
 *   dome: Vector2[], chamber: Vector2[], converge: Vector2[],
 *   throat: Vector2[], diverge: Vector2[], all: Vector2[],
 *   Rt: number, Rc: number, Re: number,
 *   yInjector: number, yChamberEnd: number, yExit: number,
 *   thetaN: number, thetaE: number, bellLength: number, wettedArea: number
 * }}
 */
export function buildContour(params) {
  const {
    throatRadius: Rt,
    expansionRatio: eps,
    contractionRatio: cr = 4.0,
    chamberLength: Lc = 0.28,
    bellType = 'parabolic',
    bellPercent = 80,
    convergeHalfAngle = 30,
  } = params;

  const Rc = Rt * Math.sqrt(cr);
  const Re = Rt * Math.sqrt(eps);
  const thetaC = convergeHalfAngle * DEG;

  const R1 = 1.5 * Rt;   // upstream throat arc
  const R2 = 0.382 * Rt; // downstream throat arc
  const Rf = 0.75 * Rt;  // chamber-to-cone fillet

  // ── Upstream throat arc: 0 → thetaC ─────────────────────────
  const throatUp = [];
  const NA = 16;
  for (let i = NA; i >= 0; i--) {
    const th = (thetaC * i) / NA;
    throatUp.push(new Vector2((Rt + R1) - R1 * Math.cos(th), R1 * Math.sin(th)));
  }
  throatUp.reverse(); // now runs from throat outward (increasing y)
  const A = throatUp[throatUp.length - 1];

  // ── Converging cone up to the chamber fillet ────────────────
  const rP = Rc - Rf * (1 - Math.cos(thetaC));
  const yP = A.y + (rP - A.x) / Math.tan(thetaC);
  const yF = yP + Rf * Math.sin(thetaC);

  const converge = [new Vector2(A.x, A.y), new Vector2(rP, yP)];
  const NF = 10;
  for (let i = 1; i <= NF; i++) {
    const th = -thetaC + (thetaC * i) / NF;
    converge.push(new Vector2(Rc - Rf + Rf * Math.cos(th), yF + Rf * Math.sin(th)));
  }

  // ── Cylindrical chamber ─────────────────────────────────────
  const yChamberEnd = yF + Math.max(0.02, Lc);
  const chamber = [new Vector2(Rc, yF), new Vector2(Rc, yChamberEnd)];

  // ── Injector dome (elliptical cap) ──────────────────────────
  const domeH = Rc * 0.55;
  const dome = [];
  const ND = 14;
  for (let i = 0; i <= ND; i++) {
    const a = (Math.PI / 2) * (i / ND);
    dome.push(new Vector2(Rc * Math.cos(a), yChamberEnd + domeH * Math.sin(a)));
  }
  const yInjector = yChamberEnd + domeH;

  // ── Downstream throat arc + divergent section ───────────────
  const { thetaN, thetaE } = raoAngles(eps, bellPercent);
  const conicalHalf = 15 * DEG;
  const L15 = (Re - Rt) / Math.tan(conicalHalf);

  let throatDown = [];
  let diverge = [];
  let bellLength = 0;
  let exitAngleDeg = 15;

  if (bellType === 'conical') {
    const NB = 12;
    for (let i = 0; i <= NB; i++) {
      const th = (conicalHalf * i) / NB;
      throatDown.push(new Vector2((Rt + R2) - R2 * Math.cos(th), -R2 * Math.sin(th)));
    }
    const start = throatDown[throatDown.length - 1];
    bellLength = L15 * (bellPercent / 100);
    const end = new Vector2(Re, start.y - (Re - start.x) / Math.tan(conicalHalf));
    diverge = [start.clone(), end];
    bellLength = start.y - end.y;
    exitAngleDeg = 15;
  } else if (bellType === 'aerospike') {
    // Simplified truncated-plug outer cowl: the flow turns sharply at the
    // throat lip then the external surface does the expansion work.
    const NB = 10;
    for (let i = 0; i <= NB; i++) {
      const th = (thetaN * i) / NB;
      throatDown.push(new Vector2((Rt + R2) - R2 * Math.cos(th), -R2 * Math.sin(th)));
    }
    const start = throatDown[throatDown.length - 1];
    bellLength = 0.36 * L15;
    const end = new Vector2(Re * 0.92, start.y - bellLength);
    const ctrl = new Vector2(start.x + (end.x - start.x) * 0.15, start.y - bellLength * 0.55);
    const NP = 22;
    for (let i = 0; i <= NP; i++) {
      diverge.push(quadBezier(start, ctrl, end, i / NP));
    }
    exitAngleDeg = 4;
  } else {
    // Rao parabolic bell
    const NB = 12;
    for (let i = 0; i <= NB; i++) {
      const th = (thetaN * i) / NB;
      throatDown.push(new Vector2((Rt + R2) - R2 * Math.cos(th), -R2 * Math.sin(th)));
    }
    const N = throatDown[throatDown.length - 1];
    bellLength = L15 * (bellPercent / 100);

    // Work in axial coordinate x = -y so slopes are positive downstream.
    const xN = -N.y;
    const rN = N.x;
    const xE = bellLength;
    const rE = Re;
    const tN = Math.tan(thetaN);
    const tE = Math.tan(thetaE);

    let xQ;
    if (Math.abs(tN - tE) < 1e-6) xQ = (xN + xE) / 2;
    else xQ = (rE - rN + xN * tN - xE * tE) / (tN - tE);
    xQ = Math.min(Math.max(xQ, xN + 1e-4), xE - 1e-4);
    const rQ = rN + (xQ - xN) * tN;

    const P0 = new Vector2(rN, -xN);
    const P1 = new Vector2(rQ, -xQ);
    const P2 = new Vector2(rE, -xE);
    const NP = 30;
    for (let i = 0; i <= NP; i++) {
      diverge.push(quadBezier(P0, P1, P2, i / NP));
    }
    exitAngleDeg = thetaE / DEG;
  }

  const yExit = diverge[diverge.length - 1].y;

  // De-duplicate joints so the lathe doesn't produce zero-area quads.
  const throat = dedupe([...throatUp.slice().reverse(), ...throatDown]);

  const all = dedupe([
    ...dome.slice().reverse(),
    ...chamber.slice().reverse(),
    ...converge.slice().reverse(),
    ...throat,
    ...diverge,
  ]);

  return {
    dome,
    chamber,
    converge,
    throat,
    diverge,
    all,
    Rt, Rc, Re,
    yInjector,
    yChamberEnd,
    yChamberStart: yF,
    yExit,
    thetaN: thetaN / DEG,
    thetaE: exitAngleDeg,
    bellLength,
    conicalLength: L15,
    wettedArea: wettedArea(all),
  };
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.distanceToSquared(p) > 1e-10) out.push(p.clone());
  }
  return out;
}

/** Surface area of revolution for a meridian polyline (Pappus). */
export function wettedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    const l = p.distanceTo(q);
    a += Math.PI * (p.x + q.x) * l;
  }
  return a;
}

/**
 * Offset a meridian polyline outward by `t` along its normal, producing
 * a closed contour (inner forward, outer back) so the lathe yields a
 * shell with real wall thickness — visible in cutaway.
 */
export function thicken(points, t) {
  if (points.length < 2) return points.slice();
  const normals = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    // Outward normal of a meridian going "down" the page.
    normals.push(new Vector2(dy / len, -dx / len));
  }
  // Orient normals outward (away from the axis).
  const mid = Math.floor(points.length / 2);
  if (normals[mid].x < 0) normals.forEach((n) => n.multiplyScalar(-1));

  const outer = points.map((p, i) => new Vector2(p.x + normals[i].x * t, p.y + normals[i].y * t));
  const contour = [...points.map((p) => p.clone()), ...outer.reverse()];
  contour.push(contour[0].clone()); // close
  return contour.map((p) => new Vector2(Math.max(0, p.x), p.y));
}
