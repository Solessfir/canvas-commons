---
name: animate
description:
  Create or edit a Canvas Commons animation from a text description, then render
  frames and visually check them. Use when asked to make, add, or tweak an
  animation, scene, or motion graphic in this repo.
---

# Animate

The loop is write scene, typecheck, render frames, look at frames, fix, repeat.
Don't report a scene as done without having looked at its rendered frames.

## Where scenes go

- Playground project: `packages/template/src/project.ts` (single project,
  `scenes: [...]`).
- Scenes: `packages/template/src/scenes/<name>.tsx`, imported as
  `import foo from './scenes/foo?scene';`.
- Render just the scene you are working on with `--scene <name>` (the file name
  without extension).
- The first render or editor load creates `scenes/<name>.meta` (time events,
  seed). It belongs with the scene.
- The template is a maintainer playground. Unless asked, don't commit scene
  changes. For documentation examples, use `packages/examples` instead (see its
  AGENTS.md).

## Commands

pnpm may not be on PATH. If it isn't, use `npx -y pnpm@latest`.

```bash
# Typecheck (fast; catches most API misuse)
pnpm --filter @canvas-commons/template exec tsc --noEmit

# Render to PNGs plus a contact sheet (defaults: all scenes, 4 fps, 0.5 scale)
node packages/e2e/scripts/render-template.mjs [--scene name] [--fps 4] [--scale 0.5] [--no-sheet] [--video] [--final]
  [--browser firefox|msedge|chrome|chromium] [--headed] [--webcodecs]
```

The script prints the duration, the page errors (so runtime exceptions in a
scene show up there) and one PNG path per frame under
`packages/template/output/preview/<scene>/` (gitignored). It also writes
`<scene>.sheet.png`, a grid of up to 16 evenly spaced frames labelled with their
frame numbers.

Review the sheet first; it shows the whole animation in one image. Then open
individual frames for detail. To check timing precisely, raise the fps; to check
fine detail, raise the scale to 1. Pass `--video` (with `--fps 30`) to write
`<scene>.mp4` for the user to watch; it uses `hevc_nvenc` and falls back to
`libx264`. Preview videos are half resolution and look soft; for a user judging
quality, use `--scale 1` or `--final`.

`--final` renders an upload master instead: 60 fps, no sheet, 4K (scale 2) by
default. On the PNG path that is 10-bit HEVC at `-cq 16`, but 4K writes a 9 MB
PNG per frame and renders at under 1 fps. For uploads use
`--final --scale 1.3333334 --browser msedge --webcodecs`: exactly 2560x1440 (the
WebCodecs exporter rounds the size down, so `1.3333333333333333` gives an odd
2559x1439 that H.264 rejects), about 5 minutes for 85 s. The browser writes a
near-lossless VP9 intermediate (fixed quantizer 4) and ffmpeg re-encodes it to
10-bit HEVC at QP 10 with NVENC (~43 Mbps). Anything coarser in either step, and
any bitrate mode, smooths away the grain that dithers dark gradients, so their
banding comes back. 1440p is still above 1080p, so YouTube gives it the higher
bitrate.

Requirements: the packages must be built (`pnpm -r build`; the docs build may
fail without consequence) and Firefox must be installed
(`pnpm --filter @canvas-commons/e2e exec playwright install firefox`).

Rendering rewrites `packages/template/src/*.meta` and `scenes/*.meta` (it only
normalizes their formatting). Revert them with
`git checkout -- 'packages/template/src/**.meta'` unless you meant to change
them.

For anything longer than a few seconds, add `--browser msedge --webcodecs`:
headless Edge renders the same frames ~35% faster than headless Firefox, and
WebCodecs encodes the mp4 in the browser instead of writing a PNG per frame,
which was about 5x faster on a 75 s scene (getting frames out of the browser is
the bottleneck: JPEG frames were no faster than PNG). It produces only the
video, no frames or sheet. Headless Edge has no hardware encoders, only OpenH264
and libvpx. Previews for the user can then be `--fps 60 --scale 1` (1080p60,
under 2 minutes for 85 s), which shows motion jitter that half-resolution
previews hide.

## Showing the user

Hand off with the editor, not just a file: start `pnpm template:dev` in the
background and point the user to http://localhost:9000 (Vite picks the next free
port if 9000 is taken, so read it from the output). It hot-reloads on scene
edits, so later tweaks show up live. Add an mp4 (`--video` or `--final`) when
they want something to share.

## Scene skeleton

```tsx
import {Circle, Rect, Txt, makeScene2D} from '@canvas-commons/2d';
import {
  all,
  chain,
  createRef,
  easeInOutCubic,
  sequence,
  waitFor,
} from '@canvas-commons/core';

export default makeScene2D(function* (view) {
  const box = createRef<Rect>();
  const label = createRef<Txt>();

  view.add(
    <Rect ref={box} size={200} radius={24} fill={'#e13238'}>
      <Txt ref={label} text={'Hi'} fill={'white'} fontSize={64} />
    </Rect>,
  );

  yield* box().position.x(300, 1, easeInOutCubic);
  yield* all(box().rotation(90, 0.6), box().fill('#68abdf', 0.6));
  yield* chain(label().text('Bye', 0.5), waitFor(0.3));
  yield* box().scale(0, 0.4);
});
```

Staggering a group, the pattern for most "pop in one by one" effects:

```tsx
const dots = createRefArray<Circle>();
view.add(
  <>
    {colors.map((color, i) => (
      <Circle ref={dots} x={-450 + i * 300} size={120} fill={color} scale={0} />
    ))}
  </>,
);
yield * sequence(0.12, ...dots.map(dot => dot.scale(1, 0.5, easeOutBack)));
```

