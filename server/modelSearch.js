/* ───────────────────────────────────────────────────────────────
   Reference-model search and fetch.

   Two jobs, both of which have to happen server-side:

     • Search. Model catalogues are third-party APIs; some need keys, and
       none of them send CORS headers a browser will accept.
     • Fetch. A glTF is rarely one file — it pulls .bin buffers and
       textures by relative URL. The client points its loader's URL
       resolver at /proxy here, so every dependency comes back through
       one allowlisted hop instead of needing per-host CORS.

   Poly Haven is the zero-configuration provider: everything on it is
   CC0, and no key is required. Anything else is opt-in through .env.
   ─────────────────────────────────────────────────────────────── */

const UA = 'agent-forge/1.0 (propulsion design workbench)';

/** Only these hosts may be proxied. An open proxy is a liability. */
const ALLOWED_HOSTS = new Set([
  'api.polyhaven.com',
  'cdn.polyhaven.com',
  'dl.polyhaven.org',
  'huggingface.co',
  'raw.githubusercontent.com',
  'threejs.org',
]);

const MAX_BYTES = 48 * 1024 * 1024; // a reference mesh, not a film asset

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/* ── Poly Haven ─────────────────────────────────────────────────── */

let catalogue = null;
let catalogueAt = 0;
const CATALOGUE_TTL = 30 * 60 * 1000;

async function polyHavenCatalogue() {
  if (catalogue && Date.now() - catalogueAt < CATALOGUE_TTL) return catalogue;
  const r = await fetch('https://api.polyhaven.com/assets?t=models', {
    headers: { 'User-Agent': UA },
  });
  if (!r.ok) throw new Error(`Poly Haven catalogue returned ${r.status}`);
  const data = await r.json();
  catalogue = Object.entries(data).map(([slug, a]) => ({
    slug,
    name: a.name ?? slug,
    tags: [...(a.tags ?? []), ...(a.categories ?? [])].map((t) => String(t).toLowerCase()),
    authors: Object.keys(a.authors ?? {}),
  }));
  catalogueAt = Date.now();
  return catalogue;
}

/**
 * Rank by how well the query words hit the name and tags. Deliberately
 * simple: the catalogue is small, and a wrong-but-fast answer the operator
 * can see and reject beats a slow clever one.
 */
function scoreAsset(asset, words) {
  const name = asset.name.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const w of words) {
    if (!w) continue;
    let word = 0;
    if (name === w) word += 12;
    else if (name.includes(w)) word += 6;
    if (asset.tags.includes(w)) word += 4;
    else if (asset.tags.some((t) => t.includes(w))) word += 2;
    if (word > 0) hits++;
    score += word;
  }
  // Coverage — the fraction of the query actually accounted for — matters more
  // than raw score. "iron man suit" hits "Large Iron Gate" on one word out of
  // three and scores respectably, which is how a confident search ends up
  // handing back something the operator plainly did not ask for.
  return { score, coverage: words.length ? hits / words.length : 0 };
}

