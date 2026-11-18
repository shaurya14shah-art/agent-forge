/* ───────────────────────────────────────────────────────────────
   Pointer work: hover highlight, selection, and grab-and-pull-apart.

   Dragging a part resolves the pointer delta against that part's own
   explode axis projected to screen space, so pulling the bell down or
   the injector up genuinely feels like taking the engine apart.
   ─────────────────────────────────────────────────────────────── */

import { Raycaster, Vector2, Vector3 } from 'three';

export function createInteraction({ renderer, camera, controls, store, getModel, hud }) {
  const dom = renderer.domElement;
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const ndc = new Vector2();

  let hoverId = null;
  let drag = null;
  let downAt = null;
  let suppressClick = false;

  const _v = new Vector3();
  const _a = new Vector3();
  const _b = new Vector3();

  function setPartUniform(partId, name, value) {
    const model = getModel();
    const part = model?.parts?.[partId];
    if (!part) return;
    part.traverse((o) => {
      const u = o.material?.uniforms;
      if (u && u[name]) u[name].value = value;
    });
  }

  function applyHoverState() {
    const model = getModel();
    if (!model) return;
    for (const id of Object.keys(model.parts)) {
      setPartUniform(id, 'uHover', id === hoverId ? 1 : 0);
    }
  }

  function pickables() {
    const model = getModel();
    if (!model) return [];
    return Object.values(model.parts);
  }

  function raycastPart(clientX, clientY) {
    const rect = dom.getBoundingClientRect();
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables(), true);
    for (const hit of hits) {
      let o = hit.object;
      if (o.userData?.noPick) continue;
      while (o && !o.userData?.partId) o = o.parent;
      if (o?.userData?.partId) return { partId: o.userData.partId, point: hit.point.clone() };
    }
    return null;
  }

  /** Project a world-space direction into a normalised 2D screen direction. */
  function screenDirection(origin, dir) {
    _a.copy(origin).project(camera);
    _b.copy(origin).add(_v.copy(dir).multiplyScalar(0.35)).project(camera);
    const dx = _b.x - _a.x;
    const dy = -(_b.y - _a.y); // screen Y grows downward
    const len = Math.hypot(dx, dy);
    if (len < 1e-5) return { x: 0, y: 1 };
    return { x: dx / len, y: dy / len };
  }

  function onPointerMove(e) {
    pointer.set(e.clientX, e.clientY);

    if (drag) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!suppressClick && Math.hypot(dx, dy) > 4) suppressClick = true;

      const along = dx * drag.dir.x + dy * drag.dir.y;
      const t = drag.startExplode + along / (dom.clientHeight * 0.32);
      store.setUi('explode', Math.min(1, Math.max(0, t)));
      return;
    }

    const hit = raycastPart(e.clientX, e.clientY);
    const id = hit?.partId ?? null;
    if (id !== hoverId) {
      hoverId = id;
      applyHoverState();
      store.setUi('hovered', id);
      dom.style.cursor = id ? 'grab' : 'crosshair';
    }
    if (hit) {
      const model = getModel();
      const label = model?.partInfo?.[hit.partId]?.label ?? hit.partId;
      hud.tooltip(label, hit.point.add(new Vector3(0, 0.06, 0)));
    } else {
      hud.tooltip(null);
    }
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    suppressClick = false;

    const hit = raycastPart(e.clientX, e.clientY);
    if (!hit) return;

    const model = getModel();
    const part = model.parts[hit.partId];
    const explode = part?.userData?.explode;
    if (!explode) return;

    let dirWorld;
    if (explode.radial) {
      dirWorld = _v.set(hit.point.x, 0, hit.point.z);
      if (dirWorld.lengthSq() < 1e-6) dirWorld.set(1, 0, 0);
      dirWorld.normalize();
    } else if (explode.dir.lengthSq() > 1e-6) {
      dirWorld = explode.dir.clone();
    } else {
      dirWorld = new Vector3(0, 1, 0);
    }

    drag = {
      partId: hit.partId,
      startX: e.clientX,
      startY: e.clientY,
      startExplode: store.ui.explode,
      dir: screenDirection(hit.point, dirWorld),
    };
    controls.enabled = false;
    dom.style.cursor = 'grabbing';
    dom.setPointerCapture?.(e.pointerId);
  }

  function onPointerUp(e) {
    if (drag) {
      controls.enabled = true;
      dom.releasePointerCapture?.(e.pointerId);
      dom.style.cursor = hoverId ? 'grab' : 'crosshair';
      const wasDrag = suppressClick;
      const partId = drag.partId;
      drag = null;
      if (!wasDrag) select(partId);
      return;
    }

    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;

    const hit = raycastPart(e.clientX, e.clientY);
    select(hit?.partId ?? null);
  }

  function onDoubleClick(e) {
    const hit = raycastPart(e.clientX, e.clientY);
    if (hit) {
      select(hit.partId);
      store.setUi('isolate', !store.ui.isolate);
    } else {
      store.setUi('isolate', false);
      select(null);
    }
  }

  function select(partId) {
    const model = getModel();
    if (!model) return;
    if (store.ui.selected === partId) {
      if (partId === null) return;
    }
    for (const id of Object.keys(model.parts)) {
      setPartUniform(id, 'uSelected', id === partId ? 1 : 0);
    }
    store.setUi('selected', partId ?? null);
    if (!partId) store.setUi('isolate', false);
  }

  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('dblclick', onDoubleClick);
  dom.addEventListener('pointerleave', () => {
    hoverId = null;
    applyHoverState();
    hud.tooltip(null);
  });

  /** Set the hover highlight from outside the pointer path (gesture aiming). */
  function setHover(id, point) {
    if (id !== hoverId) {
      hoverId = id;
      applyHoverState();
      store.setUi('hovered', id);
    }
    if (id && point) {
      const model = getModel();
      const label = model?.partInfo?.[id]?.label ?? id;
      hud.tooltip(label, point.clone().add(new Vector3(0, 0.06, 0)));
    } else if (!id) {
      hud.tooltip(null);
    }
  }

  return {
    select,
    setHover,
    labelFor: (id) => getModel()?.partInfo?.[id]?.label ?? id,
    pickAt: raycastPart,
    refresh: applyHoverState,
    setPartUniform,
    get hovered() { return hoverId; },
    dispose() {
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('dblclick', onDoubleClick);
    },
  };
}
