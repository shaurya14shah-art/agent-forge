/* ───────────────────────────────────────────────────────────────
   Procedural rocket thruster.

   Nothing here is a loaded asset — every part is generated from the
   design parameters, so changing the throat radius or expansion ratio
   genuinely rebuilds the hardware rather than scaling a mesh.
   ─────────────────────────────────────────────────────────────── */

import {
  Group,
  Mesh,
  CylinderGeometry,
  TorusGeometry,
  TubeGeometry,
  RingGeometry,
  BoxGeometry,
  SphereGeometry,
  ConeGeometry,
  CatmullRomCurve3,
  Box3,
  Euler,
  Vector2,
  Vector3,
} from 'three';

import { buildContour, wettedArea } from './profile.js';
import { shell, addGeom, collect } from './meshkit.js';
import { buildCustomPart } from './customPart.js';
import { FORMS, DUTIES } from './forms.js';
import {
  createSurfaceMaterial,
  createWireMaterial,
  createPlumeMaterial,
  disposeMaterial,
} from '../core/holoMaterial.js';

/** Human-readable engineering notes surfaced in the inspector panel. */
export const PART_INFO = {
  injector: {
    label: 'Injector Head',
    role: 'Atomises and meters both propellants into the chamber.',
    detail:
      'Coax-swirl elements on a domed faceplate. Element count and pressure drop set combustion stability — a stiff injector (ΔP ≈ 20 % of Pc) damps chug and buzz modes.',
  },
  chamber: {
    label: 'Combustion Chamber',
    role: 'Holds the reaction long enough to reach equilibrium.',
    detail:
      'Sized by characteristic length L* = Vc/At. Too short and you lose c*; too long and you pay mass and heat load for nothing.',
  },
  throat: {
    label: 'Throat',
    role: 'Chokes the flow — sets mass flow for a given chamber pressure.',
    detail:
      'The single most thermally punished square centimetre on the vehicle. Peak heat flux lands here; erosion here changes every performance number downstream.',
  },
  nozzle: {
    label: 'Divergent Bell',
    role: 'Converts thermal energy into directed exhaust momentum.',
    detail:
      'Rao thrust-optimised parabolic contour. Turns hard at the throat, then relaxes to a shallow exit angle to keep divergence losses under ~1 %.',
  },
  cooling: {
    label: 'Regenerative Cooling Jacket',
    role: 'Runs fuel through the wall before burning it.',
    detail:
      'Milled channels or brazed tubes. Channel count trades heat-transfer coefficient against pressure drop — more channels cool better and cost you pump work.',
  },
  manifold: {
    label: 'Coolant Manifolds',
    role: 'Collects and distributes coolant at both ends of the jacket.',
    detail:
      'Downcomer feeds the exit manifold; flow turns and climbs back to the injector, arriving hot and ready to burn.',
  },
  gimbal: {
    label: 'Gimbal Assembly',
    role: 'Vectors thrust for attitude and trajectory control.',
    detail:
      'Two orthogonal hydraulic actuators on a flex bearing. Deflection authority is normally ±5° to ±8°.',
  },
  turbopump: {
    label: 'Turbopump Assembly',
    role: 'Raises propellant pressure above chamber pressure.',
    detail:
      'Common shaft, one turbine driving both impellers. Pump discharge must clear Pc plus injector ΔP plus jacket losses.',
  },
  feedlines: {
    label: 'Propellant Feed Lines',
    role: 'High-pressure runs from pump discharge to injector.',
    detail:
      'Flex joints absorb gimbal travel. Line sizing sets flow velocity — keep it under ~15 m/s to avoid water-hammer on shutdown.',
  },
  igniter: {
    label: 'Torch Igniter',
    role: 'Provides the ignition source at chamber pressure.',
    detail:
      'A small pre-burner producing a hot gas jet. Ignition timing relative to main valve sequence is what keeps a start from becoming a hard start.',
  },
};

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);

