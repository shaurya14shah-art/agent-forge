/* ───────────────────────────────────────────────────────────────
   Liquid-rocket nozzle performance.

   Standard 1-D isentropic / ideal-nozzle relations (Sutton,
   "Rocket Propulsion Elements"). Frozen-equilibrium assumption,
   no boundary-layer or divergence losses beyond the λ correction.
   Good to a few percent against real engine data — enough that the
   numbers on the holo panels are real engineering, not set dressing.
   ─────────────────────────────────────────────────────────────── */

export const G0 = 9.80665;      // standard gravity, m/s²
export const R_UNIVERSAL = 8314.462; // J/(kmol·K)

/** Propellant combinations: chamber products, not the raw propellants. */
export const PROPELLANTS = {
  kerolox: {
    label: 'RP-1 / LOX',
    gamma: 1.24,
    Tc: 3670,      // K, at stoich-ish O/F 2.56
    M: 23.3,       // kg/kmol
    of: 2.56,
    rhoBulk: 1030, // kg/m³ bulk density of the propellant pair
    tint: 0x59d8ff,
  },
  methalox: {
    label: 'CH4 / LOX',
    gamma: 1.2,
    Tc: 3550,
    M: 21.5,
    of: 3.4,
    rhoBulk: 830,
    tint: 0x66e8ff,
  },
  hydrolox: {
    label: 'LH2 / LOX',
    gamma: 1.22,
    Tc: 3400,
    M: 12.7,
    of: 5.5,
    rhoBulk: 360,
    tint: 0x9fd0ff,
  },
  hypergol: {
    label: 'N2O4 / MMH',
    gamma: 1.25,
    Tc: 3250,
    M: 21.9,
    of: 2.1,
    rhoBulk: 1180,
    tint: 0xffb066,
  },
};

/**
 * Structural / thermal properties for the wall material picker.
 *
 * E (Young's modulus) is only used by the custom-part solver — slender
 * struts fail by buckling long before they reach yield, and buckling is
 * a stiffness problem, not a strength one.
 */
export const MATERIALS = {
  inconel718: { label: 'Inconel 718', rho: 8190, sigmaY: 1030e6, tMax: 980, k: 11.4, E: 200e9, tint: 0x8fe6ff },
  grcop42:    { label: 'GRCop-42',    rho: 8756, sigmaY: 200e6,  tMax: 800, k: 320,  E: 110e9, tint: 0xffa96b },
  cSiC:       { label: 'C/SiC composite', rho: 2200, sigmaY: 300e6, tMax: 1650, k: 15, E: 90e9, tint: 0xbdb2ff },
  nb_c103:    { label: 'Niobium C-103', rho: 8850, sigmaY: 240e6, tMax: 1400, k: 46, E: 100e9, tint: 0xa8ffd0 },
};

export const STEFAN_BOLTZMANN = 5.670374419e-8; // W/(m²·K⁴)

/**
 * Equilibrium wall temperature of an uncooled, radiation-cooled surface:
 * everything the gas puts in has to leave as thermal radiation.
 * This is how a niobium nozzle extension is actually sized.
 */
export function radiativeEquilibrium(heatFlux, emissivity = 0.85) {
  if (!(heatFlux > 0)) return 0;
  return Math.pow(heatFlux / (emissivity * STEFAN_BOLTZMANN), 0.25);
}

/** Vandenkerckhove function Γ(γ). */
export function vandenkerckhove(gamma) {
  return Math.sqrt(gamma) * Math.pow(2 / (gamma + 1), (gamma + 1) / (2 * (gamma - 1)));
}

/** Area ratio A/A* for a given Mach number. */
export function areaRatioFromMach(M, gamma) {
  const g = gamma;
  return (
    (1 / M) *
    Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M), (g + 1) / (2 * (g - 1)))
  );
}

/**
 * Invert the area–Mach relation for the supersonic branch.
 * Newton with a bisection guard — never diverges for ε > 1.
 */
export function machFromAreaRatio(eps, gamma) {
  if (eps <= 1.0001) return 1;
  let lo = 1.0001;
  let hi = 60;
  let M = 2.5;
  for (let i = 0; i < 80; i++) {
    const f = areaRatioFromMach(M, gamma) - eps;
    if (Math.abs(f) < 1e-10) break;
    if (f > 0) hi = M;
    else lo = M;

    // Newton step with numeric derivative, clamped into the bracket.
    const h = 1e-6;
    const df = (areaRatioFromMach(M + h, gamma) - areaRatioFromMach(M - h, gamma)) / (2 * h);
    let next = df !== 0 ? M - f / df : (lo + hi) / 2;
    if (!Number.isFinite(next) || next <= lo || next >= hi) next = (lo + hi) / 2;
    M = next;
  }
  return M;
}

