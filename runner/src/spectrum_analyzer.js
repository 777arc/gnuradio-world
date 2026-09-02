// Browser-native display for wasm_spectrum_analyzer_sink. The block publishes
// normalized linear-power FFT bins through shared WASM memory; this file owns
// trace processing, measurements, controls, rendering, and numeric snapshots.
(() => {
  'use strict';

  const MIN_POWER = 1e-30;
  const GRID_DIVISIONS = 10;
  const THRESHOLD_SAMPLE_COUNT = 10_000;
  const NOISE_FLOOR_PERCENTILE = 20;
  const NOISE_FLOOR_ALPHA = 0.1;
  const THRESHOLD_MARGIN_DB = 6;
  const OCCUPIED_BANDWIDTH_PERCENT = 99;
  const AUTO_SCALE_HEADROOM_DIVISIONS = 1;
  const UI_FONT_SIZE_PX = 16;
  const UI_FONT = `${UI_FONT_SIZE_PX}px system-ui, sans-serif`;
  const UI_MONO_FONT = `${UI_FONT_SIZE_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const TRACE_COLOR = '#67f5aa';
  const SIGNAL_HUE_LOW_LENGTH = 110;
  const SIGNAL_HUE_HIGH_START = 190;
  const SIGNAL_HUE_SPAN = SIGNAL_HUE_LOW_LENGTH + (360 - SIGNAL_HUE_HIGH_START);
  const PEAK_DISPLAY_INTERVAL_MS = 1000;
  const TRACE_MODES = new Set(['clear_write', 'average', 'max_hold']);

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const db = power => 10 * Math.log10(Math.max(MIN_POWER, Number(power) || 0));
  const finite = (value, fallback = 0) => Number.isFinite(Number(value))
    ? Number(value) : fallback;

  function percentile(values, percent) {
    const sorted = Array.from(values || [], Number)
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const position = clamp(finite(percent) / 100, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] -
      sorted[lower]) * fraction;
  }

  // A raw periodogram's noise power is exponentially distributed. Its lower
  // quantiles are therefore below mean noise power by a known amount. Using a
  // corrected lower-tail quantile rejects occupied bins without mistaking an
  // isolated FFT null for the noise floor.
  function estimateNoiseFloor(values, percent = NOISE_FLOOR_PERCENTILE) {
    const quantile = percentile(values, percent);
    if (quantile == null) return null;
    const fraction = clamp(finite(percent) / 100, 0.001, 0.999);
    const quantileToMeanDb = 10 * Math.log10(-Math.log1p(-fraction));
    return quantile - quantileToMeanDb;
  }

  function smoothPower(values, radius, passes = 2) {
    if (!values?.length) return [];
    radius = Math.max(0, Math.floor(finite(radius)));
    passes = Math.max(1, Math.floor(finite(passes, 2)));
    let source = Float64Array.from(values, value => Math.max(0, finite(value)));
    if (!radius) return source;
    for (let pass = 0; pass < passes; pass++) {
      const result = new Float64Array(values.length);
      const prefix = new Float64Array(values.length + 1);
      for (let index = 0; index < source.length; index++)
        prefix[index + 1] = prefix[index] + source[index];
      for (let index = 0; index < source.length; index++) {
        const first = Math.max(0, index - radius);
        const last = Math.min(source.length, index + radius + 1);
        result[index] = (prefix[last] - prefix[first]) / (last - first);
      }
      source = result;
    }
    return source;
  }

  function engineering(value, unit = 'Hz', digits = 4) {
    const numeric = finite(value);
    const magnitude = Math.abs(numeric);
    const scales = [
      [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
      [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'],
    ];
    const [scale, prefix] = scales.find(([candidate]) => magnitude >= candidate) ||
      [1, ''];
    return `${(numeric / scale).toLocaleString(undefined, {
      maximumSignificantDigits: digits,
    })} ${prefix}${unit}`;
  }

  function totalPowerLevel(integratedPower, enbwBins = 1, offsetDb = 0) {
    const equivalentNoiseBandwidth = Math.max(MIN_POWER, finite(enbwBins, 1));
    return db(finite(integratedPower) / equivalentNoiseBandwidth) + finite(offsetDb);
  }

  function signalAnnotationLines(signal, levelUnit) {
    return [
      `S${signal.id}`,
      `Center ${engineering(signal.center, 'Hz', 6)}`,
      `${OCCUPIED_BANDWIDTH_PERCENT}% BW ${engineering(signal.width, 'Hz', 5)}`,
      `Power ${signal.totalPower.toFixed(2)} ${levelUnit}`,
      `Max ${signal.peakLevel.toFixed(2)} ${levelUnit}`,
    ];
  }

  // The trace is green (about 150°). Map the golden-angle sequence around a
  // deliberately omitted 110°–190° band so no detected signal can borrow the
  // plot's own color while identities remain stable between frames.
  function signalHue(id) {
    const mapped = (Math.max(1, finite(id, 1)) * 137.508 + 8) % SIGNAL_HUE_SPAN;
    return mapped < SIGNAL_HUE_LOW_LENGTH
      ? mapped : SIGNAL_HUE_HIGH_START + mapped - SIGNAL_HUE_LOW_LENGTH;
  }

  function placeSignalAnnotation(rect, width, height, anchorY, peakX, peakY,
    preferRight = true) {
    const inset = 1;
    const gap = 10;
    const minimumX = rect.left + inset;
    const maximumX = rect.right - width - inset;
    const minimumY = rect.top + inset;
    const maximumY = rect.bottom - height - inset;
    const y = clamp(anchorY, minimumY, maximumY);
    const right = { x: peakX + gap, y };
    const left = { x: peakX - gap - width, y };
    const sides = preferRight ? [right, left] : [left, right];
    for (const candidate of sides) {
      if (candidate.x >= minimumX && candidate.x <= maximumX) return candidate;
    }
    const x = clamp(peakX - width / 2, minimumX, maximumX);
    const below = { x, y: peakY + gap };
    if (below.y >= minimumY && below.y <= maximumY) return below;
    const above = { x, y: peakY - gap - height };
    if (above.y >= minimumY && above.y <= maximumY) return above;
    return { x, y };
  }

  function accumulateDisplayedPeak(peakFrequency, peakLevel, previous, now) {
    if (!previous || !Number.isFinite(previous.displayPeakLevel)) {
      return {
        displayPeakFrequency: peakFrequency,
        displayPeakLevel: peakLevel,
        pendingPeakFrequency: peakFrequency,
        pendingPeakLevel: -Infinity,
        peakWindowStartedAt: now,
      };
    }
    const pendingWins = !Number.isFinite(previous.pendingPeakLevel) ||
      peakLevel > previous.pendingPeakLevel;
    const pendingPeakFrequency = pendingWins
      ? peakFrequency : previous.pendingPeakFrequency;
    const pendingPeakLevel = pendingWins ? peakLevel : previous.pendingPeakLevel;
    if (now - previous.peakWindowStartedAt < PEAK_DISPLAY_INTERVAL_MS) {
      return {
        displayPeakFrequency: previous.displayPeakFrequency,
        displayPeakLevel: previous.displayPeakLevel,
        pendingPeakFrequency,
        pendingPeakLevel,
        peakWindowStartedAt: previous.peakWindowStartedAt,
      };
    }
    return {
      displayPeakFrequency: pendingPeakFrequency,
      displayPeakLevel: pendingPeakLevel,
      pendingPeakFrequency: peakFrequency,
      pendingPeakLevel: -Infinity,
      peakWindowStartedAt: now,
    };
  }

  function peakOf(values, indexToFrequency, offsetDb = 0) {
    if (!values?.length) return null;
    let index = 0;
    for (let i = 1; i < values.length; i++)
      if (values[i] > values[index]) index = i;

    let interpolated = index;
    let level = db(values[index]) + offsetDb;
    if (index > 0 && index + 1 < values.length) {
      const left = db(values[index - 1]);
      const center = db(values[index]);
      const right = db(values[index + 1]);
      const denominator = left - 2 * center + right;
      if (Number.isFinite(denominator) && Math.abs(denominator) > 1e-9) {
        const delta = clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
        interpolated += delta;
        level = center - 0.25 * (left - right) * delta + offsetDb;
      }
    }
    return {
      index,
      interpolatedIndex: interpolated,
      frequency: indexToFrequency(interpolated),
      level,
    };
  }

  function autoScaleBounds(values, highlightedPeak = -Infinity) {
    const levels = Array.from(values || [], Number)
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (!levels.length) return null;
    const peak = Math.max(levels[levels.length - 1],
      Number.isFinite(Number(highlightedPeak)) ? Number(highlightedPeak) : -Infinity);
    const floor = levels[Math.floor(levels.length * 0.15)] ?? peak - 80;
    const dataDivisions = GRID_DIVISIONS - AUTO_SCALE_HEADROOM_DIVISIONS;
    const dbPerDivision = Math.max(1,
      Math.ceil((peak - floor) / dataDivisions / 2) * 2);
    const referenceLevel = Math.ceil((peak +
      AUTO_SCALE_HEADROOM_DIVISIONS * dbPerDivision) / 5) * 5;
    return { referenceLevel, dbPerDivision, peak, floor };
  }

  function occupiedBandwidthRange(values, frequencies, first, last) {
    if (!values?.length || values.length !== frequencies?.length || values.length < 2)
      return null;
    first = clamp(Math.floor(finite(first)), 0, values.length - 1);
    last = clamp(Math.floor(finite(last)), first, values.length - 1);
    const binWidth = Math.abs(frequencies[1] - frequencies[0]);
    if (!(binWidth > 0)) return null;
    let total = 0;
    for (let index = first; index <= last; index++)
      total += Math.max(0, finite(values[index]));
    if (!(total > MIN_POWER)) return null;

    const tail = (100 - OCCUPIED_BANDWIDTH_PERCENT) / 200;
    const targets = [total * tail, total * (1 - tail)];
    const crossings = [frequencies[first] - binWidth / 2,
      frequencies[last] + binWidth / 2];
    let cumulative = 0;
    let targetIndex = 0;
    for (let index = first; index <= last && targetIndex < targets.length; index++) {
      const power = Math.max(0, finite(values[index]));
      const before = cumulative;
      cumulative += power;
      while (targetIndex < targets.length && cumulative >= targets[targetIndex]) {
        const fraction = power > 0
          ? clamp((targets[targetIndex] - before) / power, 0, 1) : 0;
        crossings[targetIndex] = frequencies[index] - binWidth / 2 + fraction * binWidth;
        targetIndex++;
      }
    }
    return {
      low: crossings[0], high: crossings[1],
      center: (crossings[0] + crossings[1]) / 2,
      width: Math.max(0, crossings[1] - crossings[0]), integratedPower: total,
    };
  }

  // Join a one-bin dropout so a windowed carrier with a narrow spectral notch
  // remains one measured signal. Every other above-threshold island is kept,
  // including a single-bin carrier.
  function detectSignals(values, frequencies, thresholdDb, offsetDb = 0,
    bridgeBins = 1, detectionValues = values) {
    if (!values?.length || values.length !== frequencies?.length ||
        values.length !== detectionValues?.length ||
        !Number.isFinite(Number(thresholdDb))) return [];
    const above = Array.from(detectionValues,
      value => db(value) + offsetDb >= thresholdDb);
    const ranges = [];
    for (let index = 0; index < above.length;) {
      while (index < above.length && !above[index]) index++;
      if (index >= above.length) break;
      const first = index;
      let last = index;
      let gap = 0;
      for (index++; index < above.length; index++) {
        if (above[index]) { last = index; gap = 0; }
        else if (++gap > bridgeBins) break;
      }
      ranges.push([first, last]);
    }

    return ranges.map(([first, last]) => {
      let peakIndex = first;
      for (let index = first + 1; index <= last; index++)
        if (values[index] > values[peakIndex]) peakIndex = index;
      let interpolatedIndex = peakIndex;
      let peakLevel = db(values[peakIndex]) + offsetDb;
      if (peakIndex > first && peakIndex < last) {
        const left = db(values[peakIndex - 1]);
        const center = db(values[peakIndex]);
        const right = db(values[peakIndex + 1]);
        const denominator = left - 2 * center + right;
        if (Number.isFinite(denominator) && Math.abs(denominator) > 1e-9) {
          const delta = clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
          interpolatedIndex += delta;
          peakLevel = center - 0.25 * (left - right) * delta + offsetDb;
        }
      }
      const binWidth = Math.abs(frequencies[1] - frequencies[0]);
      const bandwidth = occupiedBandwidthRange(values, frequencies, first, last);
      return {
        peakFrequency: frequencies[0] + interpolatedIndex * binWidth,
        peakLevel,
        ...bandwidth,
      };
    });
  }

  function button(label, action, title = label) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.dataset.action = action;
    element.dataset.tooltip = title;
    Object.assign(element.style, {
      border: '1px solid #31425c', borderRadius: '3px', color: '#c8d6e8',
      background: '#111b2b', padding: '3px 7px', font: `600 ${UI_FONT}`,
      minHeight: '26px', cursor: 'pointer', whiteSpace: 'nowrap',
    });
    return element;
  }

  function numberInput(labelText, value, step, width = '58px') {
    const label = document.createElement('label');
    label.textContent = `${labelText} `;
    Object.assign(label.style, { whiteSpace: 'nowrap', color: '#8ea2bd' });
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value == null ? '' : String(value);
    input.step = String(step);
    input.setAttribute('aria-label', labelText);
    Object.assign(input.style, {
      width, boxSizing: 'border-box', background: '#07101d', color: '#dce8f8',
      border: '1px solid #31425c', borderRadius: '3px', padding: '3px 4px',
      font: UI_MONO_FONT,
    });
    label.append(input);
    return { label, input };
  }

  function rangeInput(labelText, step, width = '120px') {
    const label = document.createElement('label');
    label.append(`${labelText} `);
    Object.assign(label.style, {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      whiteSpace: 'nowrap', color: '#8ea2bd',
    });
    const input = document.createElement('input');
    input.type = 'range';
    input.step = String(step);
    input.setAttribute('aria-label', labelText);
    Object.assign(input.style, {
      width, accentColor: '#f07f67', cursor: 'pointer', font: UI_FONT,
    });
    const readout = document.createElement('span');
    Object.assign(readout.style, {
      minWidth: '74px', color: '#dce8f8',
      font: UI_MONO_FONT,
    });
    label.append(input, readout);
    return { label, input, readout };
  }

  class SpectrumAnalyzerRenderer {
    constructor(id, options) {
      this.memory = options.memory;
      this.controlPointer = options.controlPointer >>> 0;
      this.framesPointer = options.framesPointer >>> 0;
      this.binCount = Math.max(2, options.binCount | 0);
      this.fftSize = Math.max(2, options.fftSize | 0);
      this.isFloat = !!options.isFloat;
      this.sampleRate = Math.max(1, finite(options.sampleRate, 1));
      this.centerFrequency = finite(options.centerFrequency);
      this.enbwBins = Math.max(1, finite(options.enbwBins, 1));
      this.average = clamp(finite(options.average, 0.2), 0.0001, 1);
      this.referenceLevel = finite(options.referenceLevel);
      this.dbPerDivision = Math.max(0.1, finite(options.dbPerDivision, 10));
      this.levelOffsetDb = finite(options.levelOffsetDb);
      this.levelUnit = String(options.levelUnit || 'dBFS');
      this.blockName = String(options.blockName || `spectrum_analyzer_${id}`);
      this.title = String(options.title || 'Spectrum Analyzer');
      this.traceMode = TRACE_MODES.has(options.traceMode)
        ? options.traceMode : 'average';
      this.lastSequence = 0;
      this.skippedFrames = 0;
      this.frameCopy = new Float32Array(this.binCount);
      this.trace = null;
      this.peak = null;
      this.thresholdDb = null;
      this.thresholdAutomatic = true;
      this.noiseFloorDb = null;
      this.thresholdSamples = [];
      this.detectedSignals = [];
      this.signalTracks = [];
      this.nextSignalId = 1;
      this.frozen = false;
      this.autoScalePending = true;
      this.viewFirstIndex = 0;
      this.viewLastIndex = this.binCount - 1;
      this.zoomStack = [];
      this.zoomSelection = null;
      this.destroyed = false;
      this.dirty = true;
      this.buildDom();
      this.installControls();
      this.animationFrame = requestAnimationFrame(() => this.frame());
    }

    buildDom() {
      this.root = document.createElement('section');
      this.root.className = 'gr-spectrum-analyzer';
      this.root.dataset.blockName = this.blockName;
      this.root.dataset.blockId = 'wasm_spectrum_analyzer_sink';
      this.root.setAttribute('aria-label', `${this.title} spectrum analyzer`);
      Object.assign(this.root.style, {
        position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
        zIndex: '10000', display: 'none', flexDirection: 'column', overflow: 'hidden',
        boxSizing: 'border-box', border: '1px solid #24344c', borderRadius: '2px',
        background: '#050914', color: '#c8d6e8', font: UI_FONT,
        pointerEvents: 'auto', userSelect: 'none',
      });

      this.toolbar = document.createElement('div');
      Object.assign(this.toolbar.style, {
        display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap',
        minHeight: '34px', padding: '4px 6px', boxSizing: 'border-box',
        background: '#0b1422', borderBottom: '1px solid #24344c',
      });
      this.holdButton = button('Hold', 'hold', 'Freeze or resume the display');
      this.autoButton = button('Auto', 'auto', 'Autoscale the level axis once');
      const threshold = rangeInput('Threshold', 1);
      this.thresholdInput = threshold.input;
      this.thresholdReadout = threshold.readout;
      this.thresholdInput.dataset.tooltip =
        'Detection threshold in the displayed level unit; use Relearn for automatic estimation';
      this.relearnButton = button('Relearn', 'relearn',
        'Restart adaptive noise-floor estimation with the next 10,000 spectrum bins');
      this.clearButton = button('Clear', 'clear', 'Clear averaging, max hold, and measurements');

      this.modeSelect = document.createElement('select');
      this.modeSelect.setAttribute('aria-label', 'Trace mode');
      for (const [value, label] of [
        ['clear_write', 'Clear / Write'], ['average', 'Average'], ['max_hold', 'Max Hold'],
      ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        this.modeSelect.append(option);
      }
      this.modeSelect.value = this.traceMode;
      Object.assign(this.modeSelect.style, {
        color: '#c8d6e8', background: '#111b2b', border: '1px solid #31425c',
        borderRadius: '3px', minHeight: '26px', font: `600 ${UI_FONT}`,
      });
      const reference = numberInput('Ref', this.referenceLevel, 5);
      this.referenceInput = reference.input;
      const division = numberInput('dB/div', this.dbPerDivision, 1, '46px');
      this.divisionInput = division.input;
      this.toolbar.append(this.holdButton, this.autoButton, this.modeSelect,
        reference.label, division.label, threshold.label, this.relearnButton,
        this.clearButton);

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'gr-spectrum-analyzer-plot';
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('aria-label',
        'Spectrum plot. Drag a box to zoom in; right-click to zoom out one level.');
      Object.assign(this.canvas.style, {
        display: 'block', flex: '1 1 auto', width: '100%', minHeight: '100px',
        cursor: 'zoom-in', outline: 'none', background: '#050914',
      });
      this.context = this.canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('Canvas 2D is unavailable');

      this.status = document.createElement('div');
      Object.assign(this.status.style, {
        minHeight: '24px', padding: '4px 8px', boxSizing: 'border-box',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: '#9fb4cf', background: '#07101d', borderTop: '1px solid #24344c',
        font: UI_MONO_FONT,
      });
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'gr-spectrum-tooltip';
      this.tooltip.hidden = true;
      Object.assign(this.tooltip.style, {
        position: 'fixed', zIndex: '10001', maxWidth: '320px', padding: '7px 10px',
        border: '1px solid #465a76', borderRadius: '5px', pointerEvents: 'none',
        color: '#e4edf9', background: '#111a28', boxShadow: '0 6px 18px rgba(0,0,0,.45)',
        font: UI_FONT, lineHeight: '1.35', whiteSpace: 'normal',
      });
      this.root.append(this.toolbar, this.canvas, this.status);
      document.body.append(this.root);
      document.body.append(this.tooltip);
      this.updateButtonStates();
      this.updateThresholdControl();
    }

    installControls() {
      this.toolbar.addEventListener('click', event => {
        const action = event.target?.closest?.('button')?.dataset?.action;
        if (!action) return;
        if (action === 'hold') this.frozen = !this.frozen;
        else if (action === 'auto') this.autoScalePending = true;
        else if (action === 'relearn') {
          this.resetThresholdLearning();
        } else if (action === 'clear') this.clear();
        this.dirty = true;
        this.updateButtonStates();
      });
      this.modeSelect.addEventListener('change', () => {
        this.traceMode = TRACE_MODES.has(this.modeSelect.value)
          ? this.modeSelect.value : 'average';
        this.trace = null;
        this.dirty = true;
      });
      this.referenceInput.addEventListener('change', () =>
        this.setReferenceLevel(finite(this.referenceInput.value, this.referenceLevel)));
      this.divisionInput.addEventListener('change', () =>
        this.setDbPerDivision(finite(this.divisionInput.value, this.dbPerDivision)));
      this.thresholdInput.addEventListener('input', () => {
        const value = Number(this.thresholdInput.value);
        if (!Number.isFinite(value)) return;
        this.thresholdDb = value;
        this.thresholdAutomatic = false;
        this.thresholdSamples = [];
        this.updateDetections();
        this.updateThresholdControl();
        this.dirty = true;
      });

      const showTooltip = (target, clientX, clientY) => {
        const text = target?.dataset?.tooltip;
        if (!text) return;
        this.tooltip.textContent = text;
        this.tooltip.hidden = false;
        const bounds = this.tooltip.getBoundingClientRect();
        this.tooltip.style.left = `${clamp(clientX + 12, 4,
          Math.max(4, window.innerWidth - bounds.width - 4))}px`;
        this.tooltip.style.top = `${clamp(clientY + 14, 4,
          Math.max(4, window.innerHeight - bounds.height - 4))}px`;
      };
      this.root.addEventListener('pointermove', event => {
        const target = event.target?.closest?.('[data-tooltip]');
        if (target) showTooltip(target, event.clientX, event.clientY);
        else this.tooltip.hidden = true;
      });
      this.root.addEventListener('pointerleave', () => { this.tooltip.hidden = true; });
      this.root.addEventListener('focusin', event => {
        const target = event.target?.closest?.('[data-tooltip]');
        if (!target) return;
        const bounds = target.getBoundingClientRect();
        showTooltip(target, bounds.left, bounds.bottom);
      });
      this.root.addEventListener('focusout', () => { this.tooltip.hidden = true; });

      const pointerPosition = event => {
        const rect = this.plotRect();
        return {
          x: clamp(event.offsetX, rect.left, rect.right),
          y: clamp(event.offsetY, rect.top, rect.bottom),
        };
      };
      this.canvas.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        const point = pointerPosition(event);
        this.zoomSelection = { pointerId: event.pointerId,
          startX: point.x, startY: point.y, x: point.x, y: point.y };
        this.canvas.setPointerCapture?.(event.pointerId);
        this.dirty = true;
        event.preventDefault();
      });
      this.canvas.addEventListener('pointermove', event => {
        if (!this.zoomSelection || this.zoomSelection.pointerId !== event.pointerId) return;
        Object.assign(this.zoomSelection, pointerPosition(event));
        this.dirty = true;
      });
      const release = event => {
        if (!this.zoomSelection || this.zoomSelection.pointerId !== event.pointerId) return;
        Object.assign(this.zoomSelection, pointerPosition(event));
        this.applyZoomSelection();
        this.canvas.releasePointerCapture?.(event.pointerId);
      };
      this.canvas.addEventListener('pointerup', release);
      this.canvas.addEventListener('pointercancel', event => {
        if (!this.zoomSelection || this.zoomSelection.pointerId !== event.pointerId) return;
        this.zoomSelection = null;
        this.dirty = true;
      });
      this.canvas.addEventListener('contextmenu', event => {
        this.dirty = true;
        this.zoomOut();
        event.preventDefault();
      });
    }

    updateButtonStates() {
      const state = (element, active) => {
        element.setAttribute('aria-pressed', active ? 'true' : 'false');
        element.style.background = active ? '#173f4b' : '#111b2b';
        element.style.borderColor = active ? '#59d9cd' : '#31425c';
        element.style.color = active ? '#d9fffb' : '#c8d6e8';
      };
      state(this.holdButton, this.frozen);
      this.holdButton.textContent = this.frozen ? 'Run' : 'Hold';
    }

    updateThresholdControl() {
      const axisMinimum = this.referenceLevel - GRID_DIVISIONS * this.dbPerDivision;
      const threshold = this.thresholdDb;
      const minimum = Math.floor(Math.min(axisMinimum, threshold ?? axisMinimum));
      const maximum = Math.ceil(Math.max(this.referenceLevel, threshold ?? this.referenceLevel));
      this.thresholdInput.min = String(minimum);
      this.thresholdInput.max = String(Math.max(minimum + 1, maximum));
      if (threshold == null) {
        this.thresholdInput.disabled = true;
        this.thresholdInput.value = String((minimum + maximum) / 2);
        this.thresholdInput.setAttribute('aria-valuetext', 'learning');
        this.thresholdReadout.textContent = 'learning';
        return;
      }
      this.thresholdInput.disabled = false;
      this.thresholdInput.value = String(threshold);
      const text = `${threshold.toFixed(1)} ${this.levelUnit}`;
      this.thresholdInput.setAttribute('aria-valuetext', text);
      this.thresholdReadout.textContent = text;
    }

    clear() {
      this.trace = null;
      this.peak = null;
      this.detectedSignals = [];
      this.signalTracks = [];
      this.updateButtonStates();
    }

    applyZoomSelection() {
      const selection = this.zoomSelection;
      this.zoomSelection = null;
      if (!selection) return;
      const rect = this.plotRect();
      const left = Math.min(selection.startX, selection.x);
      const right = Math.max(selection.startX, selection.x);
      const top = Math.min(selection.startY, selection.y);
      const bottom = Math.max(selection.startY, selection.y);
      if (right - left < 8 || bottom - top < 8) {
        this.dirty = true;
        return;
      }
      this.zoomStack.push({
        first: this.viewFirstIndex, last: this.viewLastIndex,
        referenceLevel: this.referenceLevel, dbPerDivision: this.dbPerDivision,
      });
      const oldFirst = this.viewFirstIndex;
      const oldLast = this.viewLastIndex;
      const indexAtX = x => oldFirst + (oldLast - oldFirst) *
        (x - rect.left) / Math.max(1, rect.right - rect.left);
      let nextFirst = clamp(indexAtX(left), 0, this.binCount - 1);
      let nextLast = clamp(indexAtX(right), nextFirst, this.binCount - 1);
      const minimumSpan = Math.min(2, this.binCount - 1);
      if (nextLast - nextFirst < minimumSpan) {
        const center = (nextFirst + nextLast) / 2;
        nextFirst = clamp(center - minimumSpan / 2, 0,
          this.binCount - 1 - minimumSpan);
        nextLast = nextFirst + minimumSpan;
      }
      this.viewFirstIndex = nextFirst;
      this.viewLastIndex = nextLast;
      const oldReference = this.referenceLevel;
      const oldRange = GRID_DIVISIONS * this.dbPerDivision;
      const levelAtY = y => oldReference - oldRange *
        (y - rect.top) / Math.max(1, rect.bottom - rect.top);
      this.referenceLevel = levelAtY(top);
      this.dbPerDivision = Math.max(0.1,
        (this.referenceLevel - levelAtY(bottom)) / GRID_DIVISIONS);
      this.referenceInput.value = String(Number(this.referenceLevel.toFixed(3)));
      this.divisionInput.value = String(Number(this.dbPerDivision.toFixed(3)));
      this.dirty = true;
    }

    zoomOut() {
      const previous = this.zoomStack.pop();
      if (!previous) return;
      this.viewFirstIndex = previous.first;
      this.viewLastIndex = previous.last;
      this.referenceLevel = previous.referenceLevel;
      this.dbPerDivision = previous.dbPerDivision;
      this.referenceInput.value = String(this.referenceLevel);
      this.divisionInput.value = String(this.dbPerDivision);
      this.dirty = true;
    }

    frequencyAt(index) {
      if (this.isFloat)
        return this.centerFrequency + index * this.sampleRate / this.fftSize;
      return this.centerFrequency + (index / this.fftSize - 0.5) * this.sampleRate;
    }

    frequencies() {
      return Array.from({ length: this.binCount }, (_, index) => this.frequencyAt(index));
    }

    copyNewestFrame() {
      const buffer = this.memory?.buffer;
      if (!buffer) return false;
      const control = new Int32Array(buffer, this.controlPointer, 1);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = Atomics.load(control, 0) >>> 0;
        if (!before || before === this.lastSequence) return false;
        const offset = this.framesPointer + (before & 1) * this.binCount * 4;
        this.frameCopy.set(new Float32Array(buffer, offset, this.binCount));
        const after = Atomics.load(control, 0) >>> 0;
        if (before === after) {
          if (this.lastSequence) {
            const advanced = (before - this.lastSequence) >>> 0;
            if (advanced > 1) this.skippedFrames += advanced - 1;
          }
          this.lastSequence = before;
          return true;
        }
      }
      return false;
    }

    processFrame() {
      if (!this.trace || this.trace.length !== this.binCount) {
        this.trace = Float64Array.from(this.frameCopy, value => Math.max(MIN_POWER, value));
      } else if (this.traceMode === 'clear_write') {
        for (let i = 0; i < this.binCount; i++)
          this.trace[i] = Math.max(MIN_POWER, this.frameCopy[i]);
      } else if (this.traceMode === 'max_hold') {
        for (let i = 0; i < this.binCount; i++)
          this.trace[i] = Math.max(this.trace[i], this.frameCopy[i], MIN_POWER);
      } else {
        const alpha = this.average;
        for (let i = 0; i < this.binCount; i++)
          this.trace[i] = (1 - alpha) * this.trace[i] +
            alpha * Math.max(MIN_POWER, this.frameCopy[i]);
      }
      this.peak = peakOf(this.trace, index => this.frequencyAt(index), this.levelOffsetDb);
      this.learnThreshold(this.frameCopy);
      this.updateDetections();
      if (this.autoScalePending && this.peak) {
        const first = Math.max(0, Math.floor(this.viewFirstIndex));
        const last = Math.min(this.binCount - 1, Math.ceil(this.viewLastIndex));
        const visibleTrace = this.trace.slice(first, last + 1);
        const visiblePeak = peakOf(visibleTrace,
          index => this.frequencyAt(first + index), this.levelOffsetDb) || this.peak;
        const levels = Array.from(visibleTrace,
          value => db(value) + this.levelOffsetDb);
        const firstFrequency = this.frequencyAt(this.viewFirstIndex);
        const lastFrequency = this.frequencyAt(this.viewLastIndex);
        const annotatedPeak = this.detectedSignals
          .filter(signal => signal.center >= firstFrequency && signal.center <= lastFrequency)
          .reduce((maximum, signal) => Math.max(maximum, signal.peakLevel),
            visiblePeak.level);
        const bounds = autoScaleBounds(levels, annotatedPeak);
        this.referenceLevel = bounds.referenceLevel;
        this.dbPerDivision = bounds.dbPerDivision;
        this.referenceInput.value = String(this.referenceLevel);
        this.divisionInput.value = String(this.dbPerDivision);
        this.autoScalePending = false;
      }
    }

    learnThreshold(values) {
      if (!this.thresholdAutomatic) return;
      const needed = THRESHOLD_SAMPLE_COUNT - this.thresholdSamples.length;
      for (let index = 0; index < Math.min(needed, values?.length || 0); index++)
        this.thresholdSamples.push(db(values[index]));
      if (this.thresholdSamples.length < THRESHOLD_SAMPLE_COUNT) return;
      const estimate = estimateNoiseFloor(this.thresholdSamples);
      this.noiseFloorDb = this.noiseFloorDb == null ? estimate :
        (1 - NOISE_FLOOR_ALPHA) * this.noiseFloorDb + NOISE_FLOOR_ALPHA * estimate;
      this.thresholdDb = this.noiseFloorDb + THRESHOLD_MARGIN_DB + this.levelOffsetDb;
      this.thresholdSamples = [];
      this.updateThresholdControl();
    }

    resetThresholdLearning() {
      this.thresholdDb = null;
      this.thresholdAutomatic = true;
      this.noiseFloorDb = null;
      this.thresholdSamples = [];
      this.detectedSignals = [];
      this.signalTracks = [];
      this.updateThresholdControl();
      this.dirty = true;
    }

    updateDetections() {
      if (this.thresholdDb == null || !this.frameCopy?.length) {
        this.detectedSignals = [];
        return;
      }
      // Average only the decision envelope, never the values used for peak and
      // occupied-bandwidth measurement. This suppresses isolated noise-bin
      // crossings and joins the natural periodogram notches inside QPSK/OFDM.
      const smoothingRadius = Math.max(3, Math.round(this.binCount / 512));
      const envelope = smoothPower(this.frameCopy, smoothingRadius, 2);
      const detections = detectSignals(this.frameCopy, this.frequencies(),
        this.thresholdDb, this.levelOffsetDb, smoothingRadius * 2, envelope);
      const now = performance.now();
      const binWidth = this.binCount > 1
        ? Math.abs(this.frequencyAt(1) - this.frequencyAt(0)) : 0;
      const candidates = [];
      for (let oldIndex = 0; oldIndex < this.signalTracks.length; oldIndex++) {
        const old = this.signalTracks[oldIndex];
        for (let newIndex = 0; newIndex < detections.length; newIndex++) {
          const signal = detections[newIndex];
          const distance = Math.abs(old.center - signal.center);
          const tolerance = Math.max(3 * binWidth, (old.width + signal.width) / 2);
          if (distance <= tolerance) candidates.push({ oldIndex, newIndex, distance });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      const usedOld = new Set();
      const usedNew = new Set();
      for (const candidate of candidates) {
        if (usedOld.has(candidate.oldIndex) || usedNew.has(candidate.newIndex)) continue;
        const old = this.signalTracks[candidate.oldIndex];
        Object.assign(detections[candidate.newIndex], { id: old.id, hue: old.hue,
          peakDisplayState: old });
        usedOld.add(candidate.oldIndex);
        usedNew.add(candidate.newIndex);
      }
      for (const signal of detections) {
        if (!signal.id) {
          signal.id = this.nextSignalId++;
          signal.hue = signalHue(signal.id);
        }
        const instantaneousPeakFrequency = signal.peakFrequency;
        const instantaneousPeakLevel = signal.peakLevel;
        const peakState = accumulateDisplayedPeak(instantaneousPeakFrequency,
          instantaneousPeakLevel, signal.peakDisplayState, now);
        Object.assign(signal, peakState, {
          instantaneousPeakFrequency, instantaneousPeakLevel,
          peakFrequency: peakState.displayPeakFrequency,
          peakLevel: peakState.displayPeakLevel,
          totalPower: totalPowerLevel(
            signal.integratedPower, this.enbwBins, this.levelOffsetDb),
        });
        delete signal.peakDisplayState;
        signal.color = `hsl(${signal.hue.toFixed(1)} 82% 64%)`;
        signal.fillColor = `hsl(${signal.hue.toFixed(1)} 82% 58% / 0.14)`;
      }
      this.detectedSignals = detections;
      this.signalTracks = detections.map(({ id, hue, center, width,
        displayPeakFrequency, displayPeakLevel, pendingPeakFrequency,
        pendingPeakLevel, peakWindowStartedAt }) => ({
        id, hue, center, width, displayPeakFrequency, displayPeakLevel,
        pendingPeakFrequency, pendingPeakLevel, peakWindowStartedAt,
      }));
    }

    plotRect() {
      const width = Math.max(1, this.canvas.clientWidth);
      const height = Math.max(1, this.canvas.clientHeight);
      return { left: 62, right: Math.max(63, width - 14), top: 16,
        bottom: Math.max(17, height - 34) };
    }

    draw() {
      const cssWidth = Math.max(1, this.canvas.clientWidth);
      const cssHeight = Math.max(1, this.canvas.clientHeight);
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
      const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }
      const context = this.context;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = '#050914';
      context.fillRect(0, 0, cssWidth, cssHeight);
      const rect = this.plotRect();
      const plotWidth = rect.right - rect.left;
      const plotHeight = rect.bottom - rect.top;
      const yBottom = this.referenceLevel - GRID_DIVISIONS * this.dbPerDivision;

      context.fillStyle = '#07101d';
      context.fillRect(rect.left, rect.top, plotWidth, plotHeight);
      context.lineWidth = 1;
      context.strokeStyle = '#24344c';
      context.fillStyle = '#8ea2bd';
      context.font = UI_MONO_FONT;
      context.textBaseline = 'middle';
      for (let division = 0; division <= GRID_DIVISIONS; division++) {
        const x = rect.left + plotWidth * division / GRID_DIVISIONS;
        const y = rect.top + plotHeight * division / GRID_DIVISIONS;
        context.beginPath(); context.moveTo(x, rect.top); context.lineTo(x, rect.bottom); context.stroke();
        context.beginPath(); context.moveTo(rect.left, y); context.lineTo(rect.right, y); context.stroke();
        if (division < GRID_DIVISIONS) {
          const level = this.referenceLevel - division * this.dbPerDivision;
          context.textAlign = 'right';
          context.fillText(level.toFixed(Math.abs(level) < 100 ? 0 : 0), rect.left - 6, y);
        }
        if (division % 2 === 0) {
          const frequency = this.frequencyAt(this.viewFirstIndex +
            (this.viewLastIndex - this.viewFirstIndex) * division / GRID_DIVISIONS);
          context.textAlign = division === 0 ? 'left' : division === GRID_DIVISIONS ? 'right' : 'center';
          context.textBaseline = 'top';
          context.fillText(engineering(frequency, 'Hz', 4), x, rect.bottom + 6);
          context.textBaseline = 'middle';
        }
      }
      context.save();
      context.translate(12, rect.top + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.textAlign = 'center';
      context.fillStyle = '#8ea2bd';
      context.fillText(this.levelUnit, 0, 0);
      context.restore();

      const xForIndex = index => rect.left + plotWidth *
        (index - this.viewFirstIndex) /
        Math.max(1e-9, this.viewLastIndex - this.viewFirstIndex);
      const firstFrequency = this.frequencyAt(this.viewFirstIndex);
      const lastFrequency = this.frequencyAt(this.viewLastIndex);
      const xForFrequency = frequency => rect.left + plotWidth *
        (frequency - firstFrequency) / Math.max(1e-30, lastFrequency - firstFrequency);
      const yForLevel = level => rect.top +
        clamp((this.referenceLevel - level) /
          (GRID_DIVISIONS * this.dbPerDivision), 0, 1) * plotHeight;

      for (const signal of this.detectedSignals) {
        if (signal.high < firstFrequency || signal.low > lastFrequency) continue;
        const lowX = clamp(xForFrequency(signal.low), rect.left, rect.right);
        const highX = clamp(xForFrequency(signal.high), rect.left, rect.right);
        context.fillStyle = signal.fillColor;
        context.fillRect(lowX, rect.top, Math.max(1, highX - lowX), plotHeight);
        context.strokeStyle = signal.color;
        context.lineWidth = 1.15;
        context.setLineDash([5, 4]);
        for (const x of [lowX, highX]) {
          context.beginPath(); context.moveTo(x, rect.top); context.lineTo(x, rect.bottom); context.stroke();
        }
        context.setLineDash([]);
        if (signal.center >= firstFrequency && signal.center <= lastFrequency) {
          const centerX = xForFrequency(signal.center);
          context.lineWidth = 1.5;
          context.beginPath(); context.moveTo(centerX, rect.top);
          context.lineTo(centerX, rect.bottom); context.stroke();
        }
      }

      if (this.trace) {
        context.strokeStyle = TRACE_COLOR;
        context.lineWidth = 1.35;
        context.beginPath();
        const first = Math.max(0, Math.floor(this.viewFirstIndex));
        const last = Math.min(this.binCount - 1, Math.ceil(this.viewLastIndex));
        for (let index = first; index <= last; index++) {
          const x = xForIndex(index);
          const y = yForLevel(db(this.trace[index]) + this.levelOffsetDb);
          if (index === first) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.stroke();
      }

      if (this.thresholdDb != null) {
        const thresholdY = yForLevel(this.thresholdDb);
        context.strokeStyle = '#f07f67';
        context.lineWidth = 1;
        context.setLineDash([2, 3]);
        context.beginPath(); context.moveTo(rect.left, thresholdY);
        context.lineTo(rect.right, thresholdY); context.stroke();
        context.setLineDash([]);
        const source = this.thresholdAutomatic ? 'AUTO' : 'MANUAL';
        const thresholdLabel = `${source} THR ${this.thresholdDb.toFixed(1)} ${this.levelUnit}`;
        context.font = `600 ${UI_MONO_FONT}`;
        context.textAlign = 'right'; context.textBaseline = 'bottom';
        context.fillStyle = '#ffad9c';
        context.fillText(thresholdLabel, rect.right - 3,
          Math.max(rect.top + UI_FONT_SIZE_PX, thresholdY - 2));
      }

      const drawLabel = (lines, anchorY, peakX, peakY, color, preferRight) => {
        context.font = UI_MONO_FONT;
        const lineHeight = UI_FONT_SIZE_PX + 3;
        const width = Math.max(...lines.map(line => context.measureText(line).width)) + 8;
        const height = lines.length * lineHeight + 7;
        const { x, y } = placeSignalAnnotation(rect, width, height, anchorY,
          peakX, peakY, preferRight);
        context.fillStyle = 'rgba(8, 13, 24, 0.88)';
        context.fillRect(x, y, width, height);
        context.strokeStyle = color; context.lineWidth = 1; context.strokeRect(x, y, width, height);
        context.fillStyle = color; context.textBaseline = 'top';
        lines.forEach((line, index) => {
          context.textAlign = index === 0 ? 'center' : 'left';
          context.fillText(line, index === 0 ? x + width / 2 : x + 4,
            y + 3 + index * lineHeight);
        });
      };
      const visibleSignals = this.detectedSignals.filter(signal =>
        signal.center >= firstFrequency && signal.center <= lastFrequency);
      for (let index = 0; index < visibleSignals.length; index++) {
        const signal = visibleSignals[index];
        const peakX = xForFrequency(signal.peakFrequency);
        const peakY = yForLevel(signal.peakLevel);
        context.fillStyle = signal.color;
        context.beginPath(); context.arc(peakX, peakY, 3, 0, Math.PI * 2); context.fill();
        const lines = signalAnnotationLines(signal, this.levelUnit);
        drawLabel(lines,
          rect.top + UI_FONT_SIZE_PX + 10 +
          (index % 3) * (lines.length * (UI_FONT_SIZE_PX + 3) + 13),
          peakX, peakY, signal.color, index % 2 === 0);
      }

      if (this.zoomSelection) {
        const left = Math.min(this.zoomSelection.startX, this.zoomSelection.x);
        const right = Math.max(this.zoomSelection.startX, this.zoomSelection.x);
        const top = Math.min(this.zoomSelection.startY, this.zoomSelection.y);
        const bottom = Math.max(this.zoomSelection.startY, this.zoomSelection.y);
        context.fillStyle = 'rgba(89, 217, 205, 0.13)';
        context.fillRect(left, top, right - left, bottom - top);
        context.strokeStyle = '#59d9cd';
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        context.strokeRect(left + 0.5, top + 0.5,
          Math.max(0, right - left - 1), Math.max(0, bottom - top - 1));
        context.setLineDash([]);
      }

      context.fillStyle = '#dce8f8';
      context.font = `600 ${UI_FONT}`;
      context.textAlign = 'left'; context.textBaseline = 'top';
      context.fillText(this.title, rect.left + 5, rect.top + 4);
      this.updateThresholdControl();
      this.updateStatus();
    }

    updateStatus() {
      const firstFrequency = this.frequencyAt(this.viewFirstIndex);
      // A complex FFT's upper endpoint is exclusive: its last bin center is one
      // bin below the configured edge. Include that final bin's coverage in the
      // status readout. A real FFT includes its Nyquist endpoint already.
      const lastFrequency = this.frequencyAt(this.viewLastIndex) +
        (this.isFloat ? 0 : this.sampleRate / this.fftSize);
      const span = lastFrequency - firstFrequency;
      const rbw = this.sampleRate / this.fftSize * this.enbwBins;
      const parts = [
        `Center ${engineering((firstFrequency + lastFrequency) / 2, 'Hz')}`,
        `Span ${engineering(span, 'Hz')}`,
        `RBW ${engineering(rbw, 'Hz')}`,
      ];
      if (this.zoomStack.length) parts.push(`Zoom ${this.zoomStack.length}×`);
      if (this.thresholdDb == null && this.thresholdAutomatic)
        parts.push(`Threshold learning ${this.thresholdSamples.length}/${THRESHOLD_SAMPLE_COUNT}`);
      else if (this.thresholdDb != null)
        parts.push(`${this.detectedSignals.length} signal${this.detectedSignals.length === 1 ? '' : 's'} above ${
          this.thresholdDb.toFixed(2)} ${this.levelUnit}`);
      if (this.thresholdAutomatic && this.noiseFloorDb != null)
        parts.push(`Noise floor ${(this.noiseFloorDb + this.levelOffsetDb).toFixed(2)} ${this.levelUnit}`);
      if (this.frozen) parts.push('HELD');
      if (this.skippedFrames) parts.push(`${this.skippedFrames} skipped`);
      this.status.textContent = parts.join(' · ');
    }

    frame() {
      if (this.destroyed) return;
      this.animationFrame = requestAnimationFrame(() => this.frame());
      const hasFrame = !this.frozen && this.copyNewestFrame();
      if (hasFrame) {
        this.processFrame();
        this.dirty = true;
      }
      if (!this.dirty || this.root.style.display === 'none') return;
      this.draw();
      this.dirty = false;
    }

    layout(x, y, width, height, visible) {
      Object.assign(this.root.style, {
        left: `${x | 0}px`, top: `${y | 0}px`, width: `${Math.max(1, width | 0)}px`,
        height: `${Math.max(1, height | 0)}px`, display: visible ? 'flex' : 'none',
      });
      if (!visible) this.tooltip.hidden = true;
      this.dirty = true;
    }

    setSampleRate(value) {
      this.sampleRate = Math.max(1, finite(value, this.sampleRate));
      this.updateDetections(); this.dirty = true;
    }
    setCenterFrequency(value) {
      this.centerFrequency = finite(value);
      this.updateDetections(); this.dirty = true;
    }
    setAverage(value) { this.average = clamp(finite(value, this.average), 0.0001, 1); }
    setReferenceLevel(value) {
      this.referenceLevel = finite(value, this.referenceLevel);
      this.referenceInput.value = String(this.referenceLevel); this.dirty = true;
    }
    setDbPerDivision(value) {
      this.dbPerDivision = Math.max(0.1, finite(value, this.dbPerDivision));
      this.divisionInput.value = String(this.dbPerDivision); this.dirty = true;
    }
    setLevelOffsetDb(value) {
      const next = finite(value);
      if (this.thresholdAutomatic && this.thresholdDb != null)
        this.thresholdDb += next - this.levelOffsetDb;
      this.levelOffsetDb = next;
      this.updateThresholdControl();
      this.updateDetections(); this.dirty = true;
    }
    configureNumeric(sampleRate, centerFrequency, enbwBins, average,
      referenceLevel, dbPerDivision, levelOffsetDb) {
      this.sampleRate = Math.max(1, finite(sampleRate, this.sampleRate));
      this.centerFrequency = finite(centerFrequency, this.centerFrequency);
      this.enbwBins = Math.max(1, finite(enbwBins, this.enbwBins));
      this.average = clamp(finite(average, this.average), 0.0001, 1);
      this.referenceLevel = finite(referenceLevel, this.referenceLevel);
      this.dbPerDivision = Math.max(0.1, finite(dbPerDivision, this.dbPerDivision));
      this.levelOffsetDb = finite(levelOffsetDb, this.levelOffsetDb);
      this.referenceInput.value = String(this.referenceLevel);
      this.divisionInput.value = String(this.dbPerDivision);
      this.updateButtonStates();
      this.dirty = true;
    }

    configureText(blockName, title, traceMode, levelUnit) {
      this.blockName = String(blockName || this.blockName);
      this.title = String(title || this.title);
      this.levelUnit = String(levelUnit || this.levelUnit);
      this.traceMode = TRACE_MODES.has(traceMode) ? traceMode : this.traceMode;
      this.root.dataset.blockName = this.blockName;
      this.root.setAttribute('aria-label', `${this.title} spectrum analyzer`);
      this.modeSelect.value = this.traceMode;
      this.dirty = true;
    }

    plotData(maxPoints = 32) {
      const entry = { name: this.blockName, id: 'wasm_spectrum_analyzer_sink' };
      if (!this.trace) {
        entry.kind = 'curves';
        entry.note = 'the analyzer has not received a complete FFT frame yet';
        entry.curves = [];
        return entry;
      }
      const first = Math.max(0, Math.floor(this.viewFirstIndex));
      const last = Math.min(this.binCount - 1, Math.ceil(this.viewLastIndex));
      const levels = Array.from(this.trace.slice(first, last + 1),
        value => db(value) + this.levelOffsetDb);
      const frequencies = Array.from({ length: last - first + 1 },
        (_, index) => this.frequencyAt(first + index));
      const stride = Math.max(1,
        Math.ceil(levels.length / clamp(maxPoints | 0, 4, 256)));
      const samples = [];
      for (let index = 0; index < levels.length; index += stride)
        samples.push([frequencies[index], levels[index]]);
      const minimum = Math.min(...levels);
      const maximum = Math.max(...levels);
      const mean = levels.reduce((sum, value) => sum + value, 0) / levels.length;
      const visiblePeak = peakOf(this.trace.slice(first, last + 1),
        index => this.frequencyAt(first + index), this.levelOffsetDb);
      const curve = {
        label: this.title, points: levels.length,
        x: { min: this.frequencyAt(this.viewFirstIndex),
          max: this.frequencyAt(this.viewLastIndex) },
        y: { min: minimum, max: maximum, mean },
        peak: visiblePeak ? { x: visiblePeak.frequency, y: visiblePeak.level } : undefined,
        samples,
        ...(stride > 1 ? { sample_stride: stride } : {}),
      };
      entry.kind = 'curves';
      entry.x_axis = { title: 'Frequency (Hz)',
        min: this.frequencyAt(this.viewFirstIndex),
        max: this.frequencyAt(this.viewLastIndex) };
      entry.y_axis = { title: this.levelUnit,
        min: this.referenceLevel - GRID_DIVISIONS * this.dbPerDivision,
        max: this.referenceLevel };
      entry.zoom_depth = this.zoomStack.length;
      entry.curves = [curve];
      entry.rbw_hz = this.sampleRate / this.fftSize * this.enbwBins;
      entry.trace_mode = this.traceMode;
      entry.detection = {
        enabled: true,
        threshold: this.thresholdDb,
        threshold_unit: this.levelUnit,
        threshold_source: this.thresholdAutomatic ? 'automatic' : 'manual',
        noise_floor: this.noiseFloorDb == null
          ? null : this.noiseFloorDb + this.levelOffsetDb,
        estimator: 'corrected_lower_tail',
        estimator_percentile: NOISE_FLOOR_PERCENTILE,
        adaptation_alpha: NOISE_FLOOR_ALPHA,
        batch_samples: this.thresholdAutomatic ? this.thresholdSamples.length : undefined,
        required_samples: THRESHOLD_SAMPLE_COUNT,
        margin_db: THRESHOLD_MARGIN_DB,
      };
      entry.detected_signals = this.detectedSignals.map(signal => ({
        id: signal.id,
        center_frequency: signal.center,
        peak_frequency: signal.peakFrequency,
        peak_level: signal.peakLevel,
        total_power: signal.totalPower,
        power_unit: this.levelUnit,
        occupied_bandwidth_99: signal.width,
        low_frequency_99: signal.low,
        high_frequency_99: signal.high,
      }));
      return entry;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.animationFrame);
      this.root.remove();
      this.tooltip.remove();
    }
  }

  class SpectrumAnalyzerManager {
    constructor() { this.instances = new Map(); this.nextId = 1; }
    create(options) {
      const id = this.nextId++;
      try {
        this.instances.set(id, new SpectrumAnalyzerRenderer(id, options));
        return id;
      } catch (error) {
        console.error(`Spectrum Analyzer: ${error.message || error}`);
        return 0;
      }
    }
    layout(id, ...args) { this.instances.get(id)?.layout(...args); }
    setSampleRate(id, value) { this.instances.get(id)?.setSampleRate(value); }
    setCenterFrequency(id, value) { this.instances.get(id)?.setCenterFrequency(value); }
    setAverage(id, value) { this.instances.get(id)?.setAverage(value); }
    setReferenceLevel(id, value) { this.instances.get(id)?.setReferenceLevel(value); }
    setDbPerDivision(id, value) { this.instances.get(id)?.setDbPerDivision(value); }
    setLevelOffsetDb(id, value) { this.instances.get(id)?.setLevelOffsetDb(value); }
    configureNumeric(id, ...values) { this.instances.get(id)?.configureNumeric(...values); }
    configureText(id, ...values) { this.instances.get(id)?.configureText(...values); }
    readPlotData(only = '', maxPoints = 32) {
      const widgets = [];
      for (const instance of this.instances.values()) {
        if (!only || instance.blockName === only)
          widgets.push(instance.plotData(maxPoints));
      }
      return {
        widgets,
        ...(only && !widgets.length
          ? { error: `no GUI widget named "${only}" is running` } : {}),
      };
    }
    widgets() {
      return [...this.instances.values()].map(instance => ({
        name: instance.blockName,
        id: 'wasm_spectrum_analyzer_sink',
        rect: instance.root.getBoundingClientRect(),
      }));
    }
    captureLayers(only = '') {
      const layers = [];
      for (const instance of this.instances.values()) {
        if ((only && instance.blockName !== only) ||
            instance.root.style.display === 'none' ||
            !instance.canvas.width || !instance.canvas.height) continue;
        layers.push({
          source: instance.canvas,
          rect: instance.canvas.getBoundingClientRect(),
          widget: instance.blockName,
          z: 10,
        });
      }
      return layers;
    }
    // The runner publishes every placed widget's rectangle whenever the
    // arrangement changes (publish_gui_layout() in runner.cpp). Reading it here
    // is what lets each renderer sit exactly on its QWidget placeholder without
    // the sink polling its own geometry on a timer.
    applyLayoutReport(report) {
      const widgets = report && Array.isArray(report.widgets) ? report.widgets : null;
      if (!widgets) return;
      for (const instance of this.instances.values()) {
        const placed = widgets.find(w => w && w.name === instance.blockName);
        if (placed && placed.rect && placed.visible !== false) {
          const { x, y, width, height } = placed.rect;
          instance.layout(x, y, width, height, true);
        } else {
          // Not in this run's arrangement, or hidden: keep it off the page
          // rather than stranded wherever it last was.
          instance.layout(0, 0, 0, 0, false);
        }
      }
    }

    destroy(id) { this.instances.get(id)?.destroy(); this.instances.delete(id); }
  }

  globalThis.__grSpectrumAnalyzerInternals = {
    engineering, totalPowerLevel, signalAnnotationLines, signalHue, placeSignalAnnotation,
    accumulateDisplayedPeak, percentile, estimateNoiseFloor, smoothPower, peakOf,
    autoScaleBounds, occupiedBandwidthRange, detectSignals,
  };
  const manager = new SpectrumAnalyzerManager();
  globalThis.__grSpectrumAnalyzer = manager;
  (globalThis.__grGuiLayoutListeners ||= []).push(report => manager.applyLayoutReport(report));
  globalThis.__grGuiObservation?.register('spectrum-analyzer', {
    widgets: () => manager.widgets(),
    readPlotData: (only, maxPoints) => manager.readPlotData(only, maxPoints),
    captureLayers: only => manager.captureLayers(only),
  }, 10);
})();