/**
 * @param {object} params  design parameters (see state/store.js DEFAULTS)
 * @param {object[]} customParts  operator- or agent-authored part definitions
 * @returns {{group: Group, parts: Object, contour: object, metrics: object, dispose: Function}}
 */
export function buildThruster(params, customParts = []) {
  const contour = buildContour(params);
  const { Rt, Rc, Re, yInjector, yChamberEnd, yChamberStart, yExit } = contour;

  const wall = Math.max(0.0025, Rt * (params.wallThickness ?? 0.075));
  const root = new Group();
  root.name = 'thruster';
  const parts = {};

  const register = (id, obj, explode) => {
    obj.name = id;
    obj.userData.partId = id;
    obj.userData.explode = explode;
    obj.userData.home = obj.position.clone();
    obj.traverse((o) => {
      o.userData.partId = id;
    });
    root.add(obj);
    parts[id] = obj;
    return obj;
  };

  // ── Injector head ───────────────────────────────────────────
  {
    const g = shell(contour.dome, wall);

    // Faceplate
    const face = new RingGeometry(Rt * 0.12, Rc * 0.985, 48, 1);
    addGeom(g, face, new Vector3(0, yChamberEnd + 0.002, 0), eulerX(-Math.PI / 2));

    // Coax-swirl elements in concentric rings
    const rings = 3;
    const elemGeom = new CylinderGeometry(Rc * 0.035, Rc * 0.045, wall * 3.2, 8, 1, true);
    for (let ring = 0; ring < rings; ring++) {
      const rr = Rc * (0.3 + 0.28 * ring);
      const count = 6 + ring * 6;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + ring * 0.3;
        const m = new Mesh(elemGeom, createSurfaceMaterial({ rim: 0.85, opacity: 0.75 }));
        m.position.set(Math.cos(a) * rr, yChamberEnd + wall * 1.2, Math.sin(a) * rr);
        m.renderOrder = 2;
        g.add(m);
      }
    }
    collect(g, elemGeom);

    // Dome flange
    const flange = new TorusGeometry(Rc * 1.03, wall * 1.5, 8, 44);
    addGeom(g, flange, new Vector3(0, yChamberEnd, 0), eulerX(Math.PI / 2));

    register('injector', g, { dir: UP.clone(), dist: 0.62 });
  }

  // ── Combustion chamber + convergent section ─────────────────
  {
    const merged = [...contour.chamber, ...contour.converge.slice(1)];
    const g = shell(merged, wall);
    register('chamber', g, { dir: UP.clone(), dist: 0.26 });
  }

  // ── Throat band ─────────────────────────────────────────────
  {
    const g = shell(contour.throat, wall * 1.35);
    // Sensor collar — the throat is where you instrument
    const collar = new TorusGeometry(Rt * 1.55, wall * 0.8, 6, 40);
    addGeom(g, collar, new Vector3(0, 0, 0), eulerX(Math.PI / 2));
    register('throat', g, { dir: new Vector3(0, 0, 0), dist: 0 });
  }

  // ── Divergent bell ──────────────────────────────────────────
  {
    const g = shell(contour.diverge, wall);
    // Exit lip stiffener
    const lip = new TorusGeometry(Re * 1.005, wall * 1.4, 8, 64);
    addGeom(g, lip, new Vector3(0, yExit, 0), eulerX(Math.PI / 2));
    register('nozzle', g, { dir: DOWN.clone(), dist: 0.5 });
  }

  // ── Regenerative cooling jacket ─────────────────────────────
  {
    const g = new Group();
    const tubeR = wall * 0.95;
    const off = wall * 1.15 + tubeR;

    const path = contour.all
      .filter((p) => p.y <= yChamberEnd + 1e-6)
      .map((p) => new Vector2(p.x, p.y));

    if (path.length > 3) {
      const pts = path.map((p) => new Vector3(p.x + off, p.y, 0));
      const curve = new CatmullRomCurve3(pts, false, 'catmullrom', 0.25);
      const tubeGeom = new TubeGeometry(curve, 64, tubeR, 6, false);
      const count = Math.min(64, Math.max(8, Math.round(params.coolingChannels ?? 40)));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        const m = new Mesh(tubeGeom, createSurfaceMaterial({ rim: 1.0, opacity: 0.7 }));
        m.rotation.y = a;
        m.renderOrder = 2;
        m.userData.radialAngle = a;
        g.add(m);
      }
      // one wireframe ghost to keep the blueprint reading without 64 wire draws
      const wm = new Mesh(tubeGeom, createWireMaterial({ opacity: 0.22 }));
      wm.renderOrder = 3;
      g.add(wm);
      g.userData.geometries = [tubeGeom];
    }
    register('cooling', g, { dir: new Vector3(1, 0, 0), dist: 0.3, radial: true });
  }

  // ── Coolant manifolds ───────────────────────────────────────
  {
    const g = new Group();
    const exitRing = new TorusGeometry(Re * 1.06, wall * 2.1, 8, 64);
    addGeom(g, exitRing, new Vector3(0, yExit + wall * 3, 0), eulerX(Math.PI / 2));

    const topRing = new TorusGeometry(Rc * 1.14, wall * 1.9, 8, 48);
    addGeom(g, topRing, new Vector3(0, yChamberStart + 0.01, 0), eulerX(Math.PI / 2));

    // Downcomer connecting the two manifolds
    const down = new CatmullRomCurve3([
      new Vector3(Rc * 1.14, yChamberStart, 0).applyAxisAngle(UP, 0.6),
      new Vector3(Rc * 1.3, (yChamberStart + yExit) * 0.5, 0).applyAxisAngle(UP, 0.6),
      new Vector3(Re * 1.06, yExit + wall * 3, 0).applyAxisAngle(UP, 0.6),
    ]);
    addGeom(g, new TubeGeometry(down, 28, wall * 1.5, 8, false));

    register('manifold', g, { dir: DOWN.clone(), dist: 0.72 });
  }

  // ── Gimbal assembly ─────────────────────────────────────────
  {
    const g = new Group();
    const ringR = Rc * 1.5;
    addGeom(g, new TorusGeometry(ringR, wall * 2.2, 10, 56), new Vector3(0, yChamberEnd * 0.55, 0), eulerX(Math.PI / 2));

    // Flex bearing at the throat plane
    addGeom(g, new SphereGeometry(Rc * 0.45, 20, 12), new Vector3(0, yChamberEnd * 0.55, 0));

    // Two orthogonal actuators
    const actLen = Rc * 1.5;
    const actGeom = new CylinderGeometry(wall * 2.4, wall * 3.0, actLen, 12, 1, true);
    for (let i = 0; i < 2; i++) {
      const a = i * (Math.PI / 2) + Math.PI / 4;
      const m = new Mesh(actGeom, createSurfaceMaterial({ rim: 1.3 }));
      m.position.set(Math.cos(a) * (ringR + actLen * 0.35), yChamberEnd * 0.75, Math.sin(a) * (ringR + actLen * 0.35));
      m.rotation.z = Math.PI / 2.6;
      m.rotation.y = -a;
      m.renderOrder = 2;
      g.add(m);
      const w = new Mesh(actGeom, createWireMaterial({ opacity: 0.28 }));
      w.position.copy(m.position);
      w.rotation.copy(m.rotation);
      w.renderOrder = 3;
      g.add(w);
    }
    collect(g, actGeom);

    register('gimbal', g, { dir: new Vector3(1, 0.25, 0).normalize(), dist: 0.5, radial: true });
  }

  // ── Turbopump assembly ──────────────────────────────────────
  {
    const g = new Group();
    const yPump = yInjector + Rc * 1.15;
    const pumpR = Rc * 0.52;

    // Oxidiser pump
    addGeom(g, new CylinderGeometry(pumpR, pumpR, Rc * 0.5, 20, 1, true), new Vector3(-Rc * 0.85, yPump, 0));
    addGeom(g, new TorusGeometry(pumpR * 1.28, pumpR * 0.36, 10, 32), new Vector3(-Rc * 0.85, yPump, 0), eulerX(Math.PI / 2));

    // Fuel pump
    addGeom(g, new CylinderGeometry(pumpR * 0.86, pumpR * 0.86, Rc * 0.42, 20, 1, true), new Vector3(Rc * 0.85, yPump, 0));
    addGeom(g, new TorusGeometry(pumpR * 1.1, pumpR * 0.3, 10, 32), new Vector3(Rc * 0.85, yPump, 0), eulerX(Math.PI / 2));

    // Common shaft
    addGeom(g, new CylinderGeometry(pumpR * 0.14, pumpR * 0.14, Rc * 1.7, 10, 1, true), new Vector3(0, yPump, 0), eulerZ(Math.PI / 2));

    // Turbine + blades
    addGeom(g, new CylinderGeometry(pumpR * 0.62, pumpR * 0.62, Rc * 0.22, 18, 1, true), new Vector3(0, yPump, 0), eulerZ(Math.PI / 2));
    const blade = new BoxGeometry(Rc * 0.05, Rc * 0.2, Rc * 0.02);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const m = new Mesh(blade, createSurfaceMaterial({ rim: 1.1 }));
      m.position.set(0, yPump + Math.cos(a) * pumpR * 0.72, Math.sin(a) * pumpR * 0.72);
      m.rotation.x = -a;
      m.renderOrder = 2;
      g.add(m);
    }
    collect(g, blade);

    // Hot-gas duct down to the injector
    const duct = new CatmullRomCurve3([
      new Vector3(0, yPump - Rc * 0.3, pumpR * 0.7),
      new Vector3(0, yPump - Rc * 0.9, Rc * 0.9),
      new Vector3(0, yInjector + Rc * 0.05, Rc * 0.5),
    ]);
    addGeom(g, new TubeGeometry(duct, 24, wall * 2.4, 10, false));

    register('turbopump', g, { dir: new Vector3(0.3, 1, 0).normalize(), dist: 1.0 });
  }

  // ── Feed lines ──────────────────────────────────────────────
  {
    const g = new Group();
    const yPump = yInjector + Rc * 1.15;
    const mk = (x, phase, radius) => {
      const c = new CatmullRomCurve3([
        new Vector3(x, yPump - Rc * 0.42, 0).applyAxisAngle(UP, phase),
        new Vector3(x * 1.35, yPump - Rc * 0.95, Rc * 0.35).applyAxisAngle(UP, phase),
        new Vector3(x * 1.1, yChamberEnd + Rc * 0.35, Rc * 0.6).applyAxisAngle(UP, phase),
        new Vector3(x * 0.55, yChamberEnd + Rc * 0.06, Rc * 0.45).applyAxisAngle(UP, phase),
      ]);
      addGeom(g, new TubeGeometry(c, 40, radius, 10, false));
      // flex bellows
      for (let i = 0; i < 4; i++) {
        const p = c.getPointAt(0.42 + i * 0.05);
        addGeom(g, new TorusGeometry(radius * 1.55, radius * 0.35, 6, 20), p, eulerX(Math.PI / 2));
      }
    };
    mk(-Rc * 0.85, 0, wall * 2.6);      // oxidiser
    mk(Rc * 0.85, Math.PI, wall * 2.0); // fuel

    register('feedlines', g, { dir: new Vector3(0.9, 0.2, 0.35).normalize(), dist: 0.85 });
  }

  // ── Torch igniter ───────────────────────────────────────────
  {
    const g = new Group();
    const y = yChamberEnd - Rc * 0.18;
    addGeom(
      g,
      new CylinderGeometry(Rc * 0.11, Rc * 0.14, Rc * 0.75, 14, 1, true),
      new Vector3(-Rc * 1.05, y, 0),
      eulerZ(Math.PI / 2.4)
    );
    addGeom(g, new ConeGeometry(Rc * 0.09, Rc * 0.22, 12, 1, true), new Vector3(-Rc * 0.72, y - Rc * 0.14, 0), eulerZ(-Math.PI / 2.4));
    register('igniter', g, { dir: new Vector3(-1, 0.3, 0).normalize(), dist: 0.7 });
  }

  // ── Custom parts ────────────────────────────────────────────
  // Authored hardware is registered exactly like stock hardware: it is
  // pickable, selectable, explodable, sliced by the cutaway plane and
  // counted in the envelope. The only difference is where the geometry
  // came from.
  const customInfo = {};
  const customDefs = [];
  for (const def of customParts) {
    const form = FORMS[def.form];
    if (!form) continue;
    const built = buildCustomPart(def, contour);
    if (!built.group.children.length) continue;

    customInfo[def.id] = {
      label: def.name,
      role: form.blurb,
      detail: `${DUTIES[def.duty].blurb} Mounted at the ${built.mount.label.toLowerCase()}, ${
        def.sizing === 'relative'
          ? 'sized relative to that station — it tracks the engine as the design changes.'
          : 'sized in absolute millimetres — it holds its dimensions as the engine changes.'
      }`,
      custom: true,
    };
    customDefs.push({ def, mount: built.mount, dims: built.dims, y: built.y });
    register(def.id, built.group, built.explode);
  }

  // ── Exhaust plume (non-pickable, hidden until a burn) ───────
  const plumeMat = createPlumeMaterial();
  const plumeLen = (yInjector - yExit) * 3.4;
  const plumeGeom = new CylinderGeometry(Re * 0.94, Re * 2.5, plumeLen, 40, 40, true);
  const plume = new Mesh(plumeGeom, plumeMat);
  plume.position.set(0, yExit - plumeLen / 2, 0);
  plume.renderOrder = 6;
  plume.visible = false;
  plume.name = 'plume';
  plume.userData.noPick = true;
  root.add(plume);

  // True envelope of the hardware (turbopump and feed lines overhang the
  // thrust chamber), used to frame the projection at a constant size.
  const bounds = new Box3();
  for (const part of Object.values(parts)) bounds.expandByObject(part);

  const metrics = {
    height: yInjector - yExit,          // thrust-chamber length, reported to the user
    envelopeHeight: bounds.max.y - bounds.min.y,
    envelopeRadius: Math.max(
      Math.abs(bounds.max.x), Math.abs(bounds.min.x),
      Math.abs(bounds.max.z), Math.abs(bounds.min.z)
    ),
    envelopeCenterY: (bounds.max.y + bounds.min.y) / 2,
    exitDiameter: Re * 2,
    throatDiameter: Rt * 2,
    chamberDiameter: Rc * 2,
    centerY: (yInjector + yExit) / 2,
    yInjector,
    yExit,
    wall,
    wettedArea: wettedArea(contour.all),
  };

  const dispose = () => {
    root.traverse((o) => {
      if (o.isMesh) {
        if (o.material) disposeMaterial(o.material);
      }
      if (o.userData.geometries) o.userData.geometries.forEach((g) => g.dispose());
    });
    plumeGeom.dispose();
    disposeMaterial(plumeMat);
  };

  return {
    group: root,
    parts,
    plume,
    plumeMat,
    contour,
    metrics,
    dispose,
    customDefs,
    partInfo: { ...PART_INFO, ...customInfo },
  };
}

/* ── small helpers ─────────────────────────────────────────── */

function eulerX(x) { return new Euler(x, 0, 0); }
function eulerZ(z) { return new Euler(0, 0, z); }
