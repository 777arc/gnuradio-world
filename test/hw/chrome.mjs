// Finding a Chrome the hardware harness can drive. Shared by rtlsdr_hw.mjs and
// grant.mjs, which otherwise disagree about where to look the moment one of
// them is edited.
//
// Real hardware needs WebUSB, which chrome-headless-shell does not carry -- it
// is a stripped build with no device APIs. So hardware runs need a full Chrome
// for Testing, installed alongside it with:
//
//   npx @puppeteer/browsers install chrome@stable --path ./chrome-for-testing
//
// The reader's own generator ('fake') needs no WebUSB, so those runs can fall
// back to whichever build is present.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;

export const INSTALL_HINT =
  'Install Chrome first:\n' +
  '  npx @puppeteer/browsers install chrome@stable --path ./chrome-for-testing';

/** Newest install under `dir`, or null. Layout is <dir>/<version>/<...parts>. */
function newestUnder(dir, ...parts) {
  if (!existsSync(dir)) return null;
  for (const version of readdirSync(dir).sort().reverse()) {
    const candidate = join(dir, version, ...parts);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param allowHeadlessShell accept the stripped build too, which is only safe
 *   for a run that never touches WebUSB.
 */
export function findChrome(allowHeadlessShell = false) {
  const full = newestUnder(
    join(ROOT, 'chrome-for-testing', 'chrome'), 'chrome-linux64', 'chrome');
  if (full || !allowHeadlessShell) return full;
  return newestUnder(join(ROOT, 'chrome-headless-shell'),
                     'chrome-headless-shell-linux64', 'chrome-headless-shell');
}
