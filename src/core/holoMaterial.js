/* ───────────────────────────────────────────────────────────────
   Hologram shaders.

   Every part is drawn twice: a Fresnel-weighted volumetric pass and
   an additive wireframe "blueprint" pass. Both honour the global
   clipping plane so the cutaway slices geometry for real instead of
   just hiding meshes.
   ─────────────────────────────────────────────────────────────── */

import {
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Color,
  Vector3,
} from 'three';

const COMMON_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying vec3 vLocal;

void main() {
  #include <begin_vertex>
  vLocal = position;
  vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
  vWorld = worldPos.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  vec4 mvPosition = viewMatrix * worldPos;
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const SURFACE_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>

uniform float uTime;
uniform vec3  uColor;
uniform vec3  uAccent;
uniform float uOpacity;
uniform float uRim;
uniform float uHover;
uniform float uSelected;
uniform float uGhost;
uniform float uScanSpeed;
uniform float uGlitch;
uniform float uHeat;      // 0..1 thermal overlay during a burn
uniform float uNear;      // depth cueing: full brightness at this distance
uniform float uFar;       // depth cueing: fully receded at this distance

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying vec3 vLocal;

float hash21(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

/**
 * A periodic band, faded out as it approaches the sampling limit.
 *
 * Any world-space stripe pattern becomes noise once its period drops below
 * about two pixels, and because the phase then changes randomly per pixel per
 * frame, the noise *crawls* — which is what reads as flicker. fwidth gives the
 * screen-space rate of change of the pattern coordinate, so the amplitude can
 * be rolled off exactly where it would start to alias. Detail resolves as you
 * zoom in and dissolves as you pull back, instead of boiling.
 */
float aaBand(float coord, float sharpness) {
  float w = fwidth(coord);
  float fade = 1.0 - smoothstep(0.6, 2.2, w);   // 1 = resolvable, 0 = aliasing
  if (fade <= 0.0) return 0.0;
  return smoothstep(sharpness, 1.0, sin(coord)) * fade;
}

void main() {
  #include <clipping_planes_fragment>

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewDir);
  float ndv = abs(dot(N, V));

  // Fresnel rim — the defining hologram cue
  float fres = pow(1.0 - ndv, 2.6);

  // Horizontal scan bands travelling up the model
  float scan = aaBand(vWorld.y * 46.0 - uTime * uScanSpeed, 0.55) * 0.5 + 0.75;

  // Fine interference lines. Far too dense to resolve at normal framing, so
  // they simply aren't drawn until you are close enough for them to be real.
  float fine = aaBand(vWorld.y * 320.0 + uTime * 1.4, 0.86);

  // Occasional horizontal tear, held for a beat rather than resampled every
  // frame — a tear that changes every frame is just noise.
  float tearBand = step(0.992, hash21(vec2(floor(vWorld.y * 26.0), floor(uTime * 2.5))));
  float tear = tearBand * uGlitch;

  // Additive layers stack fast — keep each surface faint and let the
  // rim carry the read. A thrust chamber is ten nested shells plus sixty
  // cooling tubes, so anything above ~0.25 on the rim term clips the
  // chamber to a white blob from the outside.
  float body = 0.018 + fres * 0.24 * uRim;
  body *= mix(0.86, 1.06, scan);
  body += fine * 0.016;
  body += tear * 0.10;

  vec3 col = mix(uColor, uAccent, fres * 0.85);
  col = mix(col, vec3(1.0), uSelected * 0.35);
  col += uAccent * uHover * 0.35;

  // Thermal ramp: cyan -> amber -> white toward the throat during a burn
  vec3 hot = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.95, 0.8), smoothstep(0.4, 1.0, uHeat));
  col = mix(col, hot, uHeat * smoothstep(0.55, 0.0, abs(vLocal.y)));

  float alpha = body * uOpacity;

  // Depth cueing. The far side of a revolved shell is the same brightness as
  // the near side without this, which is precisely why an additive hologram
  // reads flat — you get the silhouette but no sense of volume. Receding
  // surfaces dim and shift blue, the way real scattering media behave.
  float dist = length(cameraPosition - vWorld);
  float near = 1.0 - smoothstep(uNear, uFar, dist);
  alpha *= mix(0.30, 1.0, near);
  col = mix(col * vec3(0.48, 0.72, 1.0), col, near);

  alpha *= mix(1.0, 0.14, uGhost);
  alpha *= 1.0 + uSelected * 1.6 + uHover * 0.7;
  alpha += uHeat * 0.06;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

const WIRE_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>

uniform float uTime;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uGhost;
uniform float uSelected;
uniform float uNear;
uniform float uFar;

varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vViewDir;
varying vec3 vLocal;

