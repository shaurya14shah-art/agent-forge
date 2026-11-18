/* ───────────────────────────────────────────────────────────────
   The room the hologram lives in: emitter pad, volumetric projection
   cone, polar deck grid, drifting dust and a rotating reference cage.
   ─────────────────────────────────────────────────────────────── */

import {
  Group,
  Mesh,
  Points,
  PlaneGeometry,
  CylinderGeometry,
  TorusGeometry,
  BufferGeometry,
  BufferAttribute,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  BackSide,
  SphereGeometry,
  Color,
  Vector2,
} from 'three';

export function createEnvironment(scene, { padY = -1.35, radius = 3.2 } = {}) {
  const root = new Group();
  root.name = 'environment';
  scene.add(root);

  /* ── AR backdrop: the live camera feed, behind everything ──── */
  const videoMat = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uTex: { value: null },
      uScale: { value: new Vector2(1, 1) },
      uOpacity: { value: 1 },
      // The room keeps its own colour — full saturation, no cool tint — but
      // not its own brightness. The hologram is additive with surface alphas
      // around 0.02–0.25, so a lit room at exposure 1.0 simply buries it;
      // "natural colour" and "full brightness" are separate decisions and
      // only the first one belongs to the camera. Adjustable on the deck.
      uSaturation: { value: 1 },
      uTint: { value: 0 },
      uExposure: { value: 0.62 },
      uVignette: { value: 0.35 },
      uPocket: { value: 0.78 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // Pinned to the far plane, independent of the camera transform.
        gl_Position = vec4(position.xy, 0.99999, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec2 uScale;
      uniform float uOpacity, uSaturation, uTint, uExposure, uVignette, uPocket;
      varying vec2 vUv;
      void main() {
        vec2 uv = (vUv - 0.5) * uScale + 0.5;
        uv.x = 1.0 - uv.x;                       // mirror — reads like a mirror
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
        vec3 c = texture2D(uTex, uv).rgb;

        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(vec3(l), c, uSaturation);
        c = mix(c, c * vec3(0.52, 0.76, 0.95), uTint);
        c *= uExposure;

        float d = distance(vUv, vec2(0.5));

        // The pocket: hold the middle of the frame — where the projection
        // stands — darker than the edges. Dimming the *whole* feed to make an
        // additive hologram readable defeats the point of AR, because the
        // room and your hands are what you turned the camera on to see. This
        // keeps the periphery bright and opens a well behind the hardware.
        c *= mix(1.0, smoothstep(0.10, 0.52, d), uPocket);

        c *= mix(1.0, smoothstep(1.05, 0.22, d), uVignette);
        gl_FragColor = vec4(c * uOpacity, 1.0);
      }
    `,
  });
  const videoQuad = new Mesh(new PlaneGeometry(2, 2), videoMat);
  videoQuad.frustumCulled = false;
  videoQuad.renderOrder = -100;
  videoQuad.visible = false;
  scene.add(videoQuad);

  /* ── Deep-space backdrop ─────────────────────────────────── */
  const backdrop = new Mesh(
    new SphereGeometry(160, 32, 16),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() { vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vPos;
        void main() {
          float h = vPos.y * 0.5 + 0.5;
          vec3 col = mix(vec3(0.006, 0.016, 0.030), vec3(0.0, 0.004, 0.012), h);

          // Warm practical lighting along the far wall — the workshop the
          // projection is standing in. The whole reason the hologram reads as
          // emitted light rather than as a blue picture is that the room
          // behind it is a different temperature.
          //
          // Kept low and tight to the horizon: this is a row of lamps at the
          // back of a room, not a light source in the working volume. Anything
          // brighter climbs into the bloom and turns into vertical shafts.
          // Each lamp is wide in azimuth and tight in elevation — a horizontal
          // fixture seen side-on. Narrow-in-azimuth does the opposite and
          // renders as vertical shafts, which read as light leaks, not lamps.
          float a = atan(vPos.z, vPos.x);
          float band  = exp(-pow((vPos.y - 0.008) * 30.0, 2.0));
          float lamps = pow(max(0.0, sin(a * 7.0)), 2.2);
          float haze  = pow(max(0.0, sin(a * 3.5)), 1.6);
          col += vec3(1.00, 0.47, 0.15) * band * (0.009 + haze * 0.007 + lamps * 0.018);

          // A second, dimmer warm tier higher up — depth in the room.
          float band2 = exp(-pow((vPos.y - 0.085) * 15.0, 2.0));
          col += vec3(1.00, 0.58, 0.22) * band2 * 0.004;

          // Cool bounce off the deck, so the floor isn't a hard cut.
          float glow = pow(max(0.0, 1.0 - abs(vPos.y) * 2.4), 3.0);
          col += vec3(0.02, 0.10, 0.16) * glow * 0.20;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
  );
  root.add(backdrop);

  /* ── Background practicals ────────────────────────────────────
     Warm out-of-focus lamps ringing the space, well outside the working
     volume. They never touch legibility — they exist so the hologram has
     something to be cooler and sharper than, and so the room has depth
     instead of being a flat void.                                        */
  const LAMPS = 90;
  const lampPos = new Float32Array(LAMPS * 3);
  const lampSeed = new Float32Array(LAMPS);
  for (let i = 0; i < LAMPS; i++) {
    const a = (i / LAMPS) * Math.PI * 2 + Math.random() * 0.09;
    const r = radius * (7.5 + Math.random() * 5.0);
    lampPos[i * 3] = Math.cos(a) * r;
    // Clustered low, the way workshop lighting and background clutter is.
    lampPos[i * 3 + 1] = padY + 0.25 + Math.pow(Math.random(), 2.4) * 3.4;
    lampPos[i * 3 + 2] = Math.sin(a) * r;
    lampSeed[i] = Math.random();
  }
  const lampGeom = new BufferGeometry();
  lampGeom.setAttribute('position', new BufferAttribute(lampPos, 3));
  lampGeom.setAttribute('aSeed', new BufferAttribute(lampSeed, 1));

  const lampMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uWarm: { value: new Color(0xffb45e) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime, uPixelRatio;
      varying float vSeed;
      void main(){
        vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Soft and defocused, but small enough to read as distant lights
        // rather than as objects floating in the working volume.
        gl_PointSize = (26.0 + aSeed * 34.0) * uPixelRatio * (7.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uWarm; uniform float uTime, uOpacity;
      varying float vSeed;
      void main(){
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        // Bokeh: a soft disc with a slightly brighter rim, not a gaussian dot.
        // Very low alpha — additive blending stacks these against the backdrop,
        // and anything heavier reads as brown smudges instead of light.
        float disc = smoothstep(0.5, 0.30, d);
        float rim  = smoothstep(0.34, 0.47, d) * smoothstep(0.5, 0.44, d);
        float flick = 0.88 + 0.12 * sin(uTime * (0.7 + vSeed * 1.3) + vSeed * 30.0);
        vec3 col = mix(uWarm, vec3(1.0, 0.88, 0.70), vSeed * 0.45);
        gl_FragColor = vec4(col, (disc * 0.012 + rim * 0.022) * flick * uOpacity);
      }`,
  });
  const lamps = new Points(lampGeom, lampMat);
  lamps.frustumCulled = false;
  root.add(lamps);

  /* ── Polar deck grid ─────────────────────────────────────── */
  const gridMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(0x1fb6e8) },
      uOpacity: { value: 1 },
      uRadius: { value: radius * 3.4 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXz;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vXz = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpacity, uRadius;
      uniform vec3 uColor;
      varying vec2 vXz;

      float lineMask(float v, float w) {
        float d = abs(fract(v) - 0.5) / max(fwidth(v), 1e-5);
        return 1.0 - smoothstep(w, w + 1.2, d);
      }

      void main() {
        float r = length(vXz);
        float a = atan(vXz.y, vXz.x);

        // The deck is context, not content — it reads at a glance and then
        // gets out of the way of the hardware standing on it.
        float rings   = lineMask(r * 2.0, 1.0) * 0.10;
        float ringsHi = lineMask(r * 0.5, 1.4) * 0.26;
        float spokes  = lineMask(a * 12.0 / 3.14159265, 1.1) * 0.07;

        // Radar sweep
        float sweepAngle = mod(uTime * 0.42, 6.2831853);
        float da = abs(mod(a - sweepAngle + 9.42477796, 6.2831853) - 3.14159265);
        float sweep = pow(max(0.0, 1.0 - da / 0.55), 3.0) * 0.22;

        float grid = rings + ringsHi + spokes + sweep;
        float falloff = smoothstep(uRadius, uRadius * 0.15, r);
        float alpha = grid * falloff * uOpacity;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(uColor * (0.7 + sweep * 2.2), alpha);
      }
    `,
  });
  const grid = new Mesh(new PlaneGeometry(radius * 8, radius * 8, 1, 1), gridMat);
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = padY;
  root.add(grid);

  /* ── Emitter pad ─────────────────────────────────────────── */
  const padMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color(0x4fdcff) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float ring = smoothstep(0.02, 0.0, abs(r - 0.94)) * 0.55;
        ring += smoothstep(0.02, 0.0, abs(r - (0.4 + 0.1 * sin(uTime * 1.6)))) * 0.22;
        float core = pow(max(0.0, 1.0 - r), 3.0) * 0.16;
        float a = (ring + core) * smoothstep(1.0, 0.85, r);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const pad = new Mesh(new PlaneGeometry(radius * 1.5, radius * 1.5), padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = padY + 0.004;
  root.add(pad);

  const padRing = new Mesh(
    new TorusGeometry(radius * 0.7, 0.012, 8, 96),
    new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new Color(0x7febff) } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uColor; varying vec3 vP;
        void main(){
          float a = atan(vP.z, vP.x);
          float chase = pow(max(0.0, sin(a * 6.0 - uTime * 3.0)), 6.0);
          gl_FragColor = vec4(uColor, 0.12 + chase * 0.45);
        }`,
    })
  );
  padRing.rotation.x = -Math.PI / 2;
  padRing.position.y = padY + 0.01;
  root.add(padRing);

  /* ── Ground bounce ────────────────────────────────────────────
     A soft pool of light on the deck under the projection.

     This is the cheapest and most effective "it is really there" cue in
     the scene. Without it the hologram is a bright object floating over an
     unrelated floor; with it the floor acknowledges the light, and the eye
     reads contact. It tracks the model's footprint and brightness, so it
     grows with a wide bell and dims when the assembly is pulled apart.   */
  const bounceMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(0x58c8ff) },
      uStrength: { value: 1 },
      uRadius: { value: 0.5 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uStrength, uRadius;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main(){
        float r = length(vUv - 0.5) * 2.0 / max(0.08, uRadius);
        // Two lobes: a soft core under the nozzle, and a wide spill. The core
        // is deliberately broad and low rather than tight and hot — a bright
        // point here blooms into a starburst that outshines the hardware
        // casting it, which is exactly backwards.
        float core  = pow(max(0.0, 1.0 - r), 2.2) * 0.13;
        float spill = pow(max(0.0, 1.0 - r * 0.42), 2.2) * 0.055;
        float breathe = 0.94 + 0.06 * sin(uTime * 0.9);
        float a = (core + spill) * uStrength * breathe;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const bounce = new Mesh(new PlaneGeometry(radius * 5.0, radius * 5.0), bounceMat);
  bounce.rotation.x = -Math.PI / 2;
  bounce.position.y = padY + 0.002;
  bounce.renderOrder = 1;
  root.add(bounce);

  /* ── Projection cone ─────────────────────────────────────── */
  const coneMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color(0x2ba9e8) }, uOpacity: { value: 1 } },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position,1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime, uOpacity; uniform vec3 uColor;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float ndv = abs(dot(normalize(vN), normalize(vV)));
        // Rim only — a filled cone sits exactly where the bell is and
        // washes the hardware out.
        float edge = pow(1.0 - ndv, 6.0);
        float rise = smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.5, vUv.y);
        float a = edge * rise * uOpacity * 0.5;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const cone = new Mesh(
    new CylinderGeometry(radius * 0.46, radius * 0.3, Math.abs(padY) * 2.3, 48, 12, true),
    coneMat
  );
  cone.position.y = padY + Math.abs(padY) * 1.15;
  // Off by default: it occupies exactly the volume the hardware does and
  // costs more legibility than it buys atmosphere. Toggle via setConeVisible.
  cone.visible = false;
  root.add(cone);

  /* ── Motes ────────────────────────────────────────────────────
     Particulate hanging in the projection volume. Cheap, and it does more
     for "there is a volume here" than any amount of extra geometry.      */
  const COUNT = 1600;
  const pos = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const r = Math.pow(Math.random(), 0.55) * radius * 2.3;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = padY + Math.random() * 4.4;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random();
  }
  const dustGeom = new BufferGeometry();
  dustGeom.setAttribute('position', new BufferAttribute(pos, 3));
  dustGeom.setAttribute('aSeed', new BufferAttribute(seed, 1));

  const dustMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new Color(0x9fe9ff) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uBase: { value: padY },
      uOpacity: { value: 1 },
    },
    vertexShader: `
      attribute float aSeed;
      uniform float uTime, uPixelRatio, uBase;
      varying float vFade;
      void main(){
        vec3 p = position;
        float t = uTime * (0.06 + aSeed * 0.12);
        p.y = uBase + mod(p.y - uBase + t, 4.4);
        p.x += sin(uTime * 0.28 + aSeed * 21.0) * 0.09;
        p.z += cos(uTime * 0.24 + aSeed * 17.0) * 0.09;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.0 + aSeed * 2.4) * uPixelRatio * (7.0 / -mv.z);
        vFade = 0.22 + 0.7 * aSeed;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity; varying float vFade;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uColor, (1.0 - d * 2.0) * vFade * 0.55 * uOpacity);
      }`,
  });
  const dust = new Points(dustGeom, dustMat);
  dust.frustumCulled = false;
  root.add(dust);

  /* ── Slowly counter-rotating reference cage ──────────────── */
  const cage = new Group();
  for (let i = 0; i < 3; i++) {
    const ring = new Mesh(
      new TorusGeometry(radius * (0.95 + i * 0.16), 0.004, 6, 100),
      new ShaderMaterial({
        transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false,
        uniforms: { uColor: { value: new Color(0x1e8fbe) }, uOpacity: { value: 0.5 - i * 0.12 } },
        vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uOpacity; void main(){ gl_FragColor = vec4(uColor, uOpacity); }`,
      })
    );
    ring.rotation.x = Math.PI / 2 + (i - 1) * 0.24;
    ring.rotation.z = i * 0.5;
    cage.add(ring);
  }
  root.add(cage);

  const mats = [gridMat, padMat, coneMat, dustMat, lampMat, bounceMat, backdrop.material, padRing.material];

  let arOn = false;

  return {
    root, grid, pad, cone, dust, cage, padY,

    /**
     * AR mode: the camera feed becomes the room. The starfield backdrop is
     * hidden (it would draw over the feed), the deck grid drops back so it
     * reads as a projection onto the real floor, and the dust thins out.
     */
    setArMode(on, videoTexture) {
      arOn = on;
      videoQuad.visible = on;
      backdrop.visible = !on;
      if (videoTexture) videoMat.uniforms.uTex.value = videoTexture;
      gridMat.uniforms.uOpacity.value = on ? 0.55 : 1;
      // In AR the operator's actual room supplies the warm side of the
      // contrast, so the synthetic practicals would just be litter.
      lamps.visible = !on;
      cage.visible = !on;
      // Motes stay — they are what makes the projection read as volumetric
      // rather than as a picture hanging in front of the camera feed.
      dustMat.uniforms.uOpacity.value = on ? 0.5 : 1;
    },
    get arMode() { return arOn; },

    /** Room grade. Defaults pass the camera through untouched. */
    setRoomGrade({ saturation, tint, exposure, vignette, pocket } = {}) {
      const u = videoMat.uniforms;
      if (saturation !== undefined) u.uSaturation.value = saturation;
      if (tint !== undefined) u.uTint.value = tint;
      if (exposure !== undefined) u.uExposure.value = exposure;
      if (vignette !== undefined) u.uVignette.value = vignette;
      if (pocket !== undefined) u.uPocket.value = pocket;
    },
    getRoomGrade() {
      const u = videoMat.uniforms;
      return {
        saturation: u.uSaturation.value,
        tint: u.uTint.value,
        exposure: u.uExposure.value,
        vignette: u.uVignette.value,
        pocket: u.uPocket.value,
      };
    },

    /** Keep the feed cover-fitted as the window or camera resolution changes. */
    setVideoAspect(videoW, videoH) {
      if (!videoW || !videoH) return;
      const va = videoW / videoH;
      const sa = window.innerWidth / window.innerHeight;
      if (va > sa) videoMat.uniforms.uScale.value.set(sa / va, 1);
      else videoMat.uniforms.uScale.value.set(1, va / sa);
    },

    setGridVisible(v) {
      grid.visible = v;
      pad.visible = v;
      padRing.visible = v;
      cage.visible = v && !arOn;
    },

    /**
     * Match the light pool to the hardware standing in it.
     * @param {number} footprint  projected radius of the assembly, world units
     * @param {number} strength   0–1, dims as the assembly comes apart
     */
    setBounce(footprint, strength = 1) {
      bounceMat.uniforms.uRadius.value = Math.max(0.06, (footprint * 2.4) / (radius * 5.0));
      bounceMat.uniforms.uStrength.value = strength;
    },
    setConeVisible(v) { cone.visible = v; },
    update(t, dt) {
      for (const m of mats) if (m.uniforms?.uTime) m.uniforms.uTime.value = t;
      padRing.material.uniforms.uTime.value = t;
      cage.rotation.y -= dt * 0.055;
      cage.children.forEach((r, i) => { r.rotation.z += dt * (0.03 + i * 0.02); });
    },
  };
}