/** US Standard Atmosphere 1976, truncated at 47 km. Returns Pa. */
export function ambientPressure(altitudeM) {
  const h = Math.max(0, altitudeM);
  if (h < 11000) {
    const T = 288.15 - 0.0065 * h;
    return 101325 * Math.pow(T / 288.15, 5.25588);
  }
  if (h < 20000) return 22632.1 * Math.exp(-0.00015769 * (h - 11000));
  if (h < 32000) {
    const T = 216.65 + 0.001 * (h - 20000);
    return 5474.89 * Math.pow(T / 216.65, -34.1626);
  }
  if (h < 47000) {
    const T = 228.65 + 0.0028 * (h - 32000);
    return 868.019 * Math.pow(T / 228.65, -12.2011);
  }
  return 110.906 * Math.exp(-0.000126 * (h - 47000));
}

/**
 * Full performance solve.
 *
 * @param {object} p design parameters
 * @param {number} p.throatRadius   m
 * @param {number} p.expansionRatio Ae/At
 * @param {number} p.chamberPressure Pa
 * @param {number} p.altitude       m (sets ambient back-pressure)
 * @param {string} p.propellant     key into PROPELLANTS
 * @param {number} p.halfAngleExit  deg, exit wall angle (divergence loss)
 * @param {number} p.cstarEff       combustion efficiency, 0..1
 */
export function solvePerformance(p) {
  const prop = PROPELLANTS[p.propellant] || PROPELLANTS.kerolox;
  const g = prop.gamma;
  const eps = Math.max(1.05, p.expansionRatio);
  const Pc = p.chamberPressure;
  const Rt = p.throatRadius;
  const At = Math.PI * Rt * Rt;
  const Ae = At * eps;
  const Re = Math.sqrt(Ae / Math.PI);

  const Me = machFromAreaRatio(eps, g);
  const pRatio = Math.pow(1 + ((g - 1) / 2) * Me * Me, -g / (g - 1)); // Pe/Pc
  const Pe = pRatio * Pc;
  const Pa = ambientPressure(p.altitude ?? 0);

  // Characteristic velocity
  const R = R_UNIVERSAL / prop.M;
  const Tc = prop.Tc;
  const cstarIdeal = Math.sqrt(R * Tc) / vandenkerckhove(g);
  const cstar = cstarIdeal * (p.cstarEff ?? 0.96);

  // Thrust coefficient: momentum term + pressure term
  const momentum = Math.sqrt(
    ((2 * g * g) / (g - 1)) *
      Math.pow(2 / (g + 1), (g + 1) / (g - 1)) *
      (1 - Math.pow(pRatio, (g - 1) / g))
  );
  // Divergence correction for a conical/bell exit half-angle α
  const alpha = ((p.halfAngleExit ?? 9) * Math.PI) / 180;
  const lambda = 0.5 * (1 + Math.cos(alpha));

  const CfVac = momentum * lambda + pRatio * eps;
  const Cf = momentum * lambda + (pRatio - Pa / Pc) * eps;

  const mdot = (Pc * At) / cstar;
  const thrust = Cf * Pc * At;
  const thrustVac = CfVac * Pc * At;
  const isp = (Cf * cstar) / G0;
  const ispVac = (CfVac * cstar) / G0;

  const Te = Tc / (1 + ((g - 1) / 2) * Me * Me);
  const ve = Me * Math.sqrt(g * R * Te);

  // Separation risk: Summerfield criterion — flow detaches below ~0.4 Pa
  const sepRatio = Pe / Pa;
  const separated = Pa > 0 && Pe < 0.35 * Pa;
  const overExpanded = Pe < Pa;
  const optimalAltitude = altitudeForPressure(Pe);

  return {
    At, Ae, Re, eps,
    Me, Pe, Pa, pRatio,
    cstar, mdot, thrust, thrustVac,
    isp, ispVac, Cf, CfVac, lambda,
    Te, Tc, ve, gamma: g,
    sepRatio, separated, overExpanded, optimalAltitude,
    propLabel: prop.label,
    ofRatio: prop.of,
    // mixture split
    mdotOx: (mdot * prop.of) / (1 + prop.of),
    mdotFuel: mdot / (1 + prop.of),
  };
}

/** Inverse of the atmosphere model — where does this engine run perfectly expanded? */
export function altitudeForPressure(targetPa) {
  if (targetPa >= 101325) return 0;
  let lo = 0;
  let hi = 90000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ambientPressure(mid) > targetPa) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Structural closeout jacket — always present, always carries the hoop load. */
export const JACKET = { label: 'Inconel 718 closeout', sigmaY: 1030e6, rho: 8190 };

/**
 * Chamber wall check, split the way a real regen chamber is actually built:
 *
 *  • Structural — a closeout jacket takes the hoop load (thin-wall σ = P·r/t).
 *    The hot-wall liner is far too thin and too hot to be the pressure vessel.
 *  • Thermal — the selected liner material carries the heat flux. Hot-wall
 *    temperature is the coolant bulk temperature plus the conduction rise
 *    ΔT = q·t/k through the liner, checked against the alloy's limit.
 *
 * That split is what makes the material choice mean something: conductivity
 * buys you thermal margin, it does not buy you pressure capability.
 */
