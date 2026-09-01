// Browser-native display for wasm_spectrum_analyzer_sink. The block publishes
// normalized linear-power FFT bins through shared WASM memory; this file owns
// trace processing, measurements, controls, rendering, and numeric snapshots.
(() => {
  'use strict';

  const MIN_POWER = 1e-30;
  const GRID_DIVISIONS = 10;
  const TRACE_MODES = new Set(['clear_write', 'average', 'max_hold']);

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const db = power => 10 * Math.log10(Math.max(MIN_POWER, Number(power) || 0));
  const finite = (value, fallback = 0) => Number.isFinite(Number(value))
    ? Number(value) : fallback;

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

  function occupiedBandwidth(values, frequencies, centerIndex, percent, spanHz) {
    if (!values?.length || values.length !== frequencies?.length) return null;
    const binWidth = values.length > 1
      ? Math.abs(frequencies[1] - frequencies[0]) : 0;
    if (!(binWidth > 0)) return null;
    const center = clamp(Math.round(finite(centerIndex)), 0, values.length - 1);
    let first = 0;
    let last = values.length - 1;
    if (spanHz > 0) {
      const radius = Math.max(1, Math.floor(spanHz / binWidth / 2));
      first = Math.max(0, center - radius);
      last = Math.min(values.length - 1, center + radius);
    }
    let total = 0;
    for (let i = first; i <= last; i++) total += Math.max(0, values[i]);
    if (!(total > MIN_POWER)) return null;

    const tail = clamp((100 - finite(percent, 99)) / 200, 0.000001, 0.499999);
    const lowTarget = total * tail;
    const highTarget = total * (1 - tail);
    let cumulative = 0;
    let low = frequencies[first] - binWidth / 2;
    let high = frequencies[last] + binWidth / 2;
    for (let i = first; i <= last; i++) {
      const power = Math.max(0, values[i]);
      const before = cumulative;
      cumulative += power;
      if (before < lowTarget && cumulative >= lowTarget && power > 0) {
        const fraction = clamp((lowTarget - before) / power, 0, 1);
        low = frequencies[i] - binWidth / 2 + fraction * binWidth;
      }
      if (before < highTarget && cumulative >= highTarget && power > 0) {
        const fraction = clamp((highTarget - before) / power, 0, 1);
        high = frequencies[i] - binWidth / 2 + fraction * binWidth;
        break;
      }
    }
    return {
      percent: finite(percent, 99),
      low,
      high,
      center: (low + high) / 2,
      width: Math.max(0, high - low),
      integratedPower: total,
      regionLow: frequencies[first] - binWidth / 2,
      regionHigh: frequencies[last] + binWidth / 2,
      touchesEdge: first === 0 || last === values.length - 1,
    };
  }

  function button(label, action, title = label) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.dataset.action = action;
    element.title = title;
    Object.assign(element.style, {
      border: '1px solid #31425c', borderRadius: '3px', color: '#c8d6e8',
      background: '#111b2b', padding: '3px 7px', font: '600 11px system-ui',
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
    input.value = String(value);
    input.step = String(step);
    input.setAttribute('aria-label', labelText);
    Object.assign(input.style, {
      width, boxSizing: 'border-box', background: '#07101d', color: '#dce8f8',
      border: '1px solid #31425c', borderRadius: '3px', padding: '3px 4px',
      font: '11px ui-monospace, monospace',
    });
    label.append(input);
    return { label, input };
  }

  class SpectrumAnalyzerRenderer {
    constructor(manager, id, options) {
      this.manager = manager;
      this.id = id;
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
      this.trackPeak = !!options.peakTrack;
      this.obwPercent = clamp(finite(options.obwPercent, 99), 0.001, 99.999);
      this.obwSpan = Math.max(0, finite(options.obwSpan));
      this.blockName = String(options.blockName || `spectrum_analyzer_${id}`);
      this.title = String(options.title || 'Spectrum Analyzer');
      this.traceMode = TRACE_MODES.has(options.traceMode)
        ? options.traceMode : 'average';
      this.lastSequence = 0;
      this.skippedFrames = 0;
      this.frameCopy = new Float32Array(this.binCount);
      this.trace = null;
      this.markerIndex = null;
      this.peak = null;
      this.obw = null;
      this.obwEnabled = false;
      this.frozen = false;
      this.autoScalePending = false;
      this.draggingMarker = false;
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
        background: '#050914', color: '#c8d6e8', font: '11px system-ui, sans-serif',
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
      this.peakButton = button('Peak Search', 'peak', 'Move marker to the strongest peak');
      this.trackButton = button('Track Peak', 'track', 'Continuously follow the strongest peak');
      this.markerButton = button('Marker', 'marker', 'Enable a manual marker; click the plot to place it');
      this.obwButton = button(`OBW ${this.obwPercent.toFixed(0)}%`, 'obw',
        'Measure occupied bandwidth around the marker or peak');
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
        borderRadius: '3px', minHeight: '26px', font: '600 11px system-ui',
      });
      const reference = numberInput('Ref', this.referenceLevel, 5);
      this.referenceInput = reference.input;
      const division = numberInput('dB/div', this.dbPerDivision, 1, '46px');
      this.divisionInput = division.input;
      this.toolbar.append(this.holdButton, this.autoButton, this.modeSelect,
        reference.label, division.label, this.peakButton, this.trackButton,
        this.markerButton, this.obwButton, this.clearButton);

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'gr-spectrum-analyzer-plot';
      this.canvas.tabIndex = 0;
      this.canvas.setAttribute('aria-label',
        'Spectrum plot. Click to place the marker; arrow keys move it one FFT bin.');
      Object.assign(this.canvas.style, {
        display: 'block', flex: '1 1 auto', width: '100%', minHeight: '100px',
        cursor: 'crosshair', outline: 'none', background: '#050914',
      });
      this.context = this.canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('Canvas 2D is unavailable');

      this.status = document.createElement('div');
      Object.assign(this.status.style, {
        minHeight: '24px', padding: '4px 8px', boxSizing: 'border-box',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: '#9fb4cf', background: '#07101d', borderTop: '1px solid #24344c',
        font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
      });
      this.root.append(this.toolbar, this.canvas, this.status);
      document.body.append(this.root);
      this.updateButtonStates();
    }

    installControls() {
      this.toolbar.addEventListener('click', event => {
        const action = event.target?.closest?.('button')?.dataset?.action;
        if (!action) return;
        if (action === 'hold') this.frozen = !this.frozen;
        else if (action === 'auto') this.autoScalePending = true;
        else if (action === 'peak') this.placeAtPeak();
        else if (action === 'track') {
          this.trackPeak = !this.trackPeak;
          if (this.trackPeak) this.placeAtPeak();
        } else if (action === 'marker') {
          if (this.markerIndex == null) this.markerIndex = Math.floor(this.binCount / 2);
          this.trackPeak = false;
        } else if (action === 'obw') {
          this.obwEnabled = !this.obwEnabled;
          if (this.markerIndex == null) this.placeAtPeak();
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

      const pointerToMarker = event => {
        const rect = this.plotRect();
        const x = clamp(event.offsetX, rect.left, rect.right);
        const fraction = (x - rect.left) / Math.max(1, rect.right - rect.left);
        this.markerIndex = clamp(Math.round(fraction * (this.binCount - 1)),
          0, this.binCount - 1);
        this.trackPeak = false;
        this.dirty = true;
        this.updateMeasurements();
        this.updateButtonStates();
      };
      this.canvas.addEventListener('pointerdown', event => {
        this.draggingMarker = true;
        this.canvas.setPointerCapture?.(event.pointerId);
        pointerToMarker(event);
      });
      this.canvas.addEventListener('pointermove', event => {
        if (this.draggingMarker) pointerToMarker(event);
      });
      const release = event => {
        this.draggingMarker = false;
        this.canvas.releasePointerCapture?.(event.pointerId);
      };
      this.canvas.addEventListener('pointerup', release);
      this.canvas.addEventListener('pointercancel', release);
      this.canvas.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (this.markerIndex == null) this.markerIndex = Math.floor(this.binCount / 2);
        this.markerIndex = clamp(this.markerIndex + (event.key === 'ArrowLeft' ? -1 : 1),
          0, this.binCount - 1);
        this.trackPeak = false;
        this.updateMeasurements();
        this.updateButtonStates();
        this.dirty = true;
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
      state(this.trackButton, this.trackPeak);
      state(this.markerButton, this.markerIndex != null && !this.trackPeak);
      state(this.obwButton, this.obwEnabled);
      this.holdButton.textContent = this.frozen ? 'Run' : 'Hold';
    }

    clear() {
      this.trace = null;
      this.markerIndex = null;
      this.peak = null;
      this.obw = null;
      this.trackPeak = false;
      this.obwEnabled = false;
      this.updateButtonStates();
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
      if (this.trackPeak && this.peak) this.markerIndex = this.peak.index;
      if (this.autoScalePending && this.peak) {
        const levels = Array.from(this.trace, value => db(value) + this.levelOffsetDb).sort((a, b) => a - b);
        const floor = levels[Math.floor(levels.length * 0.15)] ?? this.peak.level - 80;
        this.referenceLevel = Math.ceil((this.peak.level + 3) / 5) * 5;
        this.dbPerDivision = Math.max(1,
          Math.ceil((this.referenceLevel - floor) / GRID_DIVISIONS / 2) * 2);
        this.referenceInput.value = String(this.referenceLevel);
        this.divisionInput.value = String(this.dbPerDivision);
        this.autoScalePending = false;
      }
      this.updateMeasurements();
    }

    placeAtPeak() {
      if (!this.peak && this.trace)
        this.peak = peakOf(this.trace, index => this.frequencyAt(index), this.levelOffsetDb);
      if (this.peak) this.markerIndex = this.peak.index;
      this.updateMeasurements();
    }

    updateMeasurements() {
      if (!this.trace) return;
      if (this.markerIndex != null)
        this.markerIndex = clamp(Math.round(this.markerIndex), 0, this.binCount - 1);
      const center = this.markerIndex ?? this.peak?.index ?? Math.floor(this.binCount / 2);
      this.obw = this.obwEnabled
        ? occupiedBandwidth(this.trace, this.frequencies(), center,
          this.obwPercent, this.obwSpan)
        : null;
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
      context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
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
          const frequency = this.frequencyAt((this.binCount - 1) * division / GRID_DIVISIONS);
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

      const xForIndex = index => rect.left + plotWidth * index / Math.max(1, this.binCount - 1);
      const yForLevel = level => rect.top +
        clamp((this.referenceLevel - level) /
          (GRID_DIVISIONS * this.dbPerDivision), 0, 1) * plotHeight;

      if (this.obw) {
        const firstFrequency = this.frequencyAt(0);
        const lastFrequency = this.frequencyAt(this.binCount - 1);
        const xForFrequency = frequency => rect.left + plotWidth *
          (frequency - firstFrequency) / Math.max(1e-30, lastFrequency - firstFrequency);
        const lowX = clamp(xForFrequency(this.obw.low), rect.left, rect.right);
        const highX = clamp(xForFrequency(this.obw.high), rect.left, rect.right);
        context.fillStyle = 'rgba(246, 190, 65, 0.13)';
        context.fillRect(lowX, rect.top, Math.max(1, highX - lowX), plotHeight);
        context.strokeStyle = '#f6be41';
        context.setLineDash([4, 3]);
        for (const x of [lowX, highX]) {
          context.beginPath(); context.moveTo(x, rect.top); context.lineTo(x, rect.bottom); context.stroke();
        }
        context.setLineDash([]);
      }

      if (this.trace) {
        context.strokeStyle = '#67f5aa';
        context.lineWidth = 1.35;
        context.beginPath();
        for (let index = 0; index < this.binCount; index++) {
          const x = xForIndex(index);
          const y = yForLevel(db(this.trace[index]) + this.levelOffsetDb);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.stroke();
      }

      if (this.markerIndex != null && this.trace) {
        const index = clamp(this.markerIndex, 0, this.binCount - 1);
        const x = xForIndex(index);
        const level = db(this.trace[index]) + this.levelOffsetDb;
        const y = yForLevel(level);
        context.strokeStyle = '#ffcf4d';
        context.fillStyle = '#ffcf4d';
        context.lineWidth = 1;
        context.beginPath(); context.moveTo(x, rect.top); context.lineTo(x, rect.bottom); context.stroke();
        context.beginPath(); context.moveTo(x, y); context.lineTo(x - 6, y - 9);
        context.lineTo(x + 6, y - 9); context.closePath(); context.fill();
        const label = `M1 ${engineering(this.frequencyAt(index), 'Hz', 6)}  ${level.toFixed(2)} ${this.levelUnit}`;
        context.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const labelWidth = context.measureText(label).width + 10;
        const labelX = clamp(x + 8, rect.left, rect.right - labelWidth);
        const labelY = clamp(y - 28, rect.top + 2, rect.bottom - 18);
        context.fillStyle = 'rgba(22, 29, 39, 0.92)';
        context.fillRect(labelX, labelY, labelWidth, 18);
        context.strokeStyle = '#ffcf4d'; context.strokeRect(labelX, labelY, labelWidth, 18);
        context.fillStyle = '#ffe59b'; context.textAlign = 'left'; context.textBaseline = 'middle';
        context.fillText(label, labelX + 5, labelY + 9);
      }

      context.fillStyle = '#dce8f8';
      context.font = '600 12px system-ui, sans-serif';
      context.textAlign = 'left'; context.textBaseline = 'top';
      context.fillText(this.title, rect.left + 5, rect.top + 4);
      this.updateStatus();
    }

    updateStatus() {
      const span = this.isFloat ? this.sampleRate / 2 : this.sampleRate;
      const rbw = this.sampleRate / this.fftSize * this.enbwBins;
      const parts = [
        `Center ${engineering(this.centerFrequency, 'Hz')}`,
        `Span ${engineering(span, 'Hz')}`,
        `RBW ${engineering(rbw, 'Hz')}`,
      ];
      if (this.peak)
        parts.push(`Peak ${engineering(this.peak.frequency, 'Hz', 6)} ${this.peak.level.toFixed(2)} ${this.levelUnit}`);
      if (this.obw)
        parts.push(`OBW ${this.obw.percent.toFixed(2)}% ${engineering(this.obw.width, 'Hz', 6)}`);
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
      this.dirty = true;
    }

    setSampleRate(value) { this.sampleRate = Math.max(1, finite(value, this.sampleRate)); this.dirty = true; }
    setCenterFrequency(value) { this.centerFrequency = finite(value); this.dirty = true; }
    setAverage(value) { this.average = clamp(finite(value, this.average), 0.0001, 1); }
    setReferenceLevel(value) {
      this.referenceLevel = finite(value, this.referenceLevel);
      this.referenceInput.value = String(this.referenceLevel); this.dirty = true;
    }
    setDbPerDivision(value) {
      this.dbPerDivision = Math.max(0.1, finite(value, this.dbPerDivision));
      this.divisionInput.value = String(this.dbPerDivision); this.dirty = true;
    }
    setLevelOffsetDb(value) { this.levelOffsetDb = finite(value); this.updateMeasurements(); this.dirty = true; }
    setObwPercent(value) {
      this.obwPercent = clamp(finite(value, this.obwPercent), 0.001, 99.999);
      this.obwButton.textContent = `OBW ${this.obwPercent.toFixed(0)}%`;
      this.updateMeasurements(); this.dirty = true;
    }
    setObwSpan(value) { this.obwSpan = Math.max(0, finite(value)); this.updateMeasurements(); this.dirty = true; }

    configureNumeric(sampleRate, centerFrequency, enbwBins, average,
      referenceLevel, dbPerDivision, levelOffsetDb, peakTrack) {
      this.sampleRate = Math.max(1, finite(sampleRate, this.sampleRate));
      this.centerFrequency = finite(centerFrequency, this.centerFrequency);
      this.enbwBins = Math.max(1, finite(enbwBins, this.enbwBins));
      this.average = clamp(finite(average, this.average), 0.0001, 1);
      this.referenceLevel = finite(referenceLevel, this.referenceLevel);
      this.dbPerDivision = Math.max(0.1, finite(dbPerDivision, this.dbPerDivision));
      this.levelOffsetDb = finite(levelOffsetDb, this.levelOffsetDb);
      this.trackPeak = !!peakTrack;
      this.referenceInput.value = String(this.referenceLevel);
      this.divisionInput.value = String(this.dbPerDivision);
      this.updateButtonStates();
      this.dirty = true;
    }

    configureMeasurement(percent, span) {
      this.setObwPercent(percent);
      this.setObwSpan(span);
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
      const levels = Array.from(this.trace, value => db(value) + this.levelOffsetDb);
      const frequencies = this.frequencies();
      const stride = Math.max(1, Math.ceil(this.binCount / clamp(maxPoints | 0, 4, 256)));
      const samples = [];
      for (let index = 0; index < this.binCount; index += stride)
        samples.push([frequencies[index], levels[index]]);
      const minimum = Math.min(...levels);
      const maximum = Math.max(...levels);
      const mean = levels.reduce((sum, value) => sum + value, 0) / levels.length;
      const curve = {
        label: this.title, points: this.binCount,
        x: { min: frequencies[0], max: frequencies[frequencies.length - 1] },
        y: { min: minimum, max: maximum, mean },
        peak: this.peak ? { x: this.peak.frequency, y: this.peak.level } : undefined,
        samples,
        ...(stride > 1 ? { sample_stride: stride } : {}),
      };
      entry.kind = 'curves';
      entry.x_axis = { title: 'Frequency (Hz)', min: frequencies[0], max: frequencies[frequencies.length - 1] };
      entry.y_axis = { title: this.levelUnit,
        min: this.referenceLevel - GRID_DIVISIONS * this.dbPerDivision,
        max: this.referenceLevel };
      entry.curves = [curve];
      entry.rbw_hz = this.sampleRate / this.fftSize * this.enbwBins;
      entry.trace_mode = this.traceMode;
      if (this.markerIndex != null)
        entry.marker = { frequency: this.frequencyAt(this.markerIndex),
          level: levels[this.markerIndex], tracking: this.trackPeak };
      if (this.obw) entry.occupied_bandwidth = { ...this.obw };
      return entry;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.animationFrame);
      this.root.remove();
    }
  }

  class SpectrumAnalyzerManager {
    constructor() { this.instances = new Map(); this.nextId = 1; }
    create(options) {
      const id = this.nextId++;
      try {
        this.instances.set(id, new SpectrumAnalyzerRenderer(this, id, options));
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
    setObwPercent(id, value) { this.instances.get(id)?.setObwPercent(value); }
    setObwSpan(id, value) { this.instances.get(id)?.setObwSpan(value); }
    configureNumeric(id, ...values) { this.instances.get(id)?.configureNumeric(...values); }
    configureMeasurement(id, ...values) { this.instances.get(id)?.configureMeasurement(...values); }
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
    engineering, peakOf, occupiedBandwidth,
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
