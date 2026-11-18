# AGENT FORGE — Holographic Propulsion Lab

A 3D holographic workbench for opening up, analysing and re-engineering liquid
rocket thrust chambers. Grab the assembly and pull it apart, slice it in half,
fire it, and change its geometry — with a Claude design agent that has direct
control of the same hardware you do, and optional webcam hand-gesture control
with the room behind the hologram.

Nothing here is a loaded 3D asset. Every part is generated from the design
parameters, so changing the throat radius or expansion ratio genuinely rebuilds
the engine and re-solves its performance.

---

## Run it

```bash
npm install
npm run dev
```

Then open <http://localhost:5273>.

For a production build:

```bash
npm run build && npm start
```

### Giving it the design agent

The console works immediately on a local intent engine. To hand the workbench
to Claude, copy `.env.example` to `.env` and add your key:

```bash
cp .env.example .env
# ANTHROPIC_API_KEY=sk-ant-...
```

Restart, and the rail reads `AI · claude-opus-5`. **The key never reaches the
browser** — a proxy at `/api/ai` (see `server/aiRouter.js`) is the only thing
that talks to Anthropic; the tool-use loop runs client-side so tools act
directly on the live scene.

---

## Controls

### Mouse and keyboard

| | |
|---|---|
| drag empty space | orbit |
| **drag a part** | pull the assembly apart along that part's own axis |
| click | inspect a component |
| double-click | isolate it |
| scroll | zoom |
| `X` | exploded view | 
| `C` | cutaway section |
| `I` | isolate |
| `G` | deck grid |
| `N` | new custom part |
| `D` | sketch pad — draw an object, load a matching model |
| `Tab` | cycle how much interface shows (`shift+Tab` reverses) |
| `H` | gesture control |
| `space` | static fire |
| `1`–`6` | view presets |
| `Ctrl/⌘+Z` | undo |
| `/` | focus the command console |

### Hand gestures (webcam)

Click **Enable camera** on the gesture deck, or press `H`. The camera feed
becomes the room behind the hologram, your hands are tracked and drawn over it,
and the assembly floats in front of you.

| | |
|---|---|
| ✋ one open palm, moving | orbit |
| 🤏 one pinch, moving | grab and swing it (faster, 1:1) |
| 🤏🤏 two pinches, pull apart | exploded view |
| ✋✋ two open palms, in/out | dolly |
| ☝️ index point | aim the reticle; hold to select a part |
| ✊ fist | clutch — freeze, reposition your arm, resume |

Continuous gestures are **relative**: the anchor is re-captured whenever a
gesture starts, so clutching out with a fist lets you re-centre your arm and
keep going. That's what gives full range of motion without running out of reach.

### Why it doesn't feel twitchy

Four things, and they matter more than the raw gain:

- **Pointer acceleration.** Gain isn't constant. A slow, deliberate hand gets
  about a third of it, so you can land on one flange; a fast sweep gets more
  than full gain, so you can still spin the model right round. Fine control and
  full range stop competing.
- **A dead zone.** Hand travel under 0.35 % of the frame is treated as noise, so
  a resting hand doesn't drift the model.
- **Input is eased on the render clock.** Detection runs at 34 Hz and rendering
  at 60+. Applying camera deltas straight from the detector stamped its slower
  cadence onto every movement — most of what read as stutter. Gesture output is
  now accumulated and eased out every frame.
- **One Euro filtering** — low lag when your hand moves fast, heavy smoothing
  when it's nearly still. A plain moving average has to trade one for the other,
  which is why raw landmark tracking either jitters or feels like treacle.

There's a **Sensitivity** slider on the gesture deck (0.3×–1.8×), remembered
across sessions. Reach, camera field of view and how steady your hands are all
vary; the right gain is a personal setting, not a constant.

### Pointing at something, then talking about it

Aim a finger and hold. The reticle **snaps** to a nearby component rather than
demanding a pixel-perfect hit, **names** what it's over before you commit, and
keeps its target for a moment if the ray slips off — so a wobble doesn't reset
the dwell ring.

Once something is selected — by pointing, or just by clicking it — the console
shows a chip naming it, and **"this", "that" and "it" refer to it**:

```
what is this            make this niobium
move this to the bell   delete it
```

