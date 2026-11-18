/* ───────────────────────────────────────────────────────────────
   Custom-part form library.

   A "form" is a family of manufacturable hardware — a flange, a conic
   shell, a bladed disc — parameterised by a handful of dimensions. It
   knows two things:

     build(d, group)  fill a group with hologram geometry
     measure(d)       report the physical quantities the solver needs

   `measure` is the important half. Every number the analysis panel
   shows about a custom part traces back to it: material volume for
   mass, load-bearing section for compressive stress, bore radius and
   wall for membrane stress, wetted area for heat load, flow area and
   hydraulic diameter for pressure drop. Nothing is decorative.

   All dimensions arriving at build/measure are already resolved to
   metres by customPart.js — forms never see the relative sizing mode.
   ─────────────────────────────────────────────────────────────── */

import {
  Group,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  TorusGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  Euler,
  Vector2,
  Vector3,
} from 'three';

import { shell, revolveSection, addGeom, strutBetween, collect, partMeshes } from './meshkit.js';
import { wettedArea } from './profile.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ── Parameter spec helpers ────────────────────────────────────
   A length carries two ranges: one for absolute sizing (metres, shown
   as mm) and one for relative sizing (multiples of the mount radius).
   That is what lets a flange defined at 1.06 × chamber radius stay a
   flange when the throat radius changes underneath it.               */

function len(label, def, relDef, abs = [0.002, 2.0], rel = [0.01, 4]) {
  return { label, kind: 'len', def, relDef, abs, rel };
}
function tally(label, def, min, max) {
  return { label, kind: 'count', def, min, max, step: 1 };
}
function angle(label, def, min, max) {
  return { label, kind: 'angle', def, min, max, step: 1, unit: '°' };
}

/** Everything `measure` may report. Absent fields simply disable a check. */
function measured(m) {
  return {
    volume: 0,        // material volume, m³ → mass
    area: 0,          // total exposed surface, m²
    section: 0,       // load-bearing area normal to the engine axis, m²
    boreRadius: 0,    // membrane radius of curvature, m
    boreWall: 0,      // membrane wall thickness, m
    boreFactor: 1,    // 1 = cylindrical membrane, 0.5 = spherical
    tipRadius: 0,     // outermost radius, m
    span: 0,          // axial extent, m
    flowArea: 0,      // internal flow area, m²
    flowLength: 0,    // wetted flow path length, m
    hydraulicD: 0,    // hydraulic diameter, m
    struts: null,     // { count, length, radius, wall, cos } for buckling
    ...m,
  };
}

/* ── Forms ─────────────────────────────────────────────────────── */

