/* ───────────────────────────────────────────────────────────────
   Reference geometry.

   Imported meshes are deliberately a *separate category* from the
   parametric assembly. The engine is generated from design parameters,
   which is what lets it be solved; an imported mesh has no wall
   thickness, no bore, no duty — so it is never counted in the dry mass,
   never in the centre of gravity, and never given a margin. It exists to
   sit beside the hardware for scale and context, and it says so.

   Everything is re-shaded with the hologram material on the way in, so a
   downloaded asset reads as part of the projection rather than as a
   photograph someone dropped into it.
   ─────────────────────────────────────────────────────────────── */

import { Group, Box3, Vector3, LoadingManager, MeshBasicMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { createSurfaceMaterial, createWireMaterial } from '../core/holoMaterial.js';

const PROXY = '/api/models/proxy?url=';

export const IMPORT_FORMATS = ['gltf', 'glb', 'obj', 'stl'];

const TEXTURE_RE = /\.(jpe?g|png|webp|avif|ktx2?|basis|bmp|tga)(\?|$)/i;

/** Transparent 1×1 PNG — stands in for textures we are going to discard. */
const BLANK_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function proxied(url) {
  return url.startsWith('/api/') ? url : PROXY + encodeURIComponent(url);
}

/**
 * A glTF is rarely one file — it references .bin buffers and textures by
 * relative URL. Two things have to happen for that to work here:
 *
 *  1. Everything goes through the proxy, so no per-host CORS is needed.
 *  2. Dependencies are looked up in the catalogue's own manifest first.
 *     They are not reliably stored beside the glTF — Poly Haven keeps a
 *     1k glTF's buffer under gltf/8k/ and its textures under jpg/ — so
 *     resolving relative to the glTF's URL quietly 404s.
 */
function proxyManager(baseUrl, include = {}) {
  // Key the manifest by its path tail so it can be matched against the
  // absolute URL three.js hands the modifier.
  const manifest = Object.entries(include).map(([rel, abs]) => ({
    tail: rel.replace(/^\.?\//, ''),
    abs,
  }));

  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    if (url.startsWith('/api/models/proxy')) return url;

    // Every source material is discarded and replaced with the hologram
    // shader, so downloading and decoding the asset's textures is pure
    // waste — typically three JPEGs per model, fetched only to be thrown
    // away. Satisfy the request with a 1×1 pixel instead.
    if (TEXTURE_RE.test(url)) return BLANK_PIXEL;

    const hit = manifest.find((m) => url.endsWith(m.tail));
    if (hit) return proxied(hit.abs);

    try {
      return proxied(new URL(url, baseUrl).href);
    } catch {
      return url;
    }
  });
  return manager;
}

function formatOf(url) {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.glb')) return 'glb';
  if (clean.endsWith('.gltf')) return 'gltf';
  if (clean.endsWith('.obj')) return 'obj';
  if (clean.endsWith('.stl')) return 'stl';
  return 'gltf';
}

/**
 * Load a mesh and normalise it into the projection.
 *
 * @param {string} url        source URL (proxied automatically)
 * @param {object} opts
 * @param {number} opts.size  target height in world units
 * @param {object} opts.include  catalogue manifest of relative path -> absolute URL
 * @returns {Promise<{group: Group, stats: object, dispose: Function}>}
 */
export async function importModel(url, { size = 1.6, include = {} } = {}) {
  const format = formatOf(url);
  const manager = proxyManager(url, include);
  const fetchUrl = proxied(url);

  let raw;
  if (format === 'glb' || format === 'gltf') {
    const gltf = await new GLTFLoader(manager).loadAsync(fetchUrl);
    raw = gltf.scene;
  } else if (format === 'obj') {
    raw = await new OBJLoader(manager).loadAsync(fetchUrl);
  } else {
    const geom = await new STLLoader(manager).loadAsync(fetchUrl);
    raw = new Group();
    const { Mesh } = await import('three');
    raw.add(new Mesh(geom, new MeshBasicMaterial()));
  }

  const group = new Group();
  group.name = 'imported';
  const geometries = [];
  let triangles = 0;
  let meshes = 0;

  // Re-shade into the hologram. The source material is discarded outright —
  // a lit PBR asset next to an additive projection reads as a mistake.
  raw.updateWorldMatrix(true, true);
  raw.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    meshes++;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    geometries.push(g);
    triangles += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;

    const surface = new (o.constructor)(g, createSurfaceMaterial({ rim: 1.0, opacity: 0.9 }));
    surface.renderOrder = 2;
    group.add(surface);

    // One wireframe pass, only where the mesh is light enough to carry it.
    if (triangles < 220000) {
      const wire = new (o.constructor)(g, createWireMaterial({ opacity: 0.16 }));
      wire.renderOrder = 3;
      group.add(wire);
    }
  });

  if (!meshes) throw new Error('That file contained no renderable geometry.');

  // Normalise: centre on the origin, sit on the deck, scale to `size`.
  const box = new Box3().setFromObject(group);
  const span = new Vector3();
  box.getSize(span);
  const centre = new Vector3();
  box.getCenter(centre);
  const scale = size / Math.max(1e-4, Math.max(span.x, span.y, span.z));

  for (const child of group.children) {
    child.position.sub(centre);
  }
  group.scale.setScalar(scale);

  group.userData.geometries = geometries;

  return {
    group,
    stats: {
      format,
      meshes,
      triangles: Math.round(triangles),
      // Reported in the asset's own units, before normalisation — the only
      // dimensional fact about an import that means anything.
      sourceSpan: { x: span.x, y: span.y, z: span.z },
      normalisedTo: size,
    },
    dispose() {
      for (const g of geometries) g.dispose();
      group.traverse((o) => o.material?.dispose?.());
    },
  };
}

/* ── Search client ──────────────────────────────────────────────── */

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || `Request failed (${r.status}).`);
  return body;
}

export function searchModels(query, limit = 8) {
  return getJson(`/api/models/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function resolveModel(provider, id) {
  return getJson(`/api/models/resolve?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`);
}

export function modelProviders() {
  return getJson('/api/models/status');
}
