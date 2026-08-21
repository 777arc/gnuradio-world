// The browser end of Audio Sink and Audio Source: one AudioWorkletProcessor per
// block, moving frames between the browser's audio realm and a ring in shared
// WebAssembly memory. The GNU Radio side is blocks/src/browser_audio.cpp.
//
// Everything here runs on the audio rendering thread, which is real-time: it is
// called once per 128-frame render quantum and must return promptly. So there
// are no allocations in process(), no postMessage per quantum, and no waiting --
// Atomics.notify is allowed here, Atomics.wait is not (and is never needed: the
// block waits, this side never does).

// The CTRL indices and the states are one layout in two files -- `struct
// Control` in blocks/src/browser_audio.hpp is the other. Adding a field means
// editing both, in the same order.
const READ_POS = 0;
const WRITE_POS = 1;
const STATE = 2;
const ERROR_LENGTH = 3;
const EVENTS = 4;
const LOST_FRAMES = 5;
const ACTUAL_RATE = 6;
const DEVICE_CHANNELS = 7;
const CONTROL_SLOTS = 8;

const INITIAL = 0;
const RUNNING = 1;
const ERROR = 2;
const CANCELLED = 3;

// Shared by both directions: the ring geometry, the views onto it, and the
// control-block bookkeeping. Only the direction of travel differs below.
class RingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const setup = (options && options.processorOptions) || {};
    this.memory = setup.memory;
    this.ringPointer = setup.ringPointer;
    this.controlPointer = setup.controlPointer;
    this.capacity = setup.capacityFrames;
    this.channels = setup.channels;
    // The flowgraph's sample rate. `sampleRate` is the AudioContext's, which is
    // normally the same -- runner.html asks for the flowgraph's -- but a
    // browser is free to refuse, and then this ratio is what keeps the pitch
    // right rather than letting the audio play fast or slow. Linear
    // interpolation: a fallback nobody should reach, not a resampler.
    this.flowRate = setup.flowRate;
    this.buffer = null;
    this.ring = null;
    this.control = null;
    this.stopped = false;
    this.announced = false;
    // Fractional position between two ring frames, carried across quanta.
    this.phase = 0;
    this.port.onmessage = event => {
      if (event.data && event.data.type === 'stop') this.stopped = true;
    };
  }

  // Re-derive the views whenever the heap has grown. On the -pthread shared
  // heap a stale view still addresses the same memory, but cannot reach memory
  // that only exists after the growth -- so the check is on the buffer
  // identity, not on a try/catch. See docs/js-blocks.md for the same trap.
  views() {
    const buffer = this.memory.buffer;
    if (this.buffer !== buffer) {
      this.buffer = buffer;
      this.ring = new Float32Array(
        buffer, this.ringPointer, this.capacity * this.channels);
      this.control = new Int32Array(buffer, this.controlPointer, CONTROL_SLOTS);
    }
    return this.control;
  }

  // False once the block has stopped, which is this processor's cue to be
  // collected: returning false ends it for good.
  alive(control) {
    if (this.stopped || Atomics.load(control, STATE) === CANCELLED) return false;
    if (!this.announced) {
      this.announced = true;
      // The rate the device actually runs at, and the channel count it gave us,
      // are only knowable here. The block prints them once.
      Atomics.store(control, ACTUAL_RATE, Math.round(sampleRate));
      Atomics.store(control, DEVICE_CHANNELS, this.deviceChannels);
      Atomics.store(control, STATE, RUNNING);
      Atomics.notify(control, STATE);
    }
    return true;
  }

  used(control) {
    const readPosition = Atomics.load(control, READ_POS);
    const writePosition = Atomics.load(control, WRITE_POS);
    return writePosition >= readPosition
      ? writePosition - readPosition
      : this.capacity - (readPosition - writePosition);
  }

  count(control, slot, amount) {
    Atomics.store(control, slot, Atomics.load(control, slot) + amount);
  }
}

// Audio Sink: ring -> speakers. The block fills the ring and blocks when it is
// full, which is what makes the sound card the flowgraph's clock.
class AudioSinkProcessor extends RingProcessor {
  constructor(options) {
    super(options);
    this.deviceChannels = this.channels;
    // Ring frames consumed per rendered frame.
    this.step = this.flowRate / sampleRate;
  }

