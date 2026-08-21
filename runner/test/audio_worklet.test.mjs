// The audio worklet's arithmetic, on plain Node in a second.
//
// runner/src/audio_worklet.js is the one part of Audio Sink / Audio Source that
// does signal work, and two of its paths cannot be reached from a browser test
// at all: the resampling fallback needs a browser that refuses the flowgraph's
// sample rate, and the overrun path needs a ring that fills. So the processors
// are driven here directly, against a plain ArrayBuffer standing in for the
// shared WASM heap and the same control-block layout blocks/src/browser_audio.hpp
// declares. See docs/audio.md.
//
//   node runner/test/audio_worklet.test.mjs
import assert from 'node:assert/strict';

// AudioWorkletGlobalScope, as much of it as the module touches.
globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
const processors = new Map();
globalThis.registerProcessor = (name, factory) => processors.set(name, factory);
await import('../src/audio_worklet.js');

const READ_POS = 0, WRITE_POS = 1, STATE = 2, EVENTS = 4, LOST_FRAMES = 5;
const ACTUAL_RATE = 6, DEVICE_CHANNELS = 7;
const RUNNING = 1, CANCELLED = 3;
const QUANTUM = 128;

// One processor over a ring and a control block in the same buffer, laid out
// exactly as browser_audio.cpp lays them out in the WASM heap.
function build(name, { flowRate = 48000, channels = 1, capacity = 1024, contextRate = 48000 } = {}) {
  globalThis.sampleRate = contextRate;
  const controlPointer = 0;
  const ringPointer = 64;
  const memory = { buffer: new ArrayBuffer(ringPointer + capacity * channels * 4) };
  const processor = new (processors.get(name))({
    processorOptions: {
      memory, ringPointer, controlPointer, capacityFrames: capacity, channels, flowRate,
    },
  });
  return {
    processor,
    control: new Int32Array(memory.buffer, controlPointer, 8),
    ring: new Float32Array(memory.buffer, ringPointer, capacity * channels),
  };
}

const quantum = (channels, fill = () => 0) => Array.from(
  { length: channels }, (_, channel) => Float32Array.from(
    { length: QUANTUM }, (_, i) => fill(i, channel)));

// --- Audio Sink: ring -> speakers -------------------------------------------
{
  const { processor, control, ring } = build('gr-audio-sink');
  for (let i = 0; i < ring.length; ++i) ring[i] = i / 1000;
  Atomics.store(control, WRITE_POS, 512);
  const out = quantum(1);
  assert.equal(processor.process([], [out]), true);
  assert.equal(Atomics.load(control, STATE), RUNNING, 'the first quantum announces RUNNING');
  assert.equal(Atomics.load(control, ACTUAL_RATE), 48000);
  assert.equal(Atomics.load(control, DEVICE_CHANNELS), 1);
  assert.equal(Atomics.load(control, READ_POS), QUANTUM, 'a whole quantum was consumed');
  assert.equal(Atomics.load(control, EVENTS), 0);
  for (let i = 0; i < QUANTUM; ++i)
    assert.equal(out[0][i], ring[i], `sample ${i} reaches the output untouched`);
}

// An underrun plays silence and leaves the ring position alone, so the stream
// resumes in phase rather than part-way through a frame.
{
  const { processor, control } = build('gr-audio-sink');
  Atomics.store(control, WRITE_POS, 10);          // ten frames, a quantum wants 128
  const out = quantum(1, () => 0.5);
  processor.process([], [out]);
  assert.equal(Atomics.load(control, EVENTS), 1, 'the underrun is counted');
  assert.equal(Atomics.load(control, READ_POS), 0, 'and nothing is consumed');
  assert.ok(out[0].every(sample => sample === 0), 'the quantum is silent');
}

