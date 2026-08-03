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
  return puppeteer.launch({ executablePath, headless: true, args: CHROME_ARGS });
}
