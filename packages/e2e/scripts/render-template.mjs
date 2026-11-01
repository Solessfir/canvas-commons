#!/usr/bin/env node
// Renders the template project to a PNG sequence for previewing animations.
// Usage: node render-template.mjs [--scene name] [--fps 4] [--scale 0.5]
//   [--no-sheet] [--video] [--final] [--browser firefox|msedge|chrome|chromium] [--headed] [--webcodecs]
// --final renders an upload master: 4K60 10-bit HEVC, no contact sheet.
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {chromium, firefox} from 'playwright';
import {createServer} from 'vite';

const {values: args} = parseArgs({
  options: {
    scene: {type: 'string'},
    fps: {type: 'string'},
    scale: {type: 'string'},
    'no-sheet': {type: 'boolean', default: false},
    video: {type: 'boolean', default: false},
    final: {type: 'boolean', default: false},
    browser: {type: 'string', default: 'firefox'},
    headed: {type: 'boolean', default: false},
    webcodecs: {type: 'boolean', default: false},
  },
});
const fps = Number(args.fps ?? (args.final ? 60 : 4));
const resolutionScale = Number(args.scale ?? (args.final ? 2 : 0.5));
const sheet = !args['no-sheet'] && !args.final;
const video = args.video || args.final;
// Masters get re-encoded by the platform, so spend bits to keep them clean;
// 10-bit avoids banding on flat backgrounds and gradients.
const nvencArgs = args.final
  ? ['-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '16', '-b:v', '0']
  : ['-preset', 'p6', '-cq', '20'];
const nvencFormat = args.final
  ? ['-profile:v', 'main10', '-pix_fmt', 'p010le']
  : ['-pix_fmt', 'yuv420p'];
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
// --browser firefox|chromium|msedge|chrome. Headless Edge rendered the same
// frames ~35% faster than headless Firefox and can decode HEVC footage.
const browserType = args.browser === 'firefox' ? firefox : chromium;
const gpuPrefs = {
  'gfx.webrender.all': true,
  'layers.acceleration.force-enabled': true,
  'gfx.canvas.accelerated': true,
  'media.hardware-video-decoding.force-enabled': true,
};
const browserServer = await browserType.launchServer({
  headless: !args.headed,
  ...(args.browser === 'firefox'
    ? {firefoxUserPrefs: args.headed ? gpuPrefs : {}}
    : {
        channel: args.browser === 'chromium' ? undefined : args.browser,
        args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
      }),
});

try {
  const browser = await browserType.connect(browserServer.wsEndpoint());
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
  // Large media (a Video node streaming its file) can keep the network busy
  // indefinitely, so don't fail when it never goes idle.
  await page.waitForLoadState('networkidle', {timeout: 15000}).catch(() => {});
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

  // --webcodecs encodes the mp4 inside the browser instead of writing a PNG per
  // frame for ffmpeg. Headless Chromium has only software encoders: OpenH264
  // for H.264 (no HEVC) and libvpx for VP9.
  const exporter = args.webcodecs
    ? {
        name: '@canvas-commons/webcodecs',
        options: {
          // Masters go through a near-lossless VP9 intermediate (fixed
          // quantizer 4, ~170 Mbps) that ffmpeg re-encodes below. Everything
          // coarser, and every bitrate mode (the only ones OpenH264 offers),
          // smooths away the grain that dithers dark gradients, and their
          // banding comes back.
          videoCodec: args.final ? 'vp9' : 'avc',
          videoQuality: 'high',
          quantizer: args.final ? 4 : undefined,
          keyframeInterval: 2,
          realtime: !args.final,
          includeAudio: false,
          fastStart: true,
        },
      }
    : {
        name: '@canvas-commons/core/image-sequence',
        options: {fileType: 'image/png', quality: 100, groupByScene: true},
      };
  // The exporter writes `output/<project name>.mp4`, so take the mp4 that
  // appears there after the render starts.
  const renderStart = Date.now();
  const findWebcodecsFile = async () => {
    const dir = resolve(templateRoot, 'output');
    for (const entry of await fs.readdir(dir).catch(() => [])) {
      if (!entry.endsWith('.mp4') || entry.startsWith('.')) continue;
      const stat = await fs.stat(resolve(dir, entry));
      if (stat.mtimeMs >= renderStart && stat.size > 0)
        return resolve(dir, entry);
    }
    return null;
  };

  const seconds = await page.evaluate(
    async ({name, fps, resolutionScale, sceneName, exporter}) => {
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
        exporter,
      });
      return Math.min(range[1], playback.duration / playback.fps) - range[0];
    },
    {name: outputName, fps, resolutionScale, sceneName: args.scene, exporter},
  );

  if (args.webcodecs) {
    // The exporter uploads the finished mp4 to the dev server after the render
    // promise settles; wait for it, then put it where the PNG path would.
    let webcodecsFile = null;
    for (let i = 0; i < 200 && !webcodecsFile; i++) {
      webcodecsFile = await findWebcodecsFile();
      if (!webcodecsFile) await new Promise(r => setTimeout(r, 300));
    }
    if (errors.length > 0) console.error(`Page errors:\n${errors.join('\n')}`);
    if (!webcodecsFile) throw new Error('WebCodecs export produced no file.');
    const videoFile = resolve(outputDir, `${args.scene ?? outputName}.mp4`);
    await fs.mkdir(outputDir, {recursive: true});
    if (args.final) {
      // 10-bit HEVC at QP 10 keeps the grain (QP 18 already flattens it back
      // into bands); x264's grain tuning is the CPU fallback.
      const encode = codecArgs =>
        execFileSync(
          ffmpegPath,
          [
            '-y',
            '-loglevel',
            'error',
            '-i',
            webcodecsFile,
            ...codecArgs,
            // The browser tags its output with the sRGB transfer, which
            // YouTube renders with crushed, shifted colors.
            '-color_primaries',
            'bt709',
            '-color_trc',
            'bt709',
            '-colorspace',
            'bt709',
            videoFile,
          ],
          {stdio: ['ignore', 'ignore', 'pipe']},
        );
      try {
        encode([
          '-c:v',
          'hevc_nvenc',
          '-preset',
          'p7',
          '-tune',
          'hq',
          '-rc',
          'constqp',
          '-qp',
          '10',
          '-profile:v',
          'main10',
          '-pix_fmt',
          'p010le',
          '-tag:v',
          'hvc1',
        ]);
      } catch {
        encode([
          '-c:v',
          'libx264',
          '-preset',
          'slow',
          '-tune',
          'grain',
          '-crf',
          '16',
        ]);
      }
      await fs.rm(webcodecsFile);
    } else {
      await fs.rename(webcodecsFile, videoFile);
    }
    console.log(`Duration: ${seconds.toFixed(2)}s @ ${fps}fps (WebCodecs)`);
    console.log(`Video: ${videoFile}`);
    await browser.close();
    await Promise.all([server.close(), browserServer.close()]);
    process.exit(0);
  }

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
    if (sheet) {
      const sheetFile = `${sceneDir}.sheet.png`;
      const step = Math.ceil(frames.length / maxSheetTiles);
      const tiles = Math.ceil(frames.length / step);
      const rows = Math.ceil(tiles / sheetColumns);
      ffmpeg([
        ...input,
        '-vf',
        `select='not(mod(n\\,${step}))',scale=480:-2,drawtext=text='%{eif\\:n*${step}\\:d}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6,tile=${sheetColumns}x${rows}:padding=4`,
        '-frames:v',
        '1',
        sheetFile,
      ]);
      console.log(`Sheet: ${sheetFile} (every ${step} frames)`);
    }
    if (video) {
      const videoFile = `${sceneDir}.mp4`;
      const output = ['-r', String(fps), videoFile];
      try {
        ffmpeg([
          ...input,
          '-c:v',
          'hevc_nvenc',
          ...nvencArgs,
          ...nvencFormat,
          '-tag:v',
          'hvc1',
          ...output,
        ]);
      } catch {
        const crf = args.final ? '16' : '20';
        const format = ['-pix_fmt', 'yuv420p'];
        ffmpeg([
          ...input,
          '-c:v',
          'libx264',
          '-crf',
          crf,
          ...format,
          ...output,
        ]);
      }
      console.log(`Video: ${videoFile}`);
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
