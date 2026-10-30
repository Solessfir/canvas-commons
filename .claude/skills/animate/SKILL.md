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
`libx264`.

`--final` renders an upload master instead: 4K (scale 2), 60 fps, 10-bit HEVC at
`-cq 16`, no sheet. Use it for YouTube even when the target is 1080p, since
YouTube gives 4K uploads a higher bitrate.

Requirements: the packages must be built (`pnpm -r build`; the docs build may
fail without consequence) and Firefox must be installed
(`pnpm --filter @canvas-commons/e2e exec playwright install firefox`).

Rendering rewrites `packages/template/src/*.meta` and `scenes/*.meta` (it only
normalizes their formatting). Revert them with
`git checkout -- 'packages/template/src/**.meta'` unless you meant to change
them.

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
  assume layout.
- With `layout` on a parent, its children's `x`/`y` are controlled by flexbox.
  Animate `margin`/`padding`/`size` instead, or set `layout={false}` on the
  child.
- "Tried to access an asynchronous property before the node was ready", with a
  stack through `requestFontLoad`, is a font-load race in the editor's first
  pass. If the frames look right, ignore it.
- The repo forbids `!` null assertions and `any`. Keep scenes type-safe.