export function structuralCheck({
  chamberRadius,
  wallThickness,
  chamberPressure,
  material,
  throatFlux = 0,
  propellant = 'kerolox',
}) {
  const mat = MATERIALS[material] || MATERIALS.inconel718;

  // The geometric wall is the jacket; the liner is the thin hot wall inside it.
  const jacketThickness = wallThickness * 0.8;
  const linerThickness = Math.min(wallThickness * 0.2, 0.0015);

  const hoop = (chamberPressure * chamberRadius) / jacketThickness;
  const margin = JACKET.sigmaY / hoop;

  const coolantBulk = (PROPELLANTS[propellant] || PROPELLANTS.kerolox).label.startsWith('LH2') ? 160 : 420;
  const deltaT = mat.k > 0 ? (throatFlux * linerThickness) / mat.k : Infinity;
  const linerTemp = coolantBulk + deltaT;

  return {
    hoopStressMPa: hoop / 1e6,
    yieldMPa: JACKET.sigmaY / 1e6,
    jacketLabel: JACKET.label,
    margin,
    ok: margin >= 1.5,
    materialLabel: mat.label,
    linerTempK: linerTemp,
    linerLimitK: mat.tMax,
    thermalMargin: mat.tMax / linerTemp,
    thermalOk: linerTemp <= mat.tMax,
    linerThicknessMm: linerThickness * 1000,
    tMax: mat.tMax,
  };
}

/**
 * Regenerative cooling check.
 *
 * Peak flux at the throat comes from a Bartz-style correlation; the total
 * heat load is then integrated along the actual wall contour, scaling flux
 * with local area ratio as q ∝ (At/A)^0.9 — the standard Bartz dependence.
 * Integrating matters: the throat has the highest flux but a tiny area, and
 * the chamber and bell carry most of the actual load.
 *
 * @param {{x: number, y: number}[]} contourPoints  meridian polyline (x = radius)
 */
export function coolingCheck({ throatRadius, chamberPressure, cstar, channels, mdotFuel, propellant, contourPoints }) {
  const prop = PROPELLANTS[propellant] || PROPELLANTS.kerolox;
  const Dt = 2 * throatRadius;

  // Bartz, collapsed to the dominant terms — W/m²
  const qThroat =
    0.026 *
    Math.pow(chamberPressure / cstar, 0.8) *
    Math.pow(Dt, -0.2) *
    Math.pow(prop.Tc / 3500, 0.8) *
    1.0e6;

  let heatLoad = 0;
  let wetted = 0;
  if (contourPoints?.length > 1) {
    for (let i = 0; i < contourPoints.length - 1; i++) {
      const a = contourPoints[i];
      const b = contourPoints[i + 1];
      const rMid = Math.max(throatRadius * 0.2, (a.x + b.x) / 2);
      const slant = Math.hypot(b.x - a.x, b.y - a.y);
      const dA = Math.PI * (a.x + b.x) * slant; // Pappus
      const q = qThroat * Math.min(1, Math.pow(throatRadius / rMid, 1.8));
      heatLoad += q * dA;
      wetted += dA;
    }
  } else {
    // Fallback: throat band only.
    const band = 2 * Math.PI * throatRadius * (0.6 * throatRadius);
    heatLoad = qThroat * band;
    wetted = band;
  }

  // Usable coolant enthalpy rise before the fuel cokes (hydrocarbons) or the
  // jacket runs out of ΔT (hydrogen).
  const capacityPerKg = prop.label.startsWith('LH2') ? 4.5e6 : 0.9e6;

  // Channel count moves the achievable heat-transfer coefficient: fewer, wider
  // channels mean lower velocity and a worse film coefficient.
  const channelFactor = Math.min(1.15, Math.pow(Math.max(8, channels) / 40, 0.35));
  const capacity = mdotFuel * capacityPerKg * channelFactor;
  const load = capacity > 0 ? heatLoad / capacity : Infinity;

  return {
    qThroatMW: qThroat / 1e6,
    heatLoadMW: heatLoad / 1e6,
    capacityMW: capacity / 1e6,
    wettedArea: wetted,
    utilisation: load,
    channels,
    ok: load < 0.85,
  };
}

/** Rough dry-mass estimate from swept wall area × thickness × density. */
export function massEstimate({ profileArea, wallThickness, material, extras = 0 }) {
  const mat = MATERIALS[material] || MATERIALS.inconel718;
  return profileArea * wallThickness * mat.rho + extras;
}

export function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  if (a >= 1e6) return (value / 1e6).toFixed(digits) + 'M';
  if (a >= 1e3) return (value / 1e3).toFixed(digits) + 'k';
  if (a < 0.01 && a > 0) return value.toExponential(1);
  return value.toFixed(digits);
}
