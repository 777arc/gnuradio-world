import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
export { contentType, setIsolationHeaders } from './http-support.mjs';

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  // Audio Sink and Audio Source. A headless run has no gesture to offer, and
  // the autoplay policy holds every AudioContext suspended without one --
  // resume() then returns a promise that never settles. The fake device pair
  // gives getUserMedia a microphone (a tone, not silence) and grants its
  // permission without a prompt. Chrome still renders Web Audio in real time
  // against a null output device, so the worklet, the ring and the futex
  // handoff are all the real ones. See docs/audio.md.
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
];

// Chrome's documented Linux/headless configuration for exercising WebGPU.
// The bundled headless shell supplies SwiftShader when no hardware Vulkan
// adapter is present, so this remains deterministic on CI hosts.
const WEBGPU_CHROME_ARGS = [
  '--no-sandbox',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--disable-vulkan-surface',
  '--enable-unsafe-webgpu',
];

function findChrome(root, { allowWindows = true } = {}) {
  const base = join(root, 'chrome-headless-shell');
  const local = existsSync(base)
    ? readdirSync(base).map(version =>
        join(base, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
    : [];
  const candidates = allowWindows
    ? [...local, '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe']
    : local;
  return candidates.find(existsSync);
}

export async function launchBrowser(root, options = {}) {
  const executablePath = findChrome(root, options);
  if (!executablePath) {
    throw new Error(
      'Chrome not found. Install it with: ' +
      'npx @puppeteer/browsers install chrome-headless-shell@stable --path .',
    );
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: options.webgpu ? WEBGPU_CHROME_ARGS : CHROME_ARGS,
    // Puppeteer's own default is 180s per CDP call, which is *below* what the
    // callers here wait for: a Graham turn is given 420s, and one call cannot be
    // answered while the page's main thread is busy -- a flowgraph running, a
    // Message Debug filling the console pane. The harness then dies with
    // "Runtime.callFunctionOn timed out" and no transcript at all, which reads
    // as the evaluation being broken rather than the turn being slow. Keep this
    // above every caller's own timeout so the caller is the one that decides.
    protocolTimeout: 600_000,
  });
}

/**
 * Pre-dismiss the "Run without a rate limit?" confirmation, so pressing Run
 * actually starts the flowgraph.
 *
 * A graph with no throttle-flagged block gets a modal on the Run click
 * (askToRunUnpacedFlowgraph in main.ts), and a harness that clicks the button
 * and then waits never answers it: the runner iframe simply never appears, and
 * the run reads as a flowgraph that failed rather than one that was never
 * started. Fifteen of the examples are legitimately unpaced -- the gr-satellites
 * chains are message- and file-driven, and end on their own -- so this is the
 * dialog's dismissal, not a verdict on the flowgraph.
 */
export async function dismissUnpacedRunWarning(page) {
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gnuradio-world.unpaced-run-warning-dismissed', 'yes');
    } catch { /* as above */ }
  });
}

/**
 * Wait until the editor's canvas has settled, so a test can click a block and
 * hit the block it aimed at.
 *
 * Two things move after the page loads. The bootstrap gate says the default
 * flowgraph has arrived -- past it, a block a test places is no longer replaced
 * by the load. But the load is *animated*: the incoming blocks travel to their
 * positions while the flowgraph they replaced flies out in an overlay, and both
 * halves are real DOM nodes carrying real transforms, so a click that lands
 * mid-transition can hit a block still in flight or one that no longer exists.
 * Waiting for the overlay to be torn down and every block/wire animation to
 * finish makes a click deterministic on a slow machine as much as a fast one.
 */
export async function waitForEditorCanvasIdle(page, timeout = 30000) {
  await page.waitForFunction(() =>
    !document.documentElement.classList.contains('app-bootstrapping'), { timeout });
  await page.waitForFunction(() =>
    !document.querySelector('#svg .fly-overlay') &&
    [...document.querySelectorAll('#svg .blk'), document.querySelector('#svg #wires')]
      .every(el => !el || el.getAnimations().every(a => a.playState !== 'running')),
    { timeout, polling: 100 });
}
