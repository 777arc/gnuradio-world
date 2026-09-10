#!/usr/bin/env node
// A GRWire client with no browser in it.
//
// This exists to cut the problem in half. When the block in the browser shows
// no samples, the question is always "is it the daemon or is it the browser",
// and this answers it: it speaks the same protocol, parses the same frames and
// checks the same invariants, with none of WASM, the shared ring or the
// scheduler involved.
//
//   node tools/probe.mjs ws://127.0.0.1:8073/ws?token=... [options]
//
//   --seconds N     how long to stream           (default 5)
//   --rate N        requested output rate        (default 2048000)
//   --freq N        centre frequency in Hz       (default 100e6)
//   --decim N       decimation factor            (default: let the daemon plan)
//   --offset N      digital offset in Hz         (default 0)
//   --format F      ci8 | ci16 | cf32            (default ci8)
//   --device ARGS   device args string           (default: first non-fake)
//   --gains SPEC    per-stage gains, e.g. LNA=24,VGA=20
//   --no-flow       never acknowledge, to watch the window drop frames

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('ws://') || a.startsWith('wss://'));
if (!url) {
  console.error('usage: node tools/probe.mjs <ws url with ?token=...> [options]');
  process.exit(2);
}
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const seconds = Number(option('seconds', 5));
const wantRate = Number(option('rate', 2048000));
const wantFreq = Number(option('freq', 100e6));
// Absent by default, so the daemon plans it -- which is what a real client
// does, and the only way this tool exercises that path.
const decimOption = option('decim', null);
const decim = decimOption === null ? null : Number(decimOption);
const offset = Number(option('offset', 0));
const format = option('format', 'ci8');
const wantDevice = option('device', null);
const wantGains = option('gains', null);
const sendFlow = !flag('no-flow');

const HEADER_BYTES = 32;
const MAGIC = 0x31575247; // 'GRW1' little-endian
const BYTES_PER_SAMPLE = { 1: 2, 2: 4, 3: 8 };

// A self-signed certificate is the norm here, not an anomaly -- the daemon
// cannot get a real one for a name like raspberrypi.local. The browser handles
// this with a one-time click; this tool has no user to click, so it accepts.
const socket = new WebSocket(url, ['grwire.v1'], { rejectUnauthorized: false });

let opened = false;
let applied = null;
let lastStats = null;
let frames = 0;
let samples = 0;
let bytes = 0;
let discontinuities = 0;
let sequenceGaps = 0;
let indexGaps = 0;
let expectedSeq = null;
let expectedIndex = null;
let lastSeq = 0;
let firstFrameAt = null;
let lastFrameAt = null;
const signal = [];

const send = (message) => socket.send(JSON.stringify(message));

socket.on('open', () => console.log(`connected to ${url.replace(/token=[^&]*/, 'token=***')}`));

socket.on('message', (data, isBinary) => {
  if (isBinary) return onFrame(data);
  const event = JSON.parse(data.toString());
  switch (event.ev) {
    case 'hello':
      console.log(`daemon: ${event.host}, grwire ${event.version}, backends: ${event.backends.join(', ')}`);
      send({ op: 'list' });
      break;
    case 'devices': {
      console.log('\nradios:');
      for (const device of event.devices) console.log(`  ${device.args}\n    ${device.label}`);
      const chosen =
        wantDevice ?? (event.devices.find((d) => d.driver !== 'fake') ?? event.devices[0])?.args;
      if (!chosen) fail('no radios to open');
      console.log(`\nopening ${chosen}`);
      send({ op: 'open', device: chosen, direction: 'rx', channel: 0 });
      break;
    }
    case 'opened':
      opened = true;
      console.log(`opened: ${event.info.driver}, gains ${event.info.gain_elements.join('/') || 'none'}, antennas ${event.info.antennas.join('/') || 'none'}`);
      send({
        op: 'configure',
        rate: wantRate,
        freq: wantFreq,
        ...(decim === null ? {} : { decim }),
        ...(wantGains ? { gains: Object.fromEntries(
          wantGains.split(/[,;\s]+/).filter(Boolean).map((p) => {
            const [name, value] = p.split(/[=:]/);
            return [name, Number(value)];
          })) } : {}),
        offset,
        format,
        gain: 30,
      });
      break;
    case 'config':
      applied = event.applied;
      if (!started) {
        started = true;
        console.log(
          `\nconfigured: hardware ${applied.hw_rate} S/s / decim ${applied.decim} => ${applied.out_rate} S/s out, ` +
            `${applied.frame_samples} samples per frame (${(applied.frame_samples / applied.out_rate * 1000).toFixed(1)} ms)`
        );
        for (const warning of applied.warnings ?? []) console.log(`  warning: ${warning}`);
        send({ op: 'start' });
        setTimeout(finish, seconds * 1000);
      }
      break;
    case 'stats':
      lastStats = event;
      break;
    case 'error':
      fail(`${event.code}: ${event.message}`);
      break;
  }
});

let started = false;