That works on the offline engine and with Claude driving. If nothing is
selected, you get told so rather than having a part guessed for you.

The camera feed keeps **its own colour** — full saturation, no cool tint. Your
room looks like your room.

It does not keep its own *brightness*, and those are separate decisions. The
hologram is additive with surface alphas around 0.02–0.25, so a lit room at
full exposure simply buries it. Two things keep both readable:

- Exposure sits at ~60 %, with a **Room brightness** slider on the gesture deck
  (5–130 %, remembered across sessions). Rooms vary enormously; there is no one
  value that suits a sunlit desk and a dark study.
- **The pocket.** The middle of the frame — where the projection stands — is
  held darker than the edges. Dimming the *whole* feed to make the hologram
  readable defeats the point of AR, because the room and your hands are what
  you turned the camera on to see. The pocket keeps the periphery bright and
  opens a well behind the hardware.

The agent can adjust any of it with `set_room`.

Hand tracking is [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).
The WASM runtime and the model are vendored into `public/mediapipe/`, so it runs
**entirely locally** — no CDN at runtime and no video leaves the machine.

---

## Designing your own parts

The ten stock components are only what the engine ships with. **Custom parts**
are authored from a form, a mount and a duty, and are then real in every sense
the stock hardware is: pickable, explodable, sliced by the cutaway, counted in
the dry mass, and subject to their own failure check.

Press `N`, or **New part** on the design panel. The agent can do the same thing
with `create_part`.

### Form — what shape it is

| | |
|---|---|
| **Ring / flange** | revolved rectangular section — bolt flanges, stiffeners |
| **Conic shell** | wall between two radii — skirts, nozzle extensions, liners |
| **Dome / closure** | elliptical cap — bulkheads, injector domes |
| **Ported plate** | annular plate with a port ring — faceplates, baffles |
| **Torus manifold** | closed collector ring |
| **Pod array** | radial ring of capped cylinders — RCS pods, bottles, bays |
| **Strut ring** | cone of tubular struts — thrust structures, engine mounts |
| **Bladed disc** | disc plus blades — turbine wheels, pump impellers |
| **Vane set** | radial blades — swirl vanes, jet vanes, flow straighteners |
| **Helical coil** | wrapped tube run — heat exchangers, spiral cooling passes |

### Mount — where it attaches

Injector plane, pump deck, chamber wall, throat plane, bell mid-span, exit
plane, or free on the centreline. Mounts resolve against the **live** contour,
so a part re-locates when the engine geometry changes.

### Sizing — the choice that matters

In **relative** mode every length is a multiple of the mount's reference
radius. Double the throat radius and a relative flange doubles with it, its
mass going up eightfold, exactly as it should. In **absolute** mode lengths are
fixed millimetres and hold their dimensions while the engine changes around
them. Switching modes *converts* rather than reinterprets, so the hardware
never jumps.

### Duty — how it is allowed to fail

The form decides shape and mass. The duty decides which failure mode is checked
against it, and each one is solved from the same physics as the stock engine:

- **Load path** — compressive stress from the thrust it carries, plus Euler
  buckling where the form is slender. On a strut ring buckling almost always
  governs, and because I ≈ πr³t, strut *diameter* buys margin far faster than
  wall thickness does.
- **Pressure vessel** — membrane stress through the wall. A dome is checked on
  its crown radius of curvature R²/h rather than its base radius, which is why
  shallow domes are the ones that fail.
- **Hot gas path** — local Bartz flux from the mount's area ratio, then either
  the conduction rise q·t/k for a regen-cooled part or the radiative
  equilibrium (q/εσ)^¼ for an uncooled one. This is what makes radiation
  cooling only work at high area ratios: put an uncooled niobium extension at
  ε = 16 and it settles at 2800 K against a 1400 K limit.
- **Rotating** — rim stress ρU² at tip speed. The result that caps
  turbomachinery tip speed no matter how the wheel is built.
- **Fluid line** — velocity and Darcy pressure drop for its share of the mass
  flow.
- **Inert mass** — no check; mass, envelope and CG only.

### It changes the engine

Added mass moves the thrust-to-weight ratio, and each part's axial station
moves the centre of gravity — both reported on the analysis panel. A part
outside its margin raises a flag next to the stock engine's own flags. There is
no separate, softer standard for hardware you designed yourself.