export const FORMS = {
  ring: {
    label: 'Ring / flange',
    blurb: 'A revolved rectangular section. Bolt flanges, stiffening rings, shear ties.',
    duty: 'structure',
    mount: 'chamber',
    params: {
      radius: len('Ring radius', 0.22, 1.06, [0.01, 2.0], [0.2, 3]),
      width: len('Section width', 0.03, 0.14, [0.002, 0.4], [0.02, 0.8]),
      height: len('Section height', 0.02, 0.09, [0.002, 0.3], [0.01, 0.6]),
    },
    build(d, g) {
      const ri = Math.max(0, d.radius - d.width / 2);
      const ro = d.radius + d.width / 2;
      const h = d.height / 2;
      revolveSection(g, [[ri, -h], [ro, -h], [ro, h], [ri, h]]);
    },
    measure(d) {
      const ri = Math.max(0, d.radius - d.width / 2);
      const ro = d.radius + d.width / 2;
      const face = Math.PI * (ro * ro - ri * ri);
      return measured({
        volume: face * d.height,
        area: 2 * face + TAU * (ro + ri) * d.height,
        section: face,
        boreRadius: ri,
        boreWall: d.width,
        tipRadius: ro,
        span: d.height,
      });
    },
  },

  shell: {
    label: 'Conic shell',
    blurb: 'A revolved wall between two radii. Skirts, nozzle extensions, liner sections, interstages.',
    duty: 'hotgas',
    mount: 'exit',
    material: 'nb_c103',
    params: {
      radiusTop: len('Top radius', 0.2, 1.0, [0.005, 2], [0.05, 3]),
      radiusBottom: len('Bottom radius', 0.3, 1.5, [0.005, 2], [0.05, 3]),
      length: len('Length', 0.25, 1.1, [0.01, 2.5], [0.05, 5]),
      wall: len('Wall thickness', 0.003, 0.018, [0.0005, 0.05], [0.002, 0.12]),
    },
    build(d, g) {
      const pts = [];
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        pts.push(new Vector2(
          d.radiusTop + (d.radiusBottom - d.radiusTop) * t,
          d.length / 2 - d.length * t
        ));
      }
      g.add(shell(pts, d.wall));
    },
    measure(d) {
      const slant = Math.hypot(d.radiusBottom - d.radiusTop, d.length);
      const mean = (d.radiusTop + d.radiusBottom) / 2;
      const face = Math.PI * (d.radiusTop + d.radiusBottom) * slant; // Pappus
      return measured({
        volume: face * d.wall,
        area: 2 * face,
        section: TAU * mean * d.wall,
        boreRadius: mean,
        boreWall: d.wall,
        tipRadius: Math.max(d.radiusTop, d.radiusBottom),
        span: d.length,
        flowArea: Math.PI * mean * mean,
        flowLength: d.length,
        hydraulicD: 2 * mean,
      });
    },
  },

  dome: {
    label: 'Dome / closure',
    blurb: 'An elliptical cap. Tank bulkheads, injector domes, pressure closures.',
    duty: 'pressure',
    mount: 'injector',
    params: {
      radius: len('Base radius', 0.2, 1.0, [0.01, 2], [0.05, 3]),
      height: len('Dome height', 0.12, 0.55, [0.005, 1.5], [0.02, 2.5]),
      wall: len('Wall thickness', 0.004, 0.022, [0.0005, 0.06], [0.002, 0.14]),
    },
    build(d, g) {
      const pts = [];
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const a = (Math.PI / 2) * (i / N);
        pts.push(new Vector2(d.radius * Math.cos(a), d.height * Math.sin(a)));
      }
      g.add(shell(pts, d.wall));
      g.userData.meridian = pts;
    },
    measure(d) {
      const pts = [];
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const a = (Math.PI / 2) * (i / N);
        pts.push(new Vector2(d.radius * Math.cos(a), d.height * Math.sin(a)));
      }
      const face = wettedArea(pts);
      // Membrane stress at the crown of an ellipsoid is set by the crown
      // radius of curvature R²/h, not the base radius — which is exactly
      // why shallow domes are the ones that fail.
      const crown = d.height > 0 ? (d.radius * d.radius) / d.height : d.radius;
      return measured({
        volume: face * d.wall,
        area: 2 * face,
        section: TAU * d.radius * d.wall,
        boreRadius: crown,
        boreWall: d.wall,
        boreFactor: 0.5, // spherical membrane carries hoop at half a cylinder's
        tipRadius: d.radius,
        span: d.height,
        flowArea: Math.PI * d.radius * d.radius,
        flowLength: d.height,
        hydraulicD: 2 * d.radius,
      });
    },
  },

  plate: {
    label: 'Ported plate',
    blurb: 'An annular plate drilled with a port ring. Faceplates, baffles, orifice and splash plates.',
    duty: 'structure',
    mount: 'injector',
    params: {
      outerRadius: len('Outer radius', 0.22, 1.0, [0.01, 2], [0.05, 3]),
      innerRadius: len('Inner radius', 0.04, 0.14, [0, 1.5], [0, 2.5]),
      thickness: len('Thickness', 0.012, 0.055, [0.001, 0.15], [0.005, 0.4]),
      ports: tally('Port count', 24, 0, 96),
      portRadius: len('Port radius', 0.006, 0.028, [0.0005, 0.08], [0.002, 0.25]),
    },
    build(d, g) {
      const ri = Math.min(d.innerRadius, d.outerRadius * 0.95);
      const t = d.thickness / 2;
      revolveSection(g, [[ri, -t], [d.outerRadius, -t], [d.outerRadius, t], [ri, t]]);

      const n = Math.round(d.ports);
      if (n > 0 && d.portRadius > 0) {
        const orbit = (ri + d.outerRadius) / 2;
        const port = collect(g, new CylinderGeometry(d.portRadius, d.portRadius, d.thickness * 1.35, 10, 1, true));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU;
          addGeom(g, port, new Vector3(Math.cos(a) * orbit, 0, Math.sin(a) * orbit), null, { rim: 1.5, wire: false });
        }
      }
    },
    measure(d) {
      const ri = Math.min(d.innerRadius, d.outerRadius * 0.95);
      const n = Math.round(d.ports);
      const face = Math.PI * (d.outerRadius * d.outerRadius - ri * ri);
      const ports = n * Math.PI * d.portRadius * d.portRadius;
      const solid = Math.max(face * 0.05, face - ports);
      return measured({
        volume: solid * d.thickness,
        area: 2 * solid + TAU * (d.outerRadius + ri) * d.thickness + n * TAU * d.portRadius * d.thickness,
        section: solid,
        boreRadius: d.outerRadius,
        boreWall: d.thickness,
        tipRadius: d.outerRadius,
        span: d.thickness,
        flowArea: ports,
        flowLength: d.thickness,
        hydraulicD: 2 * d.portRadius,
      });
    },
  },

  manifold: {
    label: 'Torus manifold',
    blurb: 'A closed collector ring. Coolant inlet and outlet manifolds, distribution torus.',
    duty: 'plumbing',
    mount: 'exit',
    params: {
      ringRadius: len('Ring radius', 0.28, 1.12, [0.02, 2], [0.2, 3]),
      tubeRadius: len('Tube radius', 0.03, 0.14, [0.002, 0.4], [0.01, 0.7]),
      wall: len('Tube wall', 0.002, 0.011, [0.0004, 0.04], [0.0015, 0.1]),
    },
    build(d, g) {
      addGeom(
        g,
        new TorusGeometry(d.ringRadius, d.tubeRadius, 10, 56),
        null,
        new Euler(Math.PI / 2, 0, 0)
      );
    },
    measure(d) {
      const face = TAU * d.ringRadius * TAU * d.tubeRadius;
      return measured({
        volume: face * d.wall,
        area: 2 * face,
        section: 2 * TAU * d.ringRadius * d.wall,
        boreRadius: d.tubeRadius,
        boreWall: d.wall,
        tipRadius: d.ringRadius + d.tubeRadius,
        span: 2 * d.tubeRadius,
        flowArea: Math.PI * d.tubeRadius * d.tubeRadius,
        flowLength: TAU * d.ringRadius,
        hydraulicD: 2 * d.tubeRadius,
      });
    },
  },

  pods: {
    label: 'Pod array',
    blurb: 'A radial ring of capped cylinders. RCS pods, avionics bays, actuator housings, pressurant bottles.',
    duty: 'structure',
    mount: 'chamber',
    params: {
      count: tally('Pod count', 4, 1, 24),
      orbitRadius: len('Orbit radius', 0.34, 1.3, [0.01, 2], [0.1, 3]),
      podRadius: len('Pod radius', 0.05, 0.19, [0.004, 0.5], [0.01, 1]),
      podLength: len('Pod length', 0.18, 0.66, [0.01, 1.5], [0.03, 3]),
      wall: len('Wall thickness', 0.0025, 0.011, [0.0005, 0.04], [0.002, 0.1]),
      tilt: angle('Tilt from axis', 0, -90, 90),
    },
    build(d, g) {
      const n = Math.round(d.count);
      const body = collect(g, new CylinderGeometry(d.podRadius, d.podRadius, d.podLength, 16, 1, true));
      const nose = collect(g, new ConeGeometry(d.podRadius, d.podRadius * 1.15, 16, 1, true));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const tilt = d.tilt * DEG;
        const pod = new Group();
        for (const m of [
          ...meshPair(body, new Vector3(0, 0, 0)),
          ...meshPair(nose, new Vector3(0, d.podLength / 2 + d.podRadius * 0.575, 0)),
        ]) pod.add(m);
        pod.rotation.set(0, -a, 0);
        pod.rotateX(tilt);
        pod.position.set(Math.cos(a) * d.orbitRadius, 0, Math.sin(a) * d.orbitRadius);
        g.add(pod);
      }
    },
    measure(d) {
      const n = Math.round(d.count);
      const lateral = TAU * d.podRadius * d.podLength;
      const caps = 2 * Math.PI * d.podRadius * d.podRadius;
      const face = n * (lateral + caps);
      return measured({
        volume: face * d.wall,
        area: face,
        section: n * TAU * d.podRadius * d.wall,
        boreRadius: d.podRadius,
        boreWall: d.wall,
        tipRadius: d.orbitRadius + d.podRadius,
        span: d.podLength,
        flowArea: n * Math.PI * d.podRadius * d.podRadius * 0.4,
        flowLength: d.podLength,
        hydraulicD: 1.2 * d.podRadius,
      });
    },
  },

  truss: {
    label: 'Strut ring',
    blurb: 'A cone of tubular struts. Thrust structures and engine mounts — these fail by buckling, not by yield.',
    duty: 'structure',
    mount: 'injector',
    params: {
      count: tally('Strut count', 8, 3, 32),
      topRadius: len('Top radius', 0.18, 0.85, [0.01, 2], [0.05, 3]),
      baseRadius: len('Base radius', 0.4, 1.55, [0.01, 2], [0.05, 3]),
      height: len('Height', 0.3, 1.15, [0.02, 2.5], [0.05, 4]),
      strutRadius: len('Strut radius', 0.016, 0.065, [0.002, 0.2], [0.005, 0.5]),
      wall: len('Tube wall', 0.002, 0.009, [0.0004, 0.03], [0.0015, 0.08]),
    },
    build(d, g) {
      const n = Math.round(d.count);
      let geom = null;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const skew = TAU / (n * 2); // struts lean tangentially so the ring takes torque
        const top = new Vector3(Math.cos(a) * d.topRadius, d.height / 2, Math.sin(a) * d.topRadius);
        const base = new Vector3(
          Math.cos(a + skew) * d.baseRadius,
          -d.height / 2,
          Math.sin(a + skew) * d.baseRadius
        );
        geom = strutBetween(g, top, base, d.strutRadius, { geometry: geom }) ?? geom;
      }
    },
    measure(d) {
      const n = Math.round(d.count);
      const L = Math.hypot(d.baseRadius - d.topRadius, d.height);
      const each = TAU * d.strutRadius * d.wall;
      const cos = L > 0 ? d.height / L : 1;
      return measured({
        volume: n * each * L,
        area: n * TAU * d.strutRadius * L,
        section: n * each * cos,
        boreRadius: d.strutRadius,
        boreWall: d.wall,
        tipRadius: Math.max(d.topRadius, d.baseRadius),
        span: d.height,
        struts: { count: n, length: L, radius: d.strutRadius, wall: d.wall, cos, sectionEach: each },
      });
    },
  },

  impeller: {
    label: 'Bladed disc',
    blurb: 'A rotor: disc plus blades. Turbine wheels and pump impellers — rim stress goes as tip speed squared.',
    duty: 'rotating',
    mount: 'pump',
    params: {
      hubRadius: len('Hub radius', 0.03, 0.13, [0.004, 0.6], [0.02, 1]),
      tipRadius: len('Tip radius', 0.12, 0.46, [0.01, 1.2], [0.05, 2]),
      discThickness: len('Disc thickness', 0.012, 0.05, [0.001, 0.15], [0.005, 0.35]),
      bladeCount: tally('Blade count', 18, 3, 48),
      bladeHeight: len('Blade height', 0.03, 0.11, [0.002, 0.3], [0.005, 0.6]),
      bladeThickness: len('Blade thickness', 0.004, 0.015, [0.0005, 0.05], [0.002, 0.12]),
    },
    build(d, g) {
      const hub = Math.min(d.hubRadius, d.tipRadius * 0.9);
      const t = d.discThickness / 2;
      revolveSection(g, [[hub, -t], [d.tipRadius, -t], [d.tipRadius, t], [hub, t]]);

      const n = Math.round(d.bladeCount);
      const blade = collect(g, new BoxGeometry(d.tipRadius - hub, d.bladeHeight, d.bladeThickness));
      const span = (d.tipRadius + hub) / 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        for (const m of meshPair(blade, new Vector3(0, 0, 0), { rim: 1.5 })) {
          m.position.set(Math.cos(a) * span, 0, Math.sin(a) * span);
          m.rotation.set(0, -a, 0);
          m.rotateY(0.6); // stagger angle
          g.add(m);
        }
      }
    },
    measure(d) {
      const hub = Math.min(d.hubRadius, d.tipRadius * 0.9);
      const n = Math.round(d.bladeCount);
      const annulus = Math.PI * (d.tipRadius * d.tipRadius - hub * hub);
      const bladeSpan = d.tipRadius - hub;
      return measured({
        volume: annulus * d.discThickness + n * bladeSpan * d.bladeHeight * d.bladeThickness,
        area: 2 * annulus + TAU * d.tipRadius * d.discThickness + n * 2 * bladeSpan * d.bladeHeight,
        section: annulus,
        boreRadius: hub,
        boreWall: d.discThickness,
        tipRadius: d.tipRadius,
        span: Math.max(d.discThickness, d.bladeHeight),
      });
    },
  },

  vanes: {
    label: 'Vane set',
    blurb: 'Radial blades on a hub circle. Swirl vanes, jet vanes, flow straighteners, radiator fins.',
    duty: 'hotgas',
    mount: 'exit',
    material: 'nb_c103',
    params: {
      count: tally('Vane count', 6, 2, 36),
      rootRadius: len('Root radius', 0.14, 0.66, [0.005, 2], [0.02, 3]),
      span: len('Span', 0.09, 0.34, [0.005, 1], [0.02, 2]),
      chord: len('Chord', 0.11, 0.42, [0.005, 1.2], [0.02, 2]),
      thickness: len('Thickness', 0.006, 0.02, [0.0006, 0.06], [0.002, 0.15]),
      incidence: angle('Incidence', 0, -75, 75),
    },
    build(d, g) {
      const n = Math.round(d.count);
      const blade = collect(g, new BoxGeometry(d.span, d.chord, d.thickness));
      const at = d.rootRadius + d.span / 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        for (const m of meshPair(blade, new Vector3(0, 0, 0))) {
          m.position.set(Math.cos(a) * at, 0, Math.sin(a) * at);
          m.rotation.set(0, -a, 0);
          m.rotateX(d.incidence * DEG);
          g.add(m);
        }
      }
    },
    measure(d) {
      const n = Math.round(d.count);
      const plan = d.span * d.chord;
      return measured({
        volume: n * plan * d.thickness,
        area: n * 2 * plan,
        section: n * d.chord * d.thickness,
        boreRadius: d.rootRadius + d.span,
        boreWall: d.thickness,
        tipRadius: d.rootRadius + d.span,
        span: d.chord,
        flowArea: Math.max(0, Math.PI * Math.pow(d.rootRadius + d.span, 2) - n * plan),
        flowLength: d.chord,
        hydraulicD: 2 * d.span,
      });
    },
  },

  coil: {
    label: 'Helical coil',
    blurb: 'A wrapped tube run. Heat exchangers, spiral cooling passes, gas generator recuperators.',
    duty: 'plumbing',
    mount: 'chamber',
    params: {
      radius: len('Coil radius', 0.26, 1.05, [0.02, 2], [0.1, 3]),
      turns: tally('Turns', 8, 1, 40),
      pitch: len('Pitch per turn', 0.035, 0.13, [0.003, 0.5], [0.01, 1]),
      tubeRadius: len('Tube radius', 0.012, 0.12, [0.001, 0.2], [0.004, 0.5]),
      wall: len('Tube wall', 0.0012, 0.005, [0.0003, 0.02], [0.001, 0.05]),
    },
    build(d, g) {
      const turns = Math.max(1, Math.round(d.turns));
      const total = turns * d.pitch;
      const pts = [];
      const steps = turns * 16;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = t * turns * TAU;
        pts.push(new Vector3(Math.cos(a) * d.radius, total / 2 - total * t, Math.sin(a) * d.radius));
      }
      const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
      addGeom(g, new TubeGeometry(curve, steps, d.tubeRadius, 8, false));
    },
    measure(d) {
      const turns = Math.max(1, Math.round(d.turns));
      const L = turns * Math.hypot(TAU * d.radius, d.pitch);
      const face = L * TAU * d.tubeRadius;
      return measured({
        volume: face * d.wall,
        area: 2 * face,
        section: 2 * TAU * d.tubeRadius * d.wall,
        boreRadius: d.tubeRadius,
        boreWall: d.wall,
        tipRadius: d.radius + d.tubeRadius,
        span: turns * d.pitch,
        flowArea: Math.PI * d.tubeRadius * d.tubeRadius,
        flowLength: L,
        hydraulicD: 2 * d.tubeRadius,
      });
    },
  },
};