function onFrame(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail('frame did not start with the GRW1 magic');
  const format = view.getUint8(5);
  const flags = view.getUint16(6, true);
  const count = view.getUint32(12, true);
  const seq = Number(view.getBigUint64(16, true));
  const index = Number(view.getBigUint64(24, true));

  if (firstFrameAt === null) {
    firstFrameAt = process.hrtime.bigint();
    // Do not count this frame's samples: they were produced before the window
    // opened. Counting them inflates the measured rate at short durations.
    lastFrameAt = firstFrameAt;
    expectedSeq = seq + 1;
    expectedIndex = index + count;
    lastSeq = seq;
    return;
  }
  lastFrameAt = process.hrtime.bigint();
  if (flags & 1) discontinuities += 1;
  // seq must never skip: a gap means a frame was lost in transit, which is a
  // different fault from the daemon deliberately dropping one.
  if (expectedSeq !== null && seq !== expectedSeq) sequenceGaps += 1;
  expectedSeq = seq + 1;
  // sample_index may skip -- that is exactly how a deliberate drop is reported.
  if (expectedIndex !== null && index !== expectedIndex) indexGaps += 1;
  expectedIndex = index + count;
  lastSeq = seq;

  const expectedBytes = HEADER_BYTES + count * BYTES_PER_SAMPLE[format];
  if (data.byteLength !== expectedBytes) {
    fail(`frame ${seq}: ${data.byteLength} bytes, header says ${expectedBytes}`);
  }

  frames += 1;
  samples += count;
  bytes += data.byteLength;

  if (signal.length < 8192 && format === 1) {
    for (let i = 0; i < count && signal.length < 8192; i += 1) {
      signal.push([
        view.getInt8(HEADER_BYTES + i * 2) / 127,
        view.getInt8(HEADER_BYTES + i * 2 + 1) / 127,
      ]);
    }
  }

  if (sendFlow && frames % 4 === 0) {
    send({ op: 'flow', ack_seq: lastSeq, ring_used: 0.1 });
  }
}

/// Coarse DFT peak, to confirm the samples that arrived are the signal that was
/// asked for rather than merely the right number of bytes.
function dominantFrequency(iq, rate) {
  const n = Math.min(iq.length, 4096);
  let best = { freq: 0, power: -1 };
  for (let bin = 0; bin < n; bin += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (-2 * Math.PI * bin * i) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      re += iq[i][0] * c - iq[i][1] * s;
      im += iq[i][0] * s + iq[i][1] * c;
    }
    const power = re * re + im * im;
    if (power > best.power) {
      let freq = (bin * rate) / n;
      if (freq > rate / 2) freq -= rate;
      best = { freq, power };
    }
  }
  return best.freq;
}

function finish() {
  const elapsed =
    firstFrameAt && lastFrameAt ? Number(lastFrameAt - firstFrameAt) / 1e9 : 0;
  const achieved = elapsed > 0 ? samples / elapsed : 0;

  console.log('\n--- results ---');
  console.log(`frames        ${frames}`);
  console.log(`samples       ${samples}`);
  console.log(`bytes         ${(bytes / 1e6).toFixed(2)} MB  (${((bytes * 8) / elapsed / 1e6).toFixed(1)} Mbit/s)`);
  console.log(`rate          ${achieved.toFixed(0)} S/s  (asked ${applied?.out_rate ?? wantRate})`);
  if (applied?.out_rate) {
    const error = Math.abs(achieved - applied.out_rate) / applied.out_rate;
    console.log(`rate error    ${(error * 100).toFixed(2)}%`);
  }
  console.log(`seq gaps      ${sequenceGaps}   (frames lost in transit -- must be 0)`);
  console.log(`index gaps    ${indexGaps}   (deliberate drops, reported)`);
  console.log(`discontinuity ${discontinuities} frames flagged`);

  if (signal.length > 256 && applied?.out_rate) {
    const peak = dominantFrequency(signal, applied.out_rate);
    console.log(`peak tone     ${(peak / 1e3).toFixed(1)} kHz in the received band`);
    // The only way to confirm a gain setting reached the hardware: a daemon
    // that accepted it without complaint proves nothing about the radio.
    const rms = Math.sqrt(
      signal.reduce((acc, [re, im]) => acc + re * re + im * im, 0) / signal.length);
    console.log(`signal rms    ${rms.toFixed(5)} (${(20 * Math.log10(rms || 1e-9)).toFixed(1)} dBFS)`);
  }

  if (lastStats) {
    console.log('\ndaemon-side accounting:');
    console.log(`  device overruns  ${lastStats.dev_overruns}`);
    console.log(`  host drops       ${lastStats.host_drops}`);
    console.log(`  net drops        ${lastStats.net_drops}`);
    console.log(`  client drops     ${lastStats.client_drops}`);
    console.log(`  dropped samples  ${lastStats.dropped_samples}`);
    console.log(`  in flight        ${lastStats.in_flight}`);
    console.log(`  measured rate    ${lastStats.measured_rate.toFixed(0)} S/s${lastStats.rate_suspect ? '   <-- DISAGREES with the reported rate' : ''}`);
  }

  const ok = frames > 0 && sequenceGaps === 0;
  console.log(`\n${ok ? 'GRWIRE_PROBE_PASS' : 'GRWIRE_PROBE_FAIL'}`);
  socket.close();
  process.exit(ok ? 0 : 1);
}

function fail(message) {
  console.error(`\nerror: ${message}`);
  console.log('GRWIRE_PROBE_FAIL');
  process.exit(1);
}

socket.on('error', (error) => fail(error.message));
socket.on('close', () => {
  if (!opened) fail('the socket closed before a radio was opened');
});
