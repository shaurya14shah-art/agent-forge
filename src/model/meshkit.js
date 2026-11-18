/* ───────────────────────────────────────────────────────────────
   Shared hologram mesh construction.

   Both the stock thruster and the custom-part forms build hardware the
   same way: a Fresnel surface pass plus a coarse wireframe "blueprint"
   pass over the same geometry, with every BufferGeometry recorded on
   the group so a rebuild can dispose of it.
   ─────────────────────────────────────────────────────────────── */

import {
  Group,
  Mesh,
  LatheGeometry,
  CylinderGeometry,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';

import { thicken } from './profile.js';
import { createSurfaceMaterial, createWireMaterial } from '../core/holoMaterial.js';

const UP = new Vector3(0, 1, 0);

/** Record a geometry on a group so `dispose()` can reach it later. */
export function collect(group, geometry) {
  (group.userData.geometries ||= []).push(geometry);
  return geometry;
}

/** Surface + wireframe pair over one geometry. */
export function partMeshes(geometry, { wire = true, rim, opacity } = {}) {
  const surface = new Mesh(geometry, createSurfaceMaterial({ rim, opacity }));
  surface.renderOrder = 2;
  const out = [surface];
  if (wire) {
    const w = new Mesh(geometry, createWireMaterial({ opacity: 0.32 }));
    w.renderOrder = 3;
    out.push(w);
  }
  return out;
}

/** Add a geometry to a group as a surface + wire pair at a given transform. */
export function addGeom(group, geometry, position, rotation, opts) {
  for (const m of partMeshes(geometry, opts)) {
    if (position) m.position.copy(position);
    if (rotation) m.rotation.copy(rotation);
    group.add(m);
  }
  collect(group, geometry);
  return group;
}

/**
 * Revolve a meridian polyline into a shell with real wall thickness,
 * plus a low-resolution wireframe for the blueprint overlay.
 */
export function shell(points, wallThickness, { seg = 96, wireSeg = 26 } = {}) {
  const contour = thicken(points, wallThickness);
  const g = new Group();

  const solid = new LatheGeometry(contour, seg);
  solid.computeVertexNormals();
  const surface = new Mesh(solid, createSurfaceMaterial());
  surface.renderOrder = 2;
  g.add(surface);

  const coarse = new LatheGeometry(contour, wireSeg);
  const wire = new Mesh(coarse, createWireMaterial({ opacity: 0.3 }));
  wire.renderOrder = 3;
  g.add(wire);

  g.userData.geometries = [solid, coarse];
  return g;
}

/**
 * Revolve an already-closed section outline (e.g. the rectangle of a
 * flange). Unlike `shell` the caller supplies the full loop, so sections
 * with square corners stay square.
 */
export function revolveSection(group, loop, { seg = 72, wireSeg = 24 } = {}) {
  const pts = loop.map(([x, y]) => new Vector2(Math.max(0, x), y));
  pts.push(pts[0].clone());

  const solid = new LatheGeometry(pts, seg);
  solid.computeVertexNormals();
  const surface = new Mesh(solid, createSurfaceMaterial());
  surface.renderOrder = 2;
  group.add(surface);

  const coarse = new LatheGeometry(pts, wireSeg);
  const wire = new Mesh(coarse, createWireMaterial({ opacity: 0.3 }));
  wire.renderOrder = 3;
  group.add(wire);

  collect(group, solid);
  collect(group, coarse);
  return group;
}

/**
 * A capped cylinder spanning two arbitrary points — struts, actuators,
 * tie rods. Returns the geometry so callers can reuse it across a ring
 * of identical members instead of allocating one per strut.
 */
export function strutBetween(group, a, b, radius, { radialSeg = 10, geometry } = {}) {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return null;

  const geom = geometry ?? collect(group, new CylinderGeometry(radius, radius, len, radialSeg, 1, true));
  const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5);

  for (const m of partMeshes(geom)) {
    m.position.copy(mid);
    m.quaternion.copy(q);
    group.add(m);
  }
  return geom;
}