---

## The physics is real

The numbers on the analysis panel are solved, not decorative.

- **Nozzle contour** — Rao thrust-optimised parabolic bell: a 0.382·Rt
  downstream throat arc turning the flow to θn, then a quadratic Bézier out to
  the exit lip at θe, with θn/θe interpolated from Rao's tabulated data.
  Conical and truncated-aerospike contours are also generated.
- **Performance** — 1-D isentropic relations. Exit Mach is inverted from the
  area–Mach relation by Newton iteration with a bisection guard; thrust
  coefficient carries both momentum and pressure terms plus a divergence
  correction λ = ½(1+cos α); c* uses the Vandenkerckhove function.
- **Ambient** — US Standard Atmosphere 1976, so altitude drives back-pressure,
  over/under-expansion, and the Summerfield flow-separation criterion.
- **Cooling** — Bartz-style peak throat flux, then integrated along the actual
  wall contour with q ∝ (At/A)^0.9. Integrating matters: the throat has the
  highest flux but a tiny area; the chamber and bell carry most of the load.
- **Structure** — split the way a regen chamber is really built. A closeout
  jacket takes the hoop load; the selected material is the thin hot-wall liner,
  checked on ΔT = q·t/k against its temperature limit. Conductivity buys thermal
  margin, not pressure capability.

Spot checks against real hardware: the sea-level kerolox preset solves to
817 kN / 271 s at sea level (Merlin 1D: ~845 kN / 282 s), and the hydrolox
vacuum preset to 431 s at ε=110 (RL10-class).

The models are first-order and frozen-equilibrium — good to a few percent, not
a substitute for CEA and a real thermal FEA.

---

## Layout

```
src/
  main.js               orchestration, render loop, display state
  core/
    scene.js            renderer, camera, controls, bloom + hologram grade
    holoMaterial.js     Fresnel/scanline/glitch shaders, plume, clipping
    environment.js      deck grid, emitter pad, dust, AR camera backdrop
    hud3d.js            3D panel placement, projected anchoring, leader lines
    interaction.js      hover, selection, grab-and-pull-apart
    hands.js            webcam gestures, One Euro filtering, AR mode
  model/
    profile.js          meridian contour generation (Rao / conical / aerospike)
    thruster.js         procedural assembly, 10 named components
    physics.js          performance, cooling, structural solvers
    meshkit.js          shared hologram mesh construction
    forms.js            custom-part form library — geometry + measurement
    customPart.js       mounts, sizing, definition schema, duty solvers
  ui/
    panels.js           parameters, live analysis, component inspector
    partEditor.js       custom part authoring
    console.js          the command console
  ai/
    tools.js            tool schemas + executor (one path, two brains)
    agent.js            Claude tool-use loop
    localIntent.js      offline intent parser
  state/store.js        parameters, UI state, undo, event bus
server/
  aiRouter.js           /api/ai proxy — the only thing holding the key
  index.js              production static server
```

The agent and the offline parser share **one** executor (`ai/tools.js`), so
adding an API key changes reasoning quality, not capability.

---

## Interface

The design position: **the projection is the subject; the instruments wrap
around it.** Two rules, and they pull against each other on purpose.

**The chrome belongs to the projection.** Panels are sheets of lit glass
standing in a volume — edge-lit borders, an emitter rule along the top, a
registration tick under each header — arranged as a shallow arc that turns to
face you and parallaxes as you orbit. The model sits large and lifted clear of
that arc rather than sharing a band with it.

**The content belongs to the engineer.** Inside the frame nothing glows.
Achromatic, dense, sans for language and tabular mono for numbers; colour only
ever means *ok / caution / fault* or marks the one active control.

That split is the whole thing. Chrome that reads as a projection plus content
that reads as instrumentation gives you the workshop without giving up the
ability to actually read a margin at a glance. Either rule alone fails: all
chrome is a film prop, all content is a spreadsheet.

The room matters as much as the glass. A cool projection only reads as
*emitted light* if there's something warm behind it, so the backdrop carries a
row of warm practicals along the far wall and a field of defocused lamps well
outside the working volume. They're deliberately dim — bright enough to set a
colour temperature against, never bright enough to compete.

### Reading as a volume rather than a picture