// The fallback nobody should reach: a browser that would not give the
// flowgraph's own rate. Half the ring rate means half a ring frame per rendered
// frame, and every other output sample is the midpoint of two ring samples.
{
  const { processor, control, ring } = build(
    'gr-audio-sink', { flowRate: 24000, contextRate: 48000 });
  for (let i = 0; i < ring.length; ++i) ring[i] = i;
  Atomics.store(control, WRITE_POS, 512);
  const out = quantum(1);
  processor.process([], [out]);
  assert.equal(Atomics.load(control, READ_POS), QUANTUM / 2,
    'half as many ring frames as rendered frames');
  for (let i = 0; i < QUANTUM; ++i)
    assert.ok(Math.abs(out[0][i] - i / 2) < 1e-4,
      `sample ${i} is the linear interpolation of the ring`);
}

// A stopped block ends the processor for good.
{
  const { processor, control } = build('gr-audio-sink');
  Atomics.store(control, STATE, CANCELLED);
  assert.equal(processor.process([], [quantum(1)]), false);
}

// --- Audio Source: microphone -> ring ---------------------------------------
{
  const { processor, control, ring } = build('gr-audio-source');
  const input = quantum(1, i => i / 100);
  assert.equal(processor.process([input]), true);
  assert.equal(Atomics.load(control, STATE), RUNNING);
  assert.equal(Atomics.load(control, WRITE_POS), QUANTUM);
  assert.equal(Atomics.load(control, EVENTS), 0);
  for (let i = 0; i < QUANTUM; ++i) assert.equal(ring[i], input[0][i]);
}

// Nothing connected yet: the microphone track is still being attached, and
// writing silence would start the block's clock on a device that is not
// delivering.
{
  const { processor, control } = build('gr-audio-source');
  assert.equal(processor.process([[]]), true);
  assert.equal(Atomics.load(control, STATE), 0, 'still INITIAL');
  assert.equal(Atomics.load(control, WRITE_POS), 0);
}

// A mono device feeding a stereo block: both channels get the same samples,
// and the device's own count is reported.
{
  const { processor, control, ring } = build('gr-audio-source', { channels: 2 });
  const input = quantum(1, i => i);
  processor.process([input]);
  assert.equal(Atomics.load(control, DEVICE_CHANNELS), 1);
  for (let i = 0; i < QUANTUM; ++i) {
    assert.equal(ring[i * 2], i);
    assert.equal(ring[i * 2 + 1], i, 'the mono channel is copied, not silenced');
  }
}

// A live capture cannot be told to slow down: a full ring drops and counts.
{
  const { processor, control } = build('gr-audio-source', { capacity: 200 });
  processor.process([quantum(1, i => i)]);              // 128 of 199 free
  assert.equal(Atomics.load(control, EVENTS), 0);
  processor.process([quantum(1, i => i)]);              // only 71 left
  assert.equal(Atomics.load(control, EVENTS), 1, 'the overrun is counted');
  assert.equal(Atomics.load(control, LOST_FRAMES), 128 - 71);
  assert.equal(Atomics.load(control, WRITE_POS), 199, 'the ring is full, not corrupt');
}

// The capture side of the resampling fallback: an input quantum at twice the
// flowgraph's rate yields half as many frames, and the phase carries across
// quanta rather than restarting at each one.
{
  const { processor, control, ring } = build(
    'gr-audio-source', { flowRate: 24000, contextRate: 48000 });
  processor.process([quantum(1, i => i)]);
  assert.equal(Atomics.load(control, WRITE_POS), QUANTUM / 2);
  for (let i = 0; i < QUANTUM / 2; ++i)
    assert.ok(Math.abs(ring[i] - i * 2) < 1e-4, `frame ${i} is input frame ${i * 2}`);
  // The next quantum continues the ramp: input frame 128 is output frame 64.
  processor.process([quantum(1, i => i + QUANTUM)]);
  assert.equal(Atomics.load(control, WRITE_POS), QUANTUM);
  for (let i = QUANTUM / 2; i < QUANTUM; ++i)
    assert.ok(Math.abs(ring[i] - i * 2) < 1e-4, `frame ${i} continues the ramp`);
}

console.log('checked the audio worklet: ring handoff, underruns, overruns, ' +
            'mono-to-stereo, and both resampling paths');
