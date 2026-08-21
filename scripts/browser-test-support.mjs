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
  });
}

export async function suppressEditorWelcome(page) {
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('gnuradio_world_welcome_seen', '1'); }
    catch { /* localStorage is unavailable for opaque documents */ }
  });
}