An additive hologram draws the far wall of a revolved shell at exactly the same
brightness as the near wall. You get a correct silhouette and no depth at all,
which is the single biggest reason this kind of render looks flat. Two cues fix
it, and both are cheap:

- **Depth cueing.** Surfaces dim and shift blue with distance from the camera,
  the way real scattering media behave. It also removes most of the wireframe
  twinkle for free — a 96-segment lathe puts many sub-pixel lines on screen,
  and fading the far half deletes the worst of them.
- **A ground bounce.** A soft pool of light on the deck beneath the projection,
  tracking the assembly's footprint and dimming as it's pulled apart. Without
  it the hologram is a bright object floating over an unrelated floor; with it
  the floor acknowledges the light and the eye reads contact.

Some specifics worth knowing:

- **Yaw is capped at 11.5°.** It's what makes the rig read as surrounding you,
  and it's also what costs legibility. Past about 15° a 306 px column of 11 px
  type starts to fringe on the far edge and tabular numbers stop scanning.
- **Warm practicals are wide in azimuth and tight in elevation** — a horizontal
  fixture seen side-on. Narrow-in-azimuth renders as vertical shafts, which read
  as light leaks rather than lamps.
- **Exposure is 0.82.** Additive hologram layers routinely sum past 1.0 where a
  revolved shell doubles back on itself; the injector alone stacks a dome, a
  faceplate, eighteen coax elements and a flange. Exposure is the cheapest place
  to buy that headroom back without flattening the Fresnel rim that carries the
  read.

- Hierarchy from size, weight and contrast — not from glow. The frame is lit;
  the data is not.
- Sans for language, tabular mono for numbers. Uppercase tracking is reserved
  for small section labels, never body text.
- The component inspector is anchored to the part it describes and joined by a
  leader line drawn in WebGL — perspective doing actual work.
- **Panels move.** Drag any panel by its header; double-click the header to
  send it home. Positions persist across sessions, and a drag is stored as a
  displacement *from* the docked position rather than as an absolute — so a
  moved panel still tracks window resizes and still sits in the arc. You are
  adjusting the rig, not detaching a card from it. Dragging is clamped so a
  panel can never end up somewhere you can't drag it back from.
- The analysis panel shows a **thrust-vs-altitude curve** with the operating
  point, matched altitude and separation region marked, and a **live wall
  contour** of the shape your parameters are producing. A nozzle designer reads
  the shape of the answer, not a column of numbers.

Panels are built once and updated by writing to cached nodes. The solve runs on
every slider frame, so the earlier `innerHTML` rebuild was throwing away scroll
position, killing transitions and dropping focus mid-drag.

## Reference geometry from the web

The workbench can search for a 3D model, download it and stand it on the deck
beside the projection — for scale, for context, for a payload to look at.

- **`D`** opens the sketch pad. Draw something; Claude looks at the drawing,
  names it, and searches the catalogue. Without an API key nothing can
  recognise a drawing, so the pad asks you to type what it is instead — which
  reaches the same search.
- The agent can do it directly: `search_reference_models` then
  `load_reference_model`.

**These are reference geometry, and the distinction is load-bearing.** The
engine is generated from design parameters, which is exactly what lets it be
solved. An imported mesh has no wall thickness, no bore and no duty — so it is
never massed, never in the centre of gravity, never given a margin, and not
selectable into the inspector. It is in the room, not in the analysis. Every
tool result says so, in those words, so the agent can't imply otherwise.

Source models are re-shaded into the hologram on the way in; a lit PBR asset
standing next to an additive projection reads as a mistake.

### How it works

`Poly Haven` is the zero-configuration provider — everything on it is CC0 and
no key is needed. Both halves have to be server-side:

- **Search**, because model catalogues don't send CORS headers a browser will
  accept.
- **Fetch**, because a glTF is rarely one file. The client points its loader's
  URL resolver at `/api/models/proxy`, so buffers and textures arrive through
  one allowlisted hop. The proxy only serves an explicit host allowlist — an
  open proxy is a liability — and caps transfers at 48 MB.

Two things that cost me time and are worth knowing:

