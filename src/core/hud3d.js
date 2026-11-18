/* ───────────────────────────────────────────────────────────────
   3D HUD.

   Panels are DOM cards living inside a CSS `perspective` volume and
   driven entirely by the 3D scene:

     • dock panels  — pinned to a frame edge, yawed/pitched away from
                      the viewer and counter-rotated against the camera
                      azimuth, so orbiting the model visibly parallaxes
                      the glass around you.
     • world panels — anchored to a component: the part is projected
                      through the camera each frame, the card tracks it,
                      and a dashed leader line drawn in WebGL joins the
                      two through real 3D space.

   (This replaced CSS3DRenderer: it works in pixel-scale space — an
   object has to sit `(viewportHeight/2)/tan(fov/2)` units from the
   camera to render 1:1 — which is irreconcilable with a scene whose
   subject is two units tall. Projecting ourselves keeps the panels
   locked to the hardware, crisp at any DPI, and correctly sized.)
   ─────────────────────────────────────────────────────────────── */

import {
  Group,
  Line,
  BufferGeometry,
  BufferAttribute,
  ShaderMaterial,
  AdditiveBlending,
  Vector3,
  Box3,
} from 'three';

/* ── The rig ──────────────────────────────────────────────────────
   Panels are arranged as a shallow arc of glass wrapped around the
   operator, not as cards stuck to the edges of a screen. Three numbers
   control the whole feel:

     PERSPECTIVE  how strong the foreshortening is. Shorter = deeper.
     ARC_YAW      how far the side columns turn to face you.
     ARC_DEPTH    how far back into the volume they sit.

   There is a real tension here: yaw is what makes the rig read as
   surrounding you, and yaw is also what costs you legibility. 11.5° is
   the most that a 306 px column of 11 px type survives — past about 15°
   the far edge starts to fringe and tabular numbers stop scanning.      */
const PERSPECTIVE = 1150;
const ARC_YAW = 0.20;
const ARC_DEPTH = -250;
const ARC_PITCH = 0.045;

function leaderMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aT;
      varying float vT;
      void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpacity;
      varying float vT;
      void main() {
        float dash = step(0.42, fract(vT * 18.0 - uTime * 1.2));
        float head = smoothstep(0.0, 0.15, vT) * smoothstep(1.0, 0.75, vT);
        float a = (0.14 + dash * 0.46) * (0.30 + head) * uOpacity;
        gl_FragColor = vec4(0.32, 0.82, 1.0, a);
      }
    `,
  });
}

export function createHud({ cssRoot, scene, camera }) {
  cssRoot.style.perspective = `${PERSPECTIVE}px`;
  cssRoot.style.perspectiveOrigin = '50% 50%';
  cssRoot.style.transformStyle = 'preserve-3d';

  const leaderLayer = new Group();
  leaderLayer.name = 'hud-leaders';
  scene.add(leaderLayer);

  const panels = new Map();
  const leaderMats = [];

  function makeEl(html, className) {
    const el = document.createElement('div');
    el.className = className;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.willChange = 'transform';
    el.innerHTML = html;
    // Keep panel interaction from reaching OrbitControls.
    ['pointerdown', 'pointermove', 'wheel', 'contextmenu', 'dblclick'].forEach((evt) =>
      el.addEventListener(evt, (e) => e.stopPropagation())
    );
    cssRoot.appendChild(el);
    return el;
  }

  /**
   * @param {string} id
   * @param {object} opts
   * @param {'left'|'right'|'bottom'|'world'} opts.anchor
   */
  function panel(id, opts = {}) {
    if (panels.has(id)) return panels.get(id);

    const el = makeEl(
      `<div class="panel-head">
         <span class="glyph">◈</span><span class="ttl">${opts.title ?? id}</span>
         <span class="spacer"></span>
         <span class="id">${opts.tag ?? ''}</span>
       </div>
       <div class="panel-body"></div>`,
      `panel ${opts.size ?? ''}`.trim()
    );

    const entry = {
      id,
      el,
      head: el.querySelector('.panel-head'),
      title: el.querySelector('.ttl'),
      body: el.querySelector('.panel-body'),
      anchor: opts.anchor ?? 'left',
      margin: opts.margin ?? 46,
      // Second-column offset: lets a panel dock immediately beside another
      // on the same edge rather than on top of it.
      offsetX: opts.offsetX ?? 0,
      // Operator-applied displacement from the docked position, in px.
      // The dock stays the anchor so panels still track window resizes.
      drag: { x: 0, y: 0 },
      movable: opts.movable ?? opts.anchor !== 'world',
      depth: opts.depth ?? -120,   // px pushed back into the glass volume
      worldTarget: null,
      worldOffset: { x: 150, y: -110 },
      keepOut: opts.keepOut ?? { left: 24, right: 24, bottom: 70 },
      visible: true,
      // last projected anchor point, in normalised device coords
      ndc: { x: 0, y: 0, depth: 1 },
    };

    if (entry.anchor === 'world') {
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
      geom.setAttribute('aT', new BufferAttribute(new Float32Array([0, 1]), 1));
      const mat = leaderMaterial();
      leaderMats.push(mat);
      entry.leader = new Line(geom, mat);
      entry.leader.frustumCulled = false;
      entry.leader.renderOrder = 30;
      leaderLayer.add(entry.leader);
    }

    if (entry.movable) makeDraggable(entry);

    panels.set(id, entry);
    restoreLayout(entry);
    return entry;
  }

  /* ── Moving panels ────────────────────────────────────────────
     Drag by the header. The dock position stays the anchor and the drag
     is stored as a displacement from it, so a moved panel still tracks
     window resizes and still sits in the arc — you are adjusting the rig,
     not detaching a card from it.                                        */

  const LAYOUT_KEY = 'agent-forge:panel-layout';

  function makeDraggable(p) {
    p.head.classList.add('draggable');
    let start = null;

    p.head.addEventListener('pointerdown', (e) => {
      // Let controls inside the header (the tag chip, buttons) behave normally.
      if (e.button !== 0 || e.target.closest('button, input, a')) return;
      start = { px: e.clientX, py: e.clientY, dx: p.drag.x, dy: p.drag.y };
      p.head.setPointerCapture(e.pointerId);
      p.el.classList.add('dragging');
      e.preventDefault();
    });

    p.head.addEventListener('pointermove', (e) => {
      if (!start) return;
      p.drag.x = start.dx + (e.clientX - start.px);
      p.drag.y = start.dy + (e.clientY - start.py);
      clampDrag(p);
    });

    const end = (e) => {
      if (!start) return;
      start = null;
      p.head.releasePointerCapture?.(e.pointerId);
      p.el.classList.remove('dragging');
      persistLayout();
    };
    p.head.addEventListener('pointerup', end);
    p.head.addEventListener('pointercancel', end);

    // Double-click the header to send a panel home.
    p.head.addEventListener('dblclick', () => {
      p.drag.x = 0;
      p.drag.y = 0;
      persistLayout();
    });
  }

  /** Never let a panel be dragged somewhere it can't be dragged back from. */
  function clampDrag(p) {
    const w = p.el.offsetWidth || 306;
    const h = p.el.offsetHeight || 260;
    const base = dockPosition(p, w, h);
    const KEEP = 90; // px of the panel that must stay on screen
    p.drag.x = Math.min(
      window.innerWidth - KEEP - base.x,
      Math.max(KEEP - base.x - w, p.drag.x)
    );
    p.drag.y = Math.min(window.innerHeight - 40 - base.y, Math.max(-base.y + 8, p.drag.y));
  }

  function persistLayout() {
    const out = {};
    for (const [id, p] of panels) {
      if (p.movable && (p.drag.x || p.drag.y)) out[id] = { x: p.drag.x, y: p.drag.y };
    }
    try {
      if (Object.keys(out).length) localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
      else localStorage.removeItem(LAYOUT_KEY);
    } catch { /* private mode */ }
  }

  function restoreLayout(p) {
    if (!p.movable) return;
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
      const s = saved[p.id];
      if (s) { p.drag.x = Number(s.x) || 0; p.drag.y = Number(s.y) || 0; }
    } catch { /* private mode or malformed */ }
  }

  function resetLayout() {
    for (const p of panels.values()) { p.drag.x = 0; p.drag.y = 0; }
    persistLayout();
  }

  function setTag(id, text) {
    const p = panels.get(id);
    if (p) p.head.querySelector('.id').textContent = text ?? '';
  }

  function setTitle(id, text) {
    const p = panels.get(id);
    if (p) p.title.textContent = text;
  }

  function show(id, visible) {
    const p = panels.get(id);
    if (!p) return;
    p.visible = visible;
    p.el.style.display = visible ? '' : 'none';
    if (p.leader) p.leader.visible = visible;
  }

  /** Widen or relax the region a world-anchored card must stay clear of. */
  function setKeepOut(id, patch) {
    const p = panels.get(id);
    if (p) Object.assign(p.keepOut, patch);
  }

  function anchorTo(id, target, offset) {
    const p = panels.get(id);
    if (!p || p.anchor !== 'world') return;
    p.worldTarget = target;
    if (offset) Object.assign(p.worldOffset, offset);
  }

  /* ── Floating tooltip ─────────────────────────────────────── */
  const tipEl = makeEl('', 'tip');
  tipEl.style.display = 'none';
  let tipWorld = null;

  function tooltip(text, worldPos) {
    if (!text || !worldPos) { tipEl.style.display = 'none'; tipWorld = null; return; }
    tipEl.style.display = '';
    tipEl.textContent = text;
    tipWorld = worldPos.clone();
  }

  /* ── Per-frame placement ──────────────────────────────────── */
  const _dir = new Vector3();
  const _right = new Vector3();
  const _up = new Vector3();
  const _box = new Box3();
  const _center = new Vector3();
  const _ndc = new Vector3();
  const _tmp = new Vector3();

  function css(el, x, y, z, ry, rx) {
    el.style.transform =
      `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px)` +
      `rotateY(${ry.toFixed(3)}rad) rotateX(${rx.toFixed(3)}rad)`;
  }

  /**
   * Where a dock panel sits before the operator moves it. Shared by the
   * per-frame placement and by drag clamping, so "on screen" means the same
   * thing to both.
   */
  function dockPosition(p, w, h) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = p.margin;
    if (p.anchor === 'left') {
      return { x: m + p.offsetX, y: 52, z: p.depth + ARC_DEPTH, ry: ARC_YAW, rx: ARC_PITCH };
    }
    if (p.anchor === 'right') {
      return { x: vw - w - m - p.offsetX, y: 52, z: p.depth + ARC_DEPTH, ry: -ARC_YAW, rx: ARC_PITCH };
    }
    if (p.anchor === 'bottom') {
      return { x: (vw - w) / 2, y: vh - h - m - 14, z: p.depth * 0.5, ry: 0, rx: -0.10 };
    }
    return { x: 0, y: 0, z: 0, ry: 0, rx: 0 };
  }

  /** World point that projects to given NDC at a given view depth. */
  function ndcToWorld(nx, ny, depth, out) {
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * depth;
    const halfW = halfH * camera.aspect;
    return out
      .copy(camera.position)
      .addScaledVector(_right, nx * halfW)
      .addScaledVector(_up, ny * halfH)
      .addScaledVector(_dir, depth);
  }

  function update(t) {
    for (const m of leaderMats) m.uniforms.uTime.value = t;

    camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, camera.up).normalize();
    _up.crossVectors(_right, _dir).normalize();

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Camera azimuth drives a small counter-rotation so the dock glass
    // parallaxes while you orbit instead of feeling painted on.
    const azimuth = Math.atan2(_dir.x, _dir.z);
    const sway = Math.sin(azimuth) * 0.045;
    const pitchSway = Math.max(-0.06, Math.min(0.06, _dir.y * 0.16));

    for (const p of panels.values()) {
      if (!p.visible) continue;

      const w = p.el.offsetWidth || 420;
      const h = p.el.offsetHeight || 260;

      if (p.anchor === 'world') {
        if (!p.worldTarget) continue;

        if (p.worldTarget.isObject3D) {
          _box.setFromObject(p.worldTarget);
          if (_box.isEmpty()) p.worldTarget.getWorldPosition(_center);
          else _box.getCenter(_center);
        } else {
          _center.copy(p.worldTarget);
        }

        _ndc.copy(_center).project(camera);
        const behind = _ndc.z > 1;
        p.el.style.opacity = behind ? '0' : '1';

        // Screen position of the anchor, then hang the card beside it.
        const ax = (_ndc.x * 0.5 + 0.5) * vw;
        const ay = (-_ndc.y * 0.5 + 0.5) * vh;

        // Flip to whichever side of the component has more room, then keep
        // clear of the dock panels and the console along the bottom.
        const side = ax > vw * 0.5 ? -1 : 1;
        let x = ax + (side > 0 ? p.worldOffset.x : -p.worldOffset.x - w);
        let y = ay + p.worldOffset.y;
        x = Math.min(vw - w - (p.keepOut?.right ?? 24), Math.max(p.keepOut?.left ?? 24, x));
        // The top bound wins: a card taller than the space between the rail and
        // the console must be clipped at the bottom, never slid off the top —
        // its title and the first rows are the part you have to be able to read.
        y = Math.max(70, Math.min(vh - h - (p.keepOut?.bottom ?? 70), y));

        // Yaw the card away from the side of the frame it sits on.
        const ry = -((x + w / 2) / vw - 0.5) * 0.30;
        css(p.el, x, y, -60, ry, pitchSway * 0.5);

        if (p.leader) {
          // Join the component to the card's top-left corner, through
          // the world point that projects there at the part's depth.
          const depth = Math.max(0.15, _tmp.copy(_center).sub(camera.position).dot(_dir));
          const cx = ((x + 10) / vw) * 2 - 1;
          const cy = -(((y + h * 0.14) / vh) * 2 - 1);
          ndcToWorld(cx, cy, depth, _tmp);
          const pos = p.leader.geometry.getAttribute('position');
          pos.setXYZ(0, _center.x, _center.y, _center.z);
          pos.setXYZ(1, _tmp.x, _tmp.y, _tmp.z);
          pos.needsUpdate = true;
          p.leader.visible = !behind;
        }
        continue;
      }

      // Dock panels form the arc. Side columns turn inward to face the
      // operator and sit back in the volume; the console lies flatter and
      // nearer, like the surface of a bench. Orbiting the model parallaxes
      // the whole rig, which is what sells it as glass in a room rather
      // than as an overlay.
      const base = dockPosition(p, w, h);
      css(
        p.el,
        base.x + p.drag.x,
        base.y + p.drag.y,
        base.z,
        base.ry + sway * (p.anchor === 'bottom' ? 0.5 : 0.7),
        base.rx + (p.anchor === 'bottom' ? 0 : pitchSway * 0.6)
      );
    }

    if (tipWorld) {
      _ndc.copy(tipWorld).project(camera);
      if (_ndc.z > 1) {
        tipEl.style.display = 'none';
      } else {
        const x = (_ndc.x * 0.5 + 0.5) * vw - tipEl.offsetWidth / 2;
        const y = (-_ndc.y * 0.5 + 0.5) * vh - tipEl.offsetHeight - 10;
        css(tipEl, x, y, 0, 0, 0);
      }
    }
  }

  function layout() { /* placement is recomputed every frame */ }

  return {
    panel, panels, show, setTag, setTitle, setKeepOut, anchorTo, tooltip,
    layout, update, leaderLayer, resetLayout,
  };
}