export const FORM_IDS = Object.keys(FORMS);

/* ── Duties ────────────────────────────────────────────────────
   What the part is *for*. The form decides its shape and mass; the
   duty decides which failure mode gets checked against it.          */

export const DUTIES = {
  structure: {
    label: 'Load path',
    blurb: 'Carries thrust or inertial load. Checked on compressive stress, and on Euler buckling where the form is slender.',
  },
  pressure: {
    label: 'Pressure vessel',
    blurb: 'Contains internal pressure. Checked on membrane stress through the wall.',
  },
  hotgas: {
    label: 'Hot gas path',
    blurb: 'Sits in the combustion flow. Checked on wall temperature — regen-cooled by conduction, or uncooled at radiative equilibrium.',
  },
  rotating: {
    label: 'Rotating',
    blurb: 'Spins on a shaft. Checked on rim stress, which grows with the square of tip speed.',
  },
  plumbing: {
    label: 'Fluid line',
    blurb: 'Carries propellant. Checked on flow velocity and Darcy pressure drop.',
  },
  inert: {
    label: 'Inert mass',
    blurb: 'No failure check — mass, envelope and centre of gravity only.',
  },
};

export const DUTY_IDS = Object.keys(DUTIES);

/** Extra sliders the editor shows once a duty is picked. */
export const DUTY_PARAMS = {
  structure: {
    loadShare: { label: 'Share of thrust load', min: 0, max: 1, step: 0.05, def: 1, display: (v) => `${(v * 100).toFixed(0)}%` },
  },
  pressure: {
    pressureFraction: { label: 'Internal pressure', min: 0, max: 1.5, step: 0.05, def: 1, display: (v) => `${(v * 100).toFixed(0)}% Pc` },
  },
  hotgas: {},
  rotating: {
    rpm: { label: 'Shaft speed', min: 1000, max: 120000, step: 500, def: 28000, display: (v) => `${(v / 1000).toFixed(1)}k`, unit: 'rpm' },
  },
  plumbing: {
    flowShare: { label: 'Share of mass flow', min: 0.02, max: 1, step: 0.02, def: 0.12, display: (v) => `${(v * 100).toFixed(0)}%` },
  },
  inert: {},
};

/* ── internal ──────────────────────────────────────────────────── */

/**
 * Surface + wire meshes over a shared geometry, pre-positioned. Callers
 * that need their own rotation set it on the returned meshes; callers
 * that don't can hand the pair straight to a group.
 */
function meshPair(geometry, position, opts) {
  const out = partMeshes(geometry, opts);
  if (position) for (const m of out) m.position.copy(position);
  return out;
}
