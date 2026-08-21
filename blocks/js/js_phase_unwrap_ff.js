// Phase Unwrap — turn a wrapped phase stream into a continuous one.
//
// Complex to Arg gives an angle in (-pi, pi], so a signal whose phase advances
// steadily comes out as a sawtooth. Anything that wants the *trend* — an
// instantaneous-frequency estimate, a phase-drift plot, a cycle-slip count —
// has to undo the wrapping first, and there is no GNU Radio block that does.
//
// The accumulated offset carries across work() calls, which is the whole point:
// a block that reset every call would produce a sawtooth again with a different
// tooth length. It lives on `this`, seeded in start(), because module-level
// state would be shared by every instance in the realm and re-created on every
// evaluation of this file.
gr.export({
  label: 'Phase Unwrap',
  doc: 'Removes the 2*pi discontinuities from a wrapped phase stream.',
  inputs: ['float'],
  outputs: ['float'],

  start() {
    this.offset = 0;      // accumulated multiple of 2*pi
    this.previous = 0;    // the last *wrapped* input, for the jump test
    this.started = false;
  },

  work(nout, input, output) {
    const x = input[0], y = output[0];
    const TWO_PI = 2 * Math.PI;
    let offset = this.offset, previous = this.previous;
    let i = 0;
    if (!this.started && nout > 0) {
      // The first sample defines the origin; there is nothing before it to have
      // jumped from.
      previous = x[0];
      y[0] = x[0];
      i = 1;
      this.started = true;
    }
    for (; i < nout; i++) {
      const value = x[i];
      const delta = value - previous;
      // A step of more than half a turn between adjacent samples is a wrap, not
      // a real excursion — the same rule numpy.unwrap uses.
      if (delta > Math.PI) offset -= TWO_PI;
      else if (delta < -Math.PI) offset += TWO_PI;
      previous = value;
      y[i] = value + offset;
    }
    this.offset = offset;
    this.previous = previous;
    return nout;
  },
});
