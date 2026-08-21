// Peak Hold — one output per `decimation` inputs, holding the largest of them.
//
// Decimating a float stream by dropping samples (Keep 1 in N) is exactly wrong
// for anything measuring level: the sample that mattered is the one most likely
// to be thrown away. A peak-hold decimator keeps the envelope instead, which is
// what a level meter, a burst detector's front end, or a long time-sink plot
// actually wants to see.
//
// `absolute` decides whether the peak is of the value or of its magnitude; a
// magnitude stream wants the first, a bipolar waveform the second.
//
// The decimation is a property of the block rather than a parameter, because GNU
// Radio sizes buffers from it at construction — changing it while running is not
// something a JS block can do, and pretending otherwise would be worse than
// saying so. A top-level const is safe here where per-instance state would not
// be: this file is evaluated once per thread, and a constant is the same in every
// one of them.
const DECIMATION = 8;

gr.export({
  label: 'Peak Hold (decimating)',
  doc: 'Holds the largest of every N input samples, one output per group.',
  inputs: ['float'],
  outputs: ['float'],
  decimation: DECIMATION,
  params: { absolute: 1 },

  work(nout, input, output) {
    const x = input[0], y = output[0];
    const n = DECIMATION;
    const absolute = this.absolute ? true : false;
    for (let i = 0; i < nout; i++) {
      const base = i * n;
      let peak = absolute ? Math.abs(x[base]) : x[base];
      for (let k = 1; k < n; k++) {
        const value = absolute ? Math.abs(x[base + k]) : x[base + k];
        if (value > peak) peak = value;
      }
      y[i] = peak;
    }
    return nout;
  },
});