async function searchPolyHaven(query, limit) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  const assets = await polyHavenCatalogue();

  return assets
    .map((a) => ({ a, ...scoreAsset(a, words) }))
    .filter((x) => x.score > 0)
    // Rank by coverage first: a result that answers the whole query beats one
    // that answers a third of it loudly.
    .sort((x, y) => y.coverage - x.coverage || y.score - x.score)
    .slice(0, limit)
    .map(({ a, score, coverage }) => ({
      provider: 'polyhaven',
      id: a.slug,
      name: a.name,
      score,
      coverage,
      author: a.authors.join(', ') || 'Poly Haven',
      license: 'CC0',
      tags: a.tags.slice(0, 8),
      thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${a.slug}.png?width=256`,
    }));
}

/** Resolve a Poly Haven slug to the smallest available glTF. */
async function resolvePolyHaven(slug) {
  const r = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': UA },
  });
  if (!r.ok) throw new Error(`Poly Haven files returned ${r.status}`);
  const files = await r.json();
  const gltf = files.gltf;
  if (!gltf) throw new Error('That asset has no glTF export.');

  // Prefer the lowest resolution present — this is reference geometry sitting
  // beside a hologram, not a hero asset, and 8k textures cost seconds.
  const res = Object.keys(gltf).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))[0];
  const entry = gltf[res]?.gltf;
  if (!entry?.url) throw new Error('That asset has no downloadable glTF file.');

  // Dependencies do NOT live beside the glTF: the buffer sits under
  // gltf/8k/ while a 1k glTF sits under gltf/1k/, and textures are under
  // jpg/. Resolving them relative to the glTF's own URL 404s, and a 404
  // body parsed as a binary buffer fails deep inside the glTF reader with
  // an error that points nowhere near the cause. The API hands us an
  // explicit map, so pass it through and let the client honour it.
  const include = {};
  for (const [rel, file] of Object.entries(entry.include ?? {})) {
    if (file?.url) include[rel] = file.url;
  }
  return { url: entry.url, resolution: res, format: 'gltf', include };
}

/* ── Objaverse ───────────────────────────────────────────────────
   Poly Haven is ~180 curated props. That is a decent props library and a
   poor answer to "find me a model of X" — most ordinary nouns miss it
   outright. Objaverse is the breadth: 800k objects, of which the LVIS
   annotation set labels ~46k across 1,156 named categories.

   Two index files are needed and both are large, so they load once in the
   background at startup rather than on the first search. Only the paths
   for LVIS-labelled uids are retained — keeping all 800k would cost an
   order of magnitude more memory for objects that have no searchable
   label anyway.

   Everything here is a single-file .glb, so unlike Poly Haven there are no
   external buffers or textures to resolve.                              */

const HF = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main';

let objaverse = null;      // { categories: Map<name, uids[]>, paths: Map<uid, path> }
let objaverseLoad = null;  // in-flight promise
let objaverseError = null;

async function fetchGz(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const { gunzipSync } = await import('node:zlib');
  return JSON.parse(gunzipSync(buf).toString('utf8'));
}

function loadObjaverse() {
  if (objaverse || objaverseLoad) return objaverseLoad ?? Promise.resolve(objaverse);

  objaverseLoad = (async () => {
    const [lvis, allPaths] = await Promise.all([
      fetchGz(`${HF}/lvis-annotations.json.gz`),
      fetchGz(`${HF}/object-paths.json.gz`),
    ]);

    const categories = new Map();
    const wanted = new Set();
    for (const [name, uids] of Object.entries(lvis)) {
      if (!uids?.length) continue;
      categories.set(name, uids);
      for (const uid of uids) wanted.add(uid);
    }

    // Retain only what is reachable by search.
    const paths = new Map();
    for (const [uid, path] of Object.entries(allPaths)) {
      if (wanted.has(uid)) paths.set(uid, path);
    }

    objaverse = { categories, paths };
    objaverseLoad = null;
    console.log(
      `[agent-forge] Objaverse ready — ${categories.size} categories, ${paths.size} objects.`
    );
    return objaverse;
  })().catch((err) => {
    objaverseError = err.message;
    objaverseLoad = null;
    console.warn('[agent-forge] Objaverse index failed:', err.message);
    return null;
  });

  return objaverseLoad;
}

/**
 * Everyday words the LVIS vocabulary happens not to use, mapped to the term
 * it does. Only genuine equivalents belong here — mapping "satellite" onto
 * "space shuttle" because both are spacey is the same error as answering
 * "iron man suit" with an iron gate, and the point of the coverage check is
 * to stop exactly that.
 */
const SYNONYMS = {
  spaceship: 'space shuttle',
  spacecraft: 'space shuttle',
  starship: 'space shuttle',
  shuttle: 'space shuttle',
  aircraft: 'airplane',
  aeroplane: 'airplane',
  plane: 'airplane',
  jet: 'jet plane',
  automobile: 'car',
  auto: 'car',
  motorbike: 'motorcycle',
  bike: 'bicycle',
  sofa: 'couch',
  settee: 'couch',
  fridge: 'refrigerator',
  telly: 'television set',
  tv: 'television set',
  mobile: 'cellular telephone',
  phone: 'telephone',
  torch: 'flashlight',
  spanner: 'wrench',
  lorry: 'truck',
  tin: 'can',
  barrel: 'barrel',
  crate: 'crate',
};

function expandQuery(words) {
  const out = new Set(words);
  for (const w of words) {
    const syn = SYNONYMS[w];
    if (syn) for (const part of syn.split(' ')) out.add(part);
  }
  return [...out];
}

/** `car_(automobile)` → `car automobile`; `football_helmet` → `football helmet`. */
function readableCategory(raw) {
  return raw.replace(/[_()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function searchObjaverse(query, limit) {
  const index = await loadObjaverse();
  if (!index) return [];

  const asked = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!asked.length) return [];
  const words = expandQuery(asked);

  const scored = [];
  for (const [raw, uids] of index.categories) {
    const label = readableCategory(raw).toLowerCase();
    const terms = label.split(' ');

    let score = 0;
    let hits = 0;
    for (const w of words) {
      let word = 0;
      if (label === w) word += 14;
      else if (terms.includes(w)) word += 8;
      else if (label.includes(w)) word += 4;
      if (word > 0) hits++;
      score += word;
    }
    if (!score) continue;

    // Only objects that actually have a resolvable path are offerable.
    const usable = uids.filter((u) => index.paths.has(u));
    if (!usable.length) continue;

    // Coverage is judged against what was *asked*, not against the expanded
    // set — otherwise adding synonyms would quietly inflate every score.
    const hitAsked = asked.filter((w) => {
      const syn = SYNONYMS[w];
      return label.includes(w) || (syn && label.includes(syn.split(' ')[0]));
    }).length;

    scored.push({ raw, label, usable, score, coverage: hitAsked / asked.length });
  }

  scored.sort((a, b) => b.coverage - a.coverage || b.score - a.score);

  return scored.slice(0, limit).map(({ raw, label, usable, score, coverage }) => ({
    provider: 'objaverse',
    id: usable[0],
    name: titleCase(readableCategory(raw)),
    // Slightly behind Poly Haven at equal relevance: those are curated,
    // texture-complete and come with a thumbnail.
    score: score * 0.92,
    coverage,
    author: 'Objaverse (Allen Institute for AI)',
    license: 'CC-BY 4.0 and similar — check the source object',
    tags: label.split(' ').slice(0, 8),
    thumbnail: null,
    variants: usable.length,
    category: raw,
  }));
}

function resolveObjaverse(uid) {
  if (!objaverse) throw new Error('The Objaverse index is still loading — try again in a moment.');
  const path = objaverse.paths.get(uid);
  if (!path) throw new Error(`No Objaverse object with id ${uid}.`);
  return { url: `${HF}/${path}`, format: 'glb', include: {} };
}

/* ── Providers ──────────────────────────────────────────────────── */

const PROVIDERS = {
  polyhaven: {
    label: 'Poly Haven',
    license: 'CC0 — public domain',
    needsKey: false,
    available: () => true,
    search: searchPolyHaven,
    resolve: resolvePolyHaven,
  },
  objaverse: {
    label: 'Objaverse',
    license: 'Mixed open licences — CC-BY and similar',
    needsKey: false,
    available: () => true,
    search: searchObjaverse,
    resolve: async (id) => resolveObjaverse(id),
  },
};

// Warm the big index at startup so the first search isn't the one that pays
// for it. Failure is non-fatal: Poly Haven still answers on its own.
loadObjaverse();

/**
 * Nearest catalogue entries by shared trigrams. Crude, but it is only ever
 * shown after a total miss, where any concrete pointer beats "not found".
 */
function suggestCategories(query, n) {
  if (!objaverse) return [];
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (q.length < 3) return [];

  const grams = new Set();
  for (let i = 0; i <= q.length - 3; i++) grams.add(q.slice(i, i + 3));

  const scored = [];
  for (const raw of objaverse.categories.keys()) {
    const label = readableCategory(raw).toLowerCase();
    const flat = label.replace(/[^a-z0-9]/g, '');
    let shared = 0;
    for (let i = 0; i <= flat.length - 3; i++) if (grams.has(flat.slice(i, i + 3))) shared++;
    // Most of the query has to be accounted for. Without this, "robot"
    // suggests "bathrobe" on the strength of "rob" alone — the same
    // confidently-wrong answer the coverage check exists to prevent.
    if (shared / grams.size >= 0.6) scored.push({ label: titleCase(label), shared });
  }
  scored.sort((a, b) => b.shared - a.shared);
  return scored.slice(0, n).map((s) => s.label);
}

/* ── Router ─────────────────────────────────────────────────────── */

/**
 * Connect-style middleware. Mount at `/api/models`.
 *   GET /status                     -> which providers are usable
 *   GET /search?q=&limit=           -> ranked results across providers
 *   GET /resolve?provider=&id=      -> { url } for the actual mesh file
 *   GET /proxy?url=                 -> streams an allowlisted asset
 */
export function createModelRouter() {
  return async function modelRouter(req, res, next) {
    const parsed = new URL(req.url || '/', 'http://localhost');
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const q = parsed.searchParams;

    if (path === '/status' || path === '/') {
      return json(res, 200, {
        providers: Object.entries(PROVIDERS).map(([id, p]) => ({
          id,
          label: p.label,
          license: p.license,
          needsKey: p.needsKey,
          available: p.available(),
        })),
        objaverse: objaverse
          ? { ready: true, categories: objaverse.categories.size, objects: objaverse.paths.size }
          : { ready: false, loading: Boolean(objaverseLoad), error: objaverseError },
      });
    }

    if (path === '/search') {
      const query = (q.get('q') || '').trim();
      const limit = Math.min(24, Math.max(1, Number(q.get('limit')) || 8));
      if (!query) return json(res, 400, { error: 'bad_request', message: 'q is required.' });

      const active = Object.values(PROVIDERS).filter((p) => p.available());
      const settled = await Promise.allSettled(active.map((p) => p.search(query, limit)));

      const results = [];
      const failures = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') results.push(...s.value);
        else failures.push({ provider: active[i].label, message: s.reason?.message });
      });
      results.sort((a, b) => b.coverage - a.coverage || b.score - a.score);

      return json(res, 200, {
        query,
        results: results.slice(0, limit),
        // Below this, the best hit is answering a minority of the query and
        // should be offered as a near-miss, not loaded as the answer.
        confident: (results[0]?.coverage ?? 0) >= 0.5,
        // A miss should teach the vocabulary rather than just say no.
        didYouMean: results.length ? undefined : suggestCategories(query, 6),
        failures,
      });
    }

    if (path === '/resolve') {
      const provider = PROVIDERS[q.get('provider')];
      const id = q.get('id');
      if (!provider || !id) {
        return json(res, 400, { error: 'bad_request', message: 'provider and id are required.' });
      }
      try {
        const out = await provider.resolve(id);
        return json(res, 200, { ...out, proxied: `/api/models/proxy?url=${encodeURIComponent(out.url)}` });
      } catch (err) {
        return json(res, 502, { error: 'resolve_failed', message: err.message });
      }
    }

    if (path === '/proxy') {
      const target = q.get('url');
      if (!target) return json(res, 400, { error: 'bad_request', message: 'url is required.' });

      let host;
      try {
        const u = new URL(target);
        if (u.protocol !== 'https:') throw new Error('Only https URLs may be proxied.');
        host = u.hostname;
      } catch (err) {
        return json(res, 400, { error: 'bad_url', message: err.message });
      }
      if (!ALLOWED_HOSTS.has(host)) {
        return json(res, 403, {
          error: 'host_not_allowed',
          message: `${host} is not an allowed source.`,
          allowed: [...ALLOWED_HOSTS],
        });
      }

      try {
        const upstream = await fetch(target, { headers: { 'User-Agent': UA } });
        if (!upstream.ok) {
          return json(res, upstream.status, { error: 'upstream_error', message: `Source returned ${upstream.status}.` });
        }
        const length = Number(upstream.headers.get('content-length') || 0);
        if (length > MAX_BYTES) {
          return json(res, 413, { error: 'too_large', message: `Asset is ${(length / 1e6).toFixed(1)} MB; the ceiling is ${MAX_BYTES / 1e6} MB.` });
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        // Deliberately no Content-Length. `fetch` transparently decompresses
        // gzip/br, so the upstream header describes the *compressed* size —
        // forwarding it truncates the body, and a .bin buffer that arrives
        // short fails deep inside the glTF parser with a length error that
        // points nowhere near the actual cause. Chunked is correct here.

        // Stream with a hard byte ceiling — content-length can lie.
        let seen = 0;
        for await (const chunk of upstream.body) {
          seen += chunk.length;
          if (seen > MAX_BYTES) { res.destroy(); return; }
          res.write(Buffer.from(chunk));
        }
        return res.end();
      } catch (err) {
        return json(res, 502, { error: 'fetch_failed', message: err.message });
      }
    }

    if (typeof next === 'function') return next();
    return json(res, 404, { error: 'not_found' });
  };
}
