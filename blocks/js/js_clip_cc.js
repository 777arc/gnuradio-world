// Complex Soft Clipper — limit a complex stream's magnitude, without turning
// its phase into garbage.
//
// Hard-limiting I and Q separately (which is what a pair of Clip blocks would
// do) rotates the constellation as it clips, because the two axes saturate at
// different input levels. Scaling the whole sample by |x| / threshold clips the
// magnitude and leaves the phase exactly where it was, which is what a real
// amplifier's compression looks like and what PAPR reduction wants.
//
// `knee` is how gently it happens: 0 is a hard limiter, 1 a smooth tanh-shaped
// compression that starts at half the threshold. Both are driven live, so a QT
// GUI Range can sweep either while the flowgraph runs.
gr.export({
  label: 'Complex Soft Clipper',
  doc: 'Limits the magnitude of a complex stream while preserving its phase.',
  inputs: ['complex'],
  outputs: ['complex'],
  params: { threshold: 1.0, knee: 0.0 },

  work(nout, input, output) {
    const x = input[0], y = output[0];
    const limit = this.threshold > 0 ? this.threshold : 1e-12;
    // Clamped rather than trusted: a Range can be dragged anywhere, and a knee
    // outside [0, 1] would make the soft curve non-monotonic.
    const knee = Math.min(1, Math.max(0, this.knee));
    // Where compression starts. A knee of 0 leaves nothing below the threshold
    // touched at all, which is the hard limiter.
    const start = limit * (1 - 0.5 * knee);

    for (let i = 0; i < nout * 2; i += 2) {
      const re = x[i], im = x[i + 1];
      const magnitude = Math.hypot(re, im);
      if (magnitude <= start || magnitude === 0) {
        y[i] = re; y[i + 1] = im;
        continue;
      }
      let scaled;
      if (start === limit) {
        scaled = limit;                       // hard limit
      } else {
        // tanh over the knee region, so the curve leaves `start` with unit slope
        // and approaches `limit` asymptotically instead of cornering.
        const over = (magnitude - start) / (limit - start);
        scaled = start + (limit - start) * Math.tanh(over);
      }
      const gain = scaled / magnitude;
      y[i] = re * gain; y[i + 1] = im * gain;
    }
    return nout;
  },
});