  process(_inputs, outputs) {
    const control = this.views();
    if (!this.alive(control)) return false;

    const out = outputs[0];
    const frames = out[0].length;
    const channels = Math.min(this.channels, out.length);
    const available = this.used(control);
    // One interpolation needs the frame after the last one read, so ask for the
    // extra frame whenever the phase is not exactly on a frame boundary.
    const exact = this.step === 1 && this.phase === 0;
    const need = exact ? frames : Math.ceil(this.phase + frames * this.step) + 1;

    if (available < need) {
      // An underrun is a gap in the sound whatever we do; a whole silent
      // quantum is the version that leaves the ring position alone, so the
      // stream resumes in phase rather than half a frame off.
      for (let channel = 0; channel < out.length; ++channel) out[channel].fill(0);
      this.count(control, EVENTS, 1);
      return true;
    }

    const readPosition = Atomics.load(control, READ_POS);
    const ring = this.ring;
    const capacity = this.capacity;
    const width = this.channels;

    if (exact) {
      for (let i = 0; i < frames; ++i) {
        const base = ((readPosition + i) % capacity) * width;
        for (let channel = 0; channel < channels; ++channel)
          out[channel][i] = ring[base + channel];
      }
      this.advance(control, frames);
    } else {
      let position = this.phase;
      for (let i = 0; i < frames; ++i) {
        const index = Math.floor(position);
        const fraction = position - index;
        const base = ((readPosition + index) % capacity) * width;
        const next = ((readPosition + index + 1) % capacity) * width;
        for (let channel = 0; channel < channels; ++channel)
          out[channel][i] = ring[base + channel] +
            (ring[next + channel] - ring[base + channel]) * fraction;
        position += this.step;
      }
      const consumed = Math.floor(position);
      this.phase = position - consumed;
      this.advance(control, consumed);
    }
    // Channels the device has but the flowgraph does not drive: silence rather
    // than whatever the previous quantum left there.
    for (let channel = channels; channel < out.length; ++channel) out[channel].fill(0);
    return true;
  }

  advance(control, frames) {
    if (!frames) return;
    Atomics.store(control, READ_POS,
      (Atomics.load(control, READ_POS) + frames) % this.capacity);
    // Wakes the block's emscripten_futex_wait on the same address.
    Atomics.notify(control, READ_POS);
  }
}

// Audio Source: microphone -> ring. A live capture cannot be told to slow down,
// so a full ring drops and counts, exactly as the USB radios do.
class AudioSourceProcessor extends RingProcessor {
  constructor(options) {
    super(options);
    this.deviceChannels = 0;
    // Input frames consumed per frame handed to the flowgraph.
    this.step = sampleRate / this.flowRate;
    // The last frame of the previous quantum, which is sample index -1 of this
    // one: with a fractional step an output frame regularly falls across the
    // seam between two quanta.
    this.previous = new Float32Array(this.channels);
    // Reused every quantum so the render thread allocates nothing.
    this.sources = new Array(this.channels).fill(null);
  }

  process(inputs) {
    const control = this.views();
    // alive() is deliberately after the empty-input check below: announcing
    // RUNNING before the microphone track is attached would start the block's
    // clock on a device that is not delivering yet.
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) {
      if (this.stopped || Atomics.load(control, STATE) === CANCELLED) return false;
      return true;
    }
    this.deviceChannels = input.length;
    if (!this.alive(control)) return false;

    const frames = input[0].length;
    const ring = this.ring;
    const capacity = this.capacity;
    const width = this.channels;
    // A mono microphone feeding a stereo block: copy the last channel the
    // device does have, which is what every other audio tool does with one.
    for (let channel = 0; channel < width; ++channel)
      this.sources[channel] = input[Math.min(channel, input.length - 1)];

    const free = capacity - this.used(control) - 1;
    const exact = this.step === 1 && this.phase === 0;
    // Output frames whose position falls within this quantum: positions run
    // phase, phase + step, ... and the last usable one is frames - 1.
    const produced = exact
      ? frames
      : Math.max(0, Math.floor((frames - 1 - this.phase) / this.step) + 1);

    if (produced > free) {
      this.count(control, EVENTS, 1);
      this.count(control, LOST_FRAMES, produced - free);
    }
    const take = Math.min(produced, free);
    const writePosition = Atomics.load(control, WRITE_POS);

    if (exact) {
      for (let i = 0; i < take; ++i) {
        const base = ((writePosition + i) % capacity) * width;
        for (let channel = 0; channel < width; ++channel)
          ring[base + channel] = this.sources[channel][i];
      }
    } else {
      let position = this.phase;
      for (let i = 0; i < take; ++i) {
        // index -1 is the previous quantum's last frame; index + 1 is only
        // clamped where the fraction is zero and it is therefore unused.
        const index = Math.floor(position);
        const fraction = position - index;
        const base = ((writePosition + i) % capacity) * width;
        for (let channel = 0; channel < width; ++channel) {
          const samples = this.sources[channel];
          const before = index < 0 ? this.previous[channel] : samples[index];
          const after = samples[Math.min(index + 1, frames - 1)];
          ring[base + channel] = before + (after - before) * fraction;
        }
        position += this.step;
      }
    }
    if (!exact) {
      // Whether or not the frames were kept, the whole quantum has been
      // consumed: the phase advances by this quantum's worth either way, or a
      // dropped quantum would shift the pitch of everything after it.
      this.phase += produced * this.step - frames;
      for (let channel = 0; channel < width; ++channel)
        this.previous[channel] = this.sources[channel][frames - 1];
    }
    if (take) {
      Atomics.store(control, WRITE_POS, (writePosition + take) % capacity);
      Atomics.notify(control, WRITE_POS);
    }
    return true;
  }
}

registerProcessor('gr-audio-sink', AudioSinkProcessor);
registerProcessor('gr-audio-source', AudioSourceProcessor);