## Core ideas

- JSX creates long-lived scene-graph nodes, not a virtual DOM. Build them once,
  then animate their signals.
- Every property is a signal: `node().x()` reads it, `node().x(5)` sets it, and
  `node().x(5, 1, easing)` returns a tween you `yield*`. Chain with
  `.to(value, duration)`, and use `.wait(seconds)` for a pause.
- Signals can take functions to make one property follow another:
  `<Circle x={() => box().x() + 200} />`.
- Coordinates: (0, 0) is the center of the view, +y points down, and rotation is
  in degrees. The default view is 1920x1080.
- `yield*` waits for an animation. Without `yield*`, nothing happens over time.

## Flow (from `@canvas-commons/core`)

- `all(...)` runs animations in parallel. `any(...)` waits for the first to
  finish.
- `chain(...)` runs them in order. `sequence(delay, ...)` staggers them.
- `delay(seconds, task)`, `waitFor(seconds)`, `waitUntil('event')` (time events,
  editable in the editor), `loop(count, i => ...)`.
- `spawn(task)` starts a task in the background.
- Easing: `linear`, `easeIn|Out|InOut` +
  `Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce`.
- Transitions between scenes: `slideTransition`, `fadeTransition`,
  `zoomInTransition`, `zoomOutTransition`, called at the start of a scene.
- Refs: `createRef<T>()` and `createRefArray<T>()`. Read the node with `ref()`.

## Nodes (from `@canvas-commons/2d`)

`Node`, `Layout` (flexbox via `layout`, `direction`, `gap`, `alignItems`...),
`Rect`, `Circle`, `Line`, `Polygon`, `Ray`, `Spline`, `Path`, `Grid`, `Txt`,
`Code`, `Latex`, `Img`, `Video`, `SVG`, `Icon`, `Camera`.

Common props: `x`, `y`, `position`, `scale`, `rotation`, `opacity`, `fill`,
`stroke`, `lineWidth`, `size`, `width`, `height`, `radius`, `zIndex`, `clip`,
`end`/`start` (for drawing shapes progressively), `filters`, `shadowBlur`,
`shadowColor`.

Hierarchy at runtime: `view.add(node)`, `node().add(child)`, `node().remove()`,
`node().children()`.

## Images, video and audio

- Import assets so Vite serves them:
  `import clip from '../../output/<name>/clip.mp4';`, then
  `<Video src={clip} />` or `<Img src={...} />`. Keep large or one-off media in
  the gitignored `packages/template/output/` rather than `src/`. JSON imports
  work the same way (`import data from './x.json'`).
- `Video` starts paused: call `video().play()` at the point in the scene where
  it should start and `video().pause()` when it should stop. Set
  `width`/`height` to the size the video was encoded at; for phone recordings,
  encode at a constant fps first (they are usually variable).
- Rounded or framed footage: wrap the `Video` in `<Rect radius={..} clip>`.
- Filters take an array of filter functions:
  `filters={[blur(18), brightness(0.5)]}` (`blur`, `brightness`, `contrast`,
  `saturate`, `grayscale`, `sepia`, `invert`, `hue` from `@canvas-commons/2d`).
- Renders are image sequences, so `--video`/`--final` output has no audio. Mux
  it afterwards with ffmpeg (`-af adelay=<ms>:all=1` to offset it to where the
  video starts). Editing recordings into a trailer is covered by the `montage`
  user skill.

## When unsure

Don't guess. Read the source and the docs:

- Docs: `packages/docs/docs/getting-started/*.mdx` (tweening, flow, signals,
  layouts, positioning, references, transitions, camera, presentation) and
  `packages/docs/docs/components/`.
- Working scenes: `packages/examples/src/scenes/*.tsx`.
- Node props: `packages/2d/src/lib/components/<Node>.ts` (look for
  `@initial`/`@signal` fields).

## Gotchas

- Text sizes and positions depend on fonts. Check the rendered frames, don't
  assume layout, and check that text fits its container with some margin.
- With `layout` on a parent, its children's `x`/`y` are controlled by flexbox.
  Animate `margin`/`padding`/`size` instead, or set `layout={false}` on the
  child.
- "Tried to access an asynchronous property before the node was ready", with a
  stack through `requestFontLoad`, is a font-load race in the editor's first
  pass. If the frames look right, ignore it. The same error with a stack through
  `video`/`clampTime` comes from a `Video` node's metadata loading and is also
  harmless when the frames show the footage.
- The origin/pivot prop is `anchor` (Motion Canvas called it `offset`):
  `anchor={[-1, -1]}` pins a node by its top-left corner, e.g. left-aligned
  text.
- Don't animate layout props (`gap`, `padding`, `letterSpacing`, `width` inside
  a layout) for motion: layout snaps to whole pixels, so things step and jitter
  instead of gliding. Animate `scale`, `translate`, `opacity` or `position` on
  non-layout nodes instead.
- Text that moves stair-steps in whole pixels: Chrome snaps glyphs to the pixel
  grid when the transform is a pure translation (Firefox may too), and `cache`
  doesn't help because caches are rendered in screen space. Give moving `Txt` an
  invisible `rotation={0.05}`; non-axis-aligned text is drawn at its exact
  sub-pixel position. Measured on a 36 px rise: whole-pixel jumps became a
  smooth ease-out.
- `yield node().scale(2, 10)` (no `*`) starts a long background tween without
  blocking, for example a slow push-in on a backdrop for the whole scene.
- The render script's page errors go to the top of its output, so pipe it
  through `Select-Object -First` or `head` to see them and through `-Last` or
  `tail` for the sheet path.
- The repo forbids `!` null assertions and `any`. Keep scenes type-safe.
