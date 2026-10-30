#!/usr/bin/env node
// Renders the template project to a PNG sequence for previewing animations.
// Usage: node render-template.mjs [--scene name] [--fps 4] [--scale 0.5]
//   [--no-sheet] [--video]
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {firefox} from 'playwright';
import {createServer} from 'vite';

const {values: args} = parseArgs({
  options: {
    scene: {type: 'string'},
    fps: {type: 'string', default: '4'},
    scale: {type: 'string', default: '0.5'},
    'no-sheet': {type: 'boolean', default: false},
    video: {type: 'boolean', default: false},
  },
});
const fps = Number(args.fps);
const resolutionScale = Number(args.scale);
const maxSheetTiles = 16;
const sheetColumns = 4;

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, '../../template');
const outputName = 'preview';
const outputDir = resolve(templateRoot, 'output', outputName);
const {ffmpegPath} = createRequire(resolve(here, '../../ffmpeg/package.json'))(
  'ffmpeg-ffprobe-static',
);

await fs.rm(outputDir, {recursive: true, force: true});
// The vite plugin resolves project paths against cwd, not the vite root.
process.chdir(templateRoot);
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';

const server = await createServer({
  root: templateRoot,
  configFile: resolve(templateRoot, 'vite.config.ts'),
  // Scene errors still reach the page, where they are collected below.
  logLevel: 'silent',
}).then(s => s.listen());
const browserServer = await firefox.launchServer({headless: true});

try {
  const browser = await firefox.connect(browserServer.wsEndpoint());
  const page = await browser.newPage();
  const errors = [];
  // Metadata sync with the dev server times out in headless runs; it only
  // affects saving editor state, not rendering.
  const isNoise = text =>
    text.startsWith('ResizeObserver loop') ||
    text.startsWith('Connection timeout when updating metadata');
  page.on('pageerror', error => {
    if (!isNoise(error.message)) errors.push(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !isNoise(message.text())) {
      errors.push(message.text());
    }
  });

  const url = `http://localhost:${server.httpServer.address().port}/`;
  // The first load triggers dependency optimization, which reloads the page
  // once it lands. Let that happen before rendering.
  await page.goto(url);
  await page.waitForSelector('main', {timeout: 60000});
  await page.waitForLoadState('networkidle');
  await page.goto(url);
  try {
    await page.waitForFunction(
      () => !!window.commons && window.commons.player.playback.duration > 0,
      undefined,
      {timeout: 60000},
    );
  } catch (error) {
    console.error(errors.join('\n'));
    throw error;
  }

  const seconds = await page.evaluate(
    async ({name, fps, resolutionScale, sceneName}) => {
      await document.fonts.ready;
      const playback = window.commons.player.playback;
      const scenes = playback.onScenesRecalculated.current;
      let range = [0, Infinity];
      if (sceneName) {
        const scene = scenes.find(scene => scene.name === sceneName);
        if (!scene) {
          throw new Error(
            `No scene "${sceneName}". Available: ${scenes.map(s => s.name).join(', ')}`,
          );
        }
        range = [
          scene.firstFrame / playback.fps,
          scene.lastFrame / playback.fps,
        ];
      }
      const settings = window.commons.meta.getFullRenderingSettings();
      await window.commons.renderer.render({
        ...settings,
        name,
        fps,
        resolutionScale,
        range,
        exporter: {
          name: '@canvas-commons/core/image-sequence',
          options: {fileType: 'image/png', quality: 100, groupByScene: true},
        },
      });
      return Math.min(range[1], playback.duration / playback.fps) - range[0];
    },
    {name: outputName, fps, resolutionScale, sceneName: args.scene},
  );

  // Frames are written by the dev server after the render promise settles.
  let previous = -1;
  let files = [];
  for (let i = 0; i < 100; i++) {
    files = await listPngs(outputDir);
    if (files.length > 0 && files.length === previous) break;
    previous = files.length;
    await new Promise(r => setTimeout(r, 300));
  }
  if (args.scene) {
    // The range end is inclusive, so the next scene's first frame leaks in.
    files = files.filter(file => basename(dirname(file)) === args.scene);
  }

  if (errors.length > 0) console.error(`Page errors:\n${errors.join('\n')}`);
  console.log(
    `Duration: ${seconds.toFixed(2)}s, ${files.length} frames @ ${fps}fps`,
  );
  for (const file of files) console.log(file);

  for (const sceneDir of new Set(files.map(file => dirname(file)))) {
    const frames = files.filter(file => dirname(file) === sceneDir);
    const input = ['-start_number', basename(frames[0], '.png'), '-i'];
    input.push(resolve(sceneDir, '%06d.png'));
    if (!args['no-sheet']) {
      const sheet = `${sceneDir}.sheet.png`;
      const step = Math.ceil(frames.length / maxSheetTiles);
      const tiles = Math.ceil(frames.length / step);
      const rows = Math.ceil(tiles / sheetColumns);
      ffmpeg([
        ...input,
        '-vf',
        `select='not(mod(n\\,${step}))',scale=480:-2,drawtext=text='%{eif\\:n*${step}\\:d}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6,tile=${sheetColumns}x${rows}:padding=4`,
        '-frames:v',
        '1',
        sheet,
      ]);
      console.log(`Sheet: ${sheet} (every ${step} frames)`);
    }
    if (args.video) {
      const video = `${sceneDir}.mp4`;
      const output = ['-r', String(fps), '-pix_fmt', 'yuv420p', video];
      try {
        ffmpeg([
          ...input,
          '-c:v',
          'hevc_nvenc',
          '-preset',
          'p6',
          '-cq',
          '20',
          '-tag:v',
          'hvc1',
          ...output,
        ]);
      } catch {
        ffmpeg([...input, '-c:v', 'libx264', '-crf', '20', ...output]);
      }
      console.log(`Video: ${video}`);
    }
  }
  await browser.close();
} finally {
  await Promise.all([server.close(), browserServer.close()]);
}

function ffmpeg(ffmpegArgs) {
  execFileSync(
    ffmpegPath,
    ['-y', '-loglevel', 'error', '-framerate', String(fps), ...ffmpegArgs],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

async function listPngs(dir) {
  try {
    const entries = await fs.readdir(dir, {recursive: true});
    return entries
      .filter(entry => entry.endsWith('.png'))
      .map(entry => resolve(dir, entry))
      .sort();
  } catch {
    return [];
  }
}