void main() {
  #include <clipping_planes_fragment>
  float ndv = abs(dot(normalize(vNormalW), normalize(vViewDir)));
  float edge = pow(1.0 - ndv, 1.4);
  float pulse = 0.90 + 0.10 * sin(uTime * 2.0 + vWorld.y * 8.0);
  float a = uOpacity * (0.10 + edge * 0.30) * pulse;

  // Wireframe lines are the worst aliasing offender in the scene: a 96-segment
  // lathe puts many sub-pixel lines on screen at normal framing, and each one
  // twinkles as it crosses pixel centres. Fading the far half of the mesh both
  // reads as depth and removes most of the twinkling geometry outright.
  float dist = length(cameraPosition - vWorld);
  float near = 1.0 - smoothstep(uNear, uFar, dist);
  a *= mix(0.22, 1.0, near);

  a *= mix(1.0, 0.08, uGhost);
  a *= (1.0 + uSelected * 2.2);
  gl_FragColor = vec4(uColor * mix(vec3(0.55, 0.78, 1.0), vec3(1.0), near), clamp(a, 0.0, 1.0));
}
`;

/** All live hologram materials, ticked once per frame. */
const registry = new Set();

function baseUniforms(opts) {
  return {
    uTime: { value: 0 },
    uColor: { value: new Color(opts.color ?? 0x35c8ff) },
    uAccent: { value: new Color(opts.accent ?? 0xaff4ff) },
    uOpacity: { value: opts.opacity ?? 1 },
    uRim: { value: opts.rim ?? 1.15 },
    uHover: { value: 0 },
    uSelected: { value: 0 },
    uGhost: { value: 0 },
    uScanSpeed: { value: opts.scanSpeed ?? 1.6 },
    // Random horizontal tears. At 0.35 they fired constantly and looked like
    // dropped frames rather than a hologram; occasional is the whole point.
    uGlitch: { value: opts.glitch ?? 0.05 },
    uHeat: { value: 0 },
    // Depth-cueing window, in world units. Tuned to the projection envelope:
    // ~2.75 units tall, viewed from 4–6 units out.
    uNear: { value: 2.6 },
    uFar: { value: 8.5 },
  };
}

export function createSurfaceMaterial(opts = {}) {
  const m = new ShaderMaterial({
    uniforms: baseUniforms(opts),
    vertexShader: COMMON_VERT,
    fragmentShader: SURFACE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: opts.side ?? DoubleSide,
    clipping: true,
    toneMapped: false,
  });
  registry.add(m);
  return m;
}

export function createWireMaterial(opts = {}) {
  const m = new ShaderMaterial({
    uniforms: baseUniforms({ opacity: 0.5, ...opts }),
    vertexShader: COMMON_VERT,
    fragmentShader: WIRE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    wireframe: true,
    clipping: true,
    toneMapped: false,
  });
  registry.add(m);
  return m;
}

/** Additive plume shader with Mach-diamond structure. */
export function createPlumeMaterial() {
  const m = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uCore: { value: new Color(0xdff6ff) },
      uEdge: { value: new Color(0x2ea8ff) },
      uShock: { value: new Color(0xffd08a) },
      uDiamonds: { value: 1 },
      uLength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vPos;
      void main() {
        vUv = uv;
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uThrottle, uDiamonds, uLength;
      uniform vec3 uCore, uEdge, uShock;
      varying vec2 vUv;
      varying vec3 vPos;

      float noise(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        float t = clamp(vUv.y, 0.0, 1.0);          // 0 at nozzle exit, 1 at tail
        float radial = abs(vUv.x - 0.5) * 2.0;

        float body = (1.0 - t) * (1.0 - radial * radial);
        body = pow(max(body, 0.0), 1.35);

        // Mach diamonds: standing shock train, spacing grows downstream
        float d = sin(t * 26.0 * uDiamonds - 0.6) * 0.5 + 0.5;
        d = pow(d, 5.0) * smoothstep(0.02, 0.16, t) * smoothstep(0.9, 0.35, t);

        float turb = noise(vec2(floor(t * 60.0), floor(uTime * 26.0))) * 0.22 * t;

        vec3 col = mix(uCore, uEdge, radial);
        col = mix(col, uShock, d * 0.85);

        float a = (body * 0.85 + d * 0.5 + turb) * uThrottle;
        a *= smoothstep(1.0, 0.6, t + turb);
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
  });
  registry.add(m);
  return m;
}

export function tickMaterials(time) {
  for (const m of registry) {
    if (m.uniforms?.uTime) m.uniforms.uTime.value = time;
  }
}

/** Re-tint every registered material — used by the palette tool. */
export function retint(color, accent) {
  const c = new Color(color);
  const a = new Color(accent);
  for (const m of registry) {
    if (m.uniforms?.uColor) m.uniforms.uColor.value.copy(c);
    if (m.uniforms?.uAccent) m.uniforms.uAccent.value.copy(a);
  }
}

export function disposeMaterial(m) {
  registry.delete(m);
  m.dispose();
}

export const HOLO_AXIS = new Vector3(0, 1, 0);
