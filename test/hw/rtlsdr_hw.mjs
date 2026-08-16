// Hardware harness for RTL-SDR Source. Needs a dongle plugged in, so it is
// deliberately NOT part of any CI suite -- test/fixtures/rtlsdr_fake.grc covers
// the block without hardware. This exercises the half the fake cannot: the
// RTL2832U register protocol, and whether a retune reaches the tuner at all.
//
//   node test/hw/rtlsdr_hw.mjs [--headful] [--freq 100.1e6] [--keep-profile]
//
// The permission prompt is answered through CDP's DeviceAccess domain, and the
// grant is kept in a persistent Chrome profile under test/hw/.profile, so only
// the first run has to answer it. See docs/rtlsdr.md.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('../..', import.meta.url).pathname;
const PAGE = 'http://localhost:8090/test/hw/rtlsdr_hw.html';
// Real hardware needs WebUSB, which chrome-headless-shell does not carry -- it
// is a stripped build with no device APIs. So hardware runs use a full Chrome
// for Testing, installed alongside it with:
//
//   npx @puppeteer/browsers install chrome@stable --path ./chrome-for-testing
//
// The fake device needs no WebUSB, so it can use whichever is present.
function findChrome() {
  const full = join(ROOT, 'chrome-for-testing', 'chrome');
  if (existsSync(full)) {
    for (const version of readdirSync(full).sort().reverse()) {
      const candidate = join(full, version, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  if (!FAKE) return null;
  const shell = join(ROOT, 'chrome-headless-shell');
  if (existsSync(shell)) {
    for (const version of readdirSync(shell).sort().reverse()) {
      const candidate = join(shell, version, 'chrome-headless-shell-linux64',
                             'chrome-headless-shell');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : fallback;
};

// --fake runs the whole harness against the reader's built-in generator, with
// no dongle and no WebUSB. It proves the harness itself -- the page, the ring,
// the command mailbox, the FFT peak finder -- so that a run against real
// hardware is testing the driver rather than the test.
const FAKE = flag('fake');
const HEADFUL = flag('headful');
const CENTER = value('freq', 100.1e6);
const SAMPLE_RATE = value('rate', 2048000);
const PROFILE = join(ROOT, 'test/hw/.profile');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ++failures;
};

async function main() {
  const executablePath = findChrome();
  if (!executablePath)
    throw new Error(
      'no usable Chrome found. Hardware runs need a full build:\n' +
      '  npx @puppeteer/browsers install chrome@stable --path ./chrome-for-testing');
  console.log(`  browser: ${executablePath}${FAKE ? '  (fake device)' : ''}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: !HEADFUL,
    // A persistent profile keeps the WebUSB grant between runs, so only the
    // first hardware run has to answer the chooser. The fake device needs no
    // grant, so it stays on a throwaway profile.
    ...(FAKE ? {} : { userDataDir: PROFILE }),
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', error => console.log('  PAGEERROR', error.message));

  try {
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });

    // ---- permission -------------------------------------------------------
    const shared = FAKE ? [] : await page.evaluate(async () => {
      if (!navigator.usb) return null;
      return (await navigator.usb.getDevices()).map(d => ({
        serial: d.serialNumber ?? '', product: d.productName ?? '',
        vendorId: d.vendorId, productId: d.productId,
      }));
    });
    if (!FAKE && shared === null) {
      check(false, 'navigator.usb exists',
        HEADLESS_HINT);
      return;
    }
    if (!FAKE) console.log(`  already shared: ${JSON.stringify(shared)}`);

    if (!FAKE && !shared.length) {
      console.log('  requesting device access via CDP DeviceAccess…');
      const [prompt] = await Promise.all([
        page.waitForDevicePrompt({ timeout: 20000 }),
        page.click('#grant'),
      ]);
      const device = await prompt.waitForDevice(
        ({ name }) => /RTL|Realtek|DVB/i.test(name), { timeout: 20000 });
      console.log(`  chooser offered: ${device.name}`);
      await prompt.select(device);
      await sleep(500);
    }

    if (!FAKE) {
      const devices = await page.evaluate(async () =>
        (await navigator.usb.getDevices()).map(d => d.productName ?? '(unnamed)'));
      check(devices.length > 0, 'a device is shared with this origin', devices.join(', '));
      if (!devices.length) return;
    }

    // ---- open and stream --------------------------------------------------
    await page.evaluate((sampleRate, centerFreq, FAKE) => window.__start({
      serial: FAKE ? 'fake:200000' : '', sampleRate, centerFreq,
      gainTenths: 300, agc: true,
      directSampling: 0, bufflen: 262144, capacityPairs: 1 << 20,
    }), SAMPLE_RATE, CENTER, FAKE);

    await sleep(3000);
    let stats = await page.evaluate(() => window.__stats());
    if (stats.error) {
      check(false, 'streaming starts', stats.error);
      for (const line of stats.trace) console.log('    ', line);
      return;
    }
    check(stats.captured > 0, 'samples arrive',
      `${(stats.captured / 2).toLocaleString()} IQ pairs captured`);
    check(stats.actualRate > 0, 'device reports its achievable rate',
      `${stats.actualRate} S/s (requested ${SAMPLE_RATE})`);
    const tuner = stats.messages.find(m => m.type === 'tuner');
    if (tuner) console.log(`  tuner: ${tuner.tuner}, ${tuner.manufacturer} / ${tuner.model}`);

    // ---- does a retune actually reach the tuner? --------------------------
    // The check that matters. An error-free retune proves nothing: the failure
    // this harness exists for was a retune that reported success while the
    // hardware stayed put. So measure where the strongest carrier sits before
    // and after, and require it to move by the amount asked for.
    const OFFSET = 300000;
    await page.evaluate(() => window.__recapture());
    await sleep(1200);
    const before = await page.evaluate(() => window.__peak());
    console.log(`  before: peak bin ${before?.bin} of ${before?.bins}, ` +
                `snr ${before?.snr?.toFixed(1)}`);

    const seq = await page.evaluate(hz => window.__setFrequency(hz), CENTER + OFFSET);
    console.log(`  retune to ${(CENTER + OFFSET) / 1e6} MHz (seq ${seq})`);
    await sleep(1500);
    stats = await page.evaluate(() => window.__stats());
    check(!stats.error, 'retune completes without a USB error', stats.error || '');
    check(stats.cmdAck === seq, 'the worker acknowledged the command',
      `ack=${stats.cmdAck} seq=${seq}`);

    await page.evaluate(() => window.__recapture());
    await sleep(1200);
    const after = await page.evaluate(() => window.__peak());
    console.log(`  after:  peak bin ${after?.bin} of ${after?.bins}, ` +
                `snr ${after?.snr?.toFixed(1)}`);

    if (FAKE) {
      // The generator emits a fixed tone and ignores tuning, so it cannot move
      // a carrier. What it *can* prove is that the ring, the capture and the
      // FFT agree: 'fake:200000' must land at 200 kHz.
      const hzPerBin = stats.actualRate / after.bins;
      const toneHz = after.bin * hzPerBin;
      check(Math.abs(toneHz - 200000) < hzPerBin * 4,
        'the generated tone lands where the FFT says it should',
        `${(toneHz / 1e3).toFixed(1)} kHz, expected 200.0 kHz`);
      console.log('  [SKIP] carrier-moved check — the generator has no tuner; ' +
                  'run without --fake against a dongle for that');
    } else if (before && after && before.snr > 8 && after.snr > 8) {
      // Tuning up by OFFSET moves a fixed carrier down by OFFSET in baseband.
      const hzPerBin = stats.actualRate / after.bins;
      const movedHz = (after.bin - before.bin) * hzPerBin;
      check(Math.abs(movedHz + OFFSET) < OFFSET * 0.35,
        'the hardware actually retuned',
        `carrier moved ${(movedHz / 1e3).toFixed(0)} kHz, expected ${-OFFSET / 1e3} kHz`);
    } else {
      console.log('  [SKIP] no carrier strong enough to track — ' +
                  `try --freq <a strong local FM station in Hz> ` +
                  `(snr before ${before?.snr?.toFixed(1)}, after ${after?.snr?.toFixed(1)})`);
    }

    // ---- several retunes in a row ----------------------------------------
    let stormOk = true;
    for (let i = 1; i <= 5 && stormOk; ++i) {
      const s = await page.evaluate(hz => window.__setFrequency(hz), CENTER + i * 100000);
      await sleep(700);
      const now = await page.evaluate(() => window.__stats());
      if (now.error || now.cmdAck !== s) { stormOk = false; console.log(`    retune ${i}: ${now.error || 'not acked'}`); }
    }
    check(stormOk, 'five consecutive retunes all apply');

    stats = await page.evaluate(() => window.__stats());
    console.log(`  overruns=${stats.overruns} droppedPairs=${stats.droppedPairs}`);

    // ---- stop, then open the device a second time -------------------------
    // Covers the device.close() in RTL2832U.close(): without it the dongle
    // stays claimed by the page and the second run cannot take the interface.
    await page.evaluate(() => window.__stop());
    await sleep(1200);
    await page.evaluate((sampleRate, centerFreq, FAKE) => window.__start({
      serial: FAKE ? 'fake:200000' : '', sampleRate, centerFreq,
      gainTenths: 300, agc: true,
      directSampling: 0, bufflen: 262144, capacityPairs: 1 << 20,
    }), SAMPLE_RATE, CENTER, FAKE);
    await sleep(2500);
    stats = await page.evaluate(() => window.__stats());
    check(!stats.error && stats.captured > 0, 'the device reopens after a stop',
      stats.error || `${(stats.captured / 2).toLocaleString()} IQ pairs on the second run`);

    // ---- a rate the hardware struggles with -------------------------------
    await page.evaluate(() => window.__stop());
    await sleep(1200);
    await page.evaluate((centerFreq, FAKE) => window.__start({
      serial: FAKE ? 'fake:200000' : '', sampleRate: 3200000, centerFreq,
      gainTenths: 300, agc: true,
      directSampling: 0, bufflen: 262144, capacityPairs: 1 << 20,
    }), CENTER, FAKE);
    await sleep(3000);
    stats = await page.evaluate(() => window.__stats());
    check(!stats.error && stats.captured > 0, 'streams at 3.2 MS/s',
      stats.error || `rate ${stats.actualRate}, overruns ${stats.overruns}, ` +
      `dropped ${stats.droppedPairs}`);

    await page.evaluate(() => window.__stop());
    await sleep(400);
  } finally {
    await browser.close();
  }
}

const HEADLESS_HINT =
  'navigator.usb is undefined — WebUSB is unavailable in this Chrome mode. ' +
  'Re-run with --headful.';

main()
  .then(() => {
    console.log(failures ? `\nRTL-SDR HARDWARE: ${failures} FAILED` : '\nRTL-SDR HARDWARE: ALL PASS');
    process.exit(failures ? 1 : 0);
  })
  .catch(error => {
    console.error('\nRTL-SDR HARDWARE: ERROR —', error.message);
    process.exit(1);
  });