- **Dependencies are not stored beside the glTF.** Poly Haven keeps a 1k
  glTF's buffer under `gltf/8k/` and its textures under `jpg/`. Resolving them
  relative to the glTF's own URL 404s, and a 404 body parsed as a binary buffer
  fails deep inside the glTF reader with a typed-array length error that points
  nowhere near the cause. The API publishes a dependency manifest; the loader
  honours it.
- **Never forward the upstream `Content-Length` through a proxy.** `fetch`
  transparently decompresses gzip, so that header describes the *compressed*
  size — forwarding it silently truncates the body.

Textures are answered with a 1×1 pixel rather than downloaded, since every
source material is discarded and replaced by the hologram shader anyway. That's
three JPEGs per model not fetched.

## Getting the interface out of the way

`Tab` cycles three levels, `shift+Tab` reverses, `Esc` unwinds one step at a
time:

| | |
|---|---|
| **full** | every panel |
| **clear** | design and analysis hidden; the console and status rail stay, so you can still talk to the agent while looking at bare hardware |
| **bare** | the projection alone |

Also reachable in words — `hide the panels`, `show the ui`, `cinematic` — and by
the agent, via `set_view { focus }`, so it can put you in front of geometry
instead of numbers when that's the better way to make a point.

It's a display state, not a design state: it never touches the model or the
solve, so entering and leaving is always free. A single dim chip stays on
screen as the way back — a hidden interface should never be a trap.

## Keeping it smooth

- **Rebuilds are coalesced to one per frame.** A slider drag emits `input`
  events far faster than a full rebuild takes (13–90 ms of lathing geometry and
  compiling materials), so rebuilding per event meant the drag was always racing
  a queue it could never drain. Sixty parameter writes now cost ~5 ms and one
  rebuild instead of sixty. Anything that *reads* the model flushes the pending
  rebuild first, so deferring never hands back stale numbers.
- **Adaptive resolution.** Bloom plus two full-screen shader passes at native
  retina density is the bulk of the frame cost. The renderer watches frame time
  and steps between 1×–2× pixel ratio; dropping resolution under load is much
  less visible than dropping frames.
- **Stripe patterns are faded out before they alias.** This was the real source
  of the shimmer. The surface shader drew interference lines at 320 cycles per
  world unit — about 880 bands across a 2.75-unit model, well past one cycle
  per pixel. Beyond the sampling limit the phase lands randomly per pixel per
  frame, so the pattern *crawls*, and crawling noise is what the eye reports as
  flicker. Every periodic band now uses `fwidth` to roll its amplitude off
  exactly where it stops being resolvable: detail appears as you zoom in and
  dissolves as you pull back, rather than boiling.
- **Global luminance jitter is gone.** A term that multiplies every pixel in the
  frame by a random value at 24 Hz is not an effect, it is flicker. There is no
  amount of it that doesn't read as a fault.
- **Scanlines sample the unwarped coordinate.** Taking them after the barrel
  warp made their spacing vary across the frame and beat against the resampling
  whenever the camera moved.
- **The resolution tuner can't hunt.** It ignores a settling window after each
  change, needs sustained evidence to move, and ratchets — it will never climb
  back past a level that has already proven too slow. A tuner oscillating
  between two pixel ratios is worse than one that picks the wrong ratio and
  stays there.
- **The remaining glitch effects are quiet.** Scanlines, grain and the random
  horizontal tears are still there at roughly a third of their old amplitude,
  and the tears now hold for a beat instead of resampling every frame.
- **The idle drift yields.** The slow rotation that keeps the projection from
  looking frozen now waits 2.2 s after your last camera input and fades back in,
  so it never fights a hand trying to hold a part steady.
- The AR skeleton overlay draws at 1.5× rather than full retina density, with
  one cheap glow pass on the bones only — canvas `shadowBlur` is rasterised per
  draw call and was the single most expensive thing in the frame.

## Notes

- Panels are DOM cards inside a CSS `perspective` volume, positioned from the 3D
  scene each frame. `CSS3DRenderer` was tried first and removed: it works in
  pixel-scale space — an object must sit `(viewportHeight/2)/tan(fov/2)` units
  from the camera to render 1:1 — which is irreconcilable with a scene whose
  subject is two metres tall, and every CSS length gets magnified with it.
- The renderer uses `preserveDrawingBuffer` so screen captures of the design are
  deterministic rather than timing-dependent.
