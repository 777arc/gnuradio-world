// Browser WebGPU backend for gr-fosphor's embedded Qt sink. The scheduler-facing
// block lives in blocks/overlays/gr-fosphor/fosphor_webgpu_sink.cpp; this file
// owns everything browser-specific: adapter/device selection, WGSL pipelines,
// the overlay canvas, controls, rendering, and optional timestamp telemetry.
// Signal/FFT data never comes back from the GPU; only six timing counters are
// read a few times per second when the adapter supports timestamp queries.
(() => {
  'use strict';

  const FFT_SIZE = 1024;
  const FFT_STAGES = 10;
  const HISTORY_ROWS = 512;
  const FRAME_FLOATS = FFT_SIZE * 2;
  const TIMING_QUERY_COUNT = 6;
  const TIMING_SAMPLE_MS = 250;
  const STATS_UPDATE_MS = 1000;

  const WINDOW_SHADER = /* wgsl */`
    struct WindowParams { kind: i32, _pad0: u32, _pad1: u32, _pad2: u32 };
    @group(0) @binding(0) var<storage, read> input_samples: array<vec2<f32>>;
    @group(0) @binding(1) var<storage, read_write> output_samples: array<vec2<f32>>;
    @group(0) @binding(2) var<uniform> params: WindowParams;

    fn i0(value: f32) -> f32 {
      let y = value * value / 4.0;
      return 1.0 + y * (1.0 + y * (0.25 + y * (0.02777778 +
             y * (0.001736111 + y * 0.0000694444))));
    }

    fn coefficient(index: u32) -> f32 {
      let phase = 6.28318530718 * f32(index) / 1023.0;
      if (params.kind == 0) { return 0.54 - 0.46 * cos(phase); }
      if (params.kind == 1) { return 0.5 - 0.5 * cos(phase); }
      if (params.kind == 2) {
        return 0.42 - 0.5 * cos(phase) + 0.08 * cos(2.0 * phase);
      }
      if (params.kind == 3) { return 1.0; }
      if (params.kind == 4) {
        let position = 2.0 * f32(index) / 1023.0 - 1.0;
        return i0(6.76 * sqrt(max(0.0, 1.0 - position * position))) / i0(6.76);
      }
      if (params.kind == 7) {
        return 0.21557895 - 0.41663158 * cos(phase) +
               0.277263158 * cos(2.0 * phase) -
               0.083578947 * cos(3.0 * phase) +
               0.006947368 * cos(4.0 * phase);
      }
      return 0.35875 - 0.48829 * cos(phase) +
             0.14128 * cos(2.0 * phase) - 0.01168 * cos(3.0 * phase);
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let index = gid.x;
      if (index >= 1024u) { return; }
      let reversed = reverseBits(index) >> 22u;
      output_samples[reversed] = input_samples[index] * coefficient(index);
    }
  `;

  const FFT_SHADER = /* wgsl */`
    struct StageParams { stage: u32, _pad0: u32, _pad1: u32, _pad2: u32 };
    @group(0) @binding(0) var<storage, read> input_values: array<vec2<f32>>;
    @group(0) @binding(1) var<storage, read_write> output_values: array<vec2<f32>>;
    @group(0) @binding(2) var<uniform> params: StageParams;

    fn multiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
      return vec2<f32>(a.x * b.x - a.y * b.y,
                       a.x * b.y + a.y * b.x);
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let butterfly = gid.x;
      if (butterfly >= 512u) { return; }
      let half_span = 1u << (params.stage - 1u);
      let span = half_span << 1u;
      let offset = butterfly % half_span;
      let first = (butterfly / half_span) * span + offset;
      let second = first + half_span;
      let angle = -6.28318530718 * f32(offset) / f32(span);
      let twiddle = vec2<f32>(cos(angle), sin(angle));
      let even = input_values[first];
      let odd = multiply(input_values[second], twiddle);
      output_values[first] = even + odd;
      output_values[second] = even - odd;
    }
  `;

  const WATERFALL_SHADER = /* wgsl */`
    struct WaterfallParams {
      row: u32,
      db_reference: f32,
      db_per_division: f32,
      _pad0: u32,
    };
    @group(0) @binding(0) var<storage, read> fft_values: array<vec2<f32>>;
    @group(0) @binding(1) var history: texture_storage_2d<rgba8unorm, write>;
    @group(0) @binding(2) var<uniform> params: WaterfallParams;

    fn power_db(value: vec2<f32>) -> f32 {
      let power = max(dot(value, value) / (1024.0 * 1024.0), 1e-20);
      return 10.0 * log2(power) / log2(10.0);
    }

    fn color_map(level: f32) -> vec4<f32> {
      let value = clamp(level, 0.0, 1.0);
      let red = clamp(1.5 - abs(4.0 * value - 3.0), 0.0, 1.0);
      let green = clamp(1.5 - abs(4.0 * value - 2.0), 0.0, 1.0);
      let blue = clamp(1.5 - abs(4.0 * value - 1.0), 0.0, 1.0);
      return vec4<f32>(red, green, blue, 1.0);
    }

    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let x = gid.x;
      if (x >= 1024u) { return; }
      let shifted = (x + 512u) % 1024u;
      let minimum = params.db_reference - 10.0 * params.db_per_division;
      let level = (power_db(fft_values[shifted]) - minimum) /
                  max(1.0, params.db_reference - minimum);
      textureStore(history, vec2<i32>(i32(x), i32(params.row)), color_map(level));
    }
  `;

  const RENDER_SHADER = /* wgsl */`
    struct DisplayParams {
      size: vec2<f32>,
      spectrum_ratio: f32,
      zoom_center: f32,
      zoom_width: f32,
      db_reference: f32,
      db_per_division: f32,
      row: u32,
      frozen: u32,
    };
    @group(0) @binding(0) var<storage, read> fft_values: array<vec2<f32>>;
    @group(0) @binding(1) var history: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> params: DisplayParams;

    @vertex
    fn vertex_main(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
      var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
      return vec4<f32>(positions[vertex], 0.0, 1.0);
    }

    fn power_db(value: vec2<f32>) -> f32 {
      let power = max(dot(value, value) / (1024.0 * 1024.0), 1e-20);
      return 10.0 * log2(power) / log2(10.0);
    }

    fn fft_index(x: f32) -> u32 {
      let source = clamp(params.zoom_center - 0.5 * params.zoom_width +
                         x * params.zoom_width, 0.0, 0.999999);
      let display_bin = u32(source * 1024.0);
      return (display_bin + 512u) % 1024u;
    }

    @fragment
    fn fragment_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
      let uv = position.xy / max(params.size, vec2<f32>(1.0));
      let waterfall_end = 1.0 - params.spectrum_ratio;
      if (uv.y < waterfall_end) {
        let age = clamp((waterfall_end - uv.y) / max(waterfall_end, 0.001), 0.0, 1.0);
        let history_offset = u32(age * 511.0);
        let history_row = (params.row + 512u - history_offset) % 512u;
        let source = clamp(params.zoom_center - 0.5 * params.zoom_width +
                           uv.x * params.zoom_width, 0.0, 0.999999);
        let history_x = i32(source * 1023.0);
        return textureLoad(history, vec2<i32>(history_x, i32(history_row)), 0);
      }

      let local_y = (uv.y - waterfall_end) / max(params.spectrum_ratio, 0.001);
      let minimum = params.db_reference - 10.0 * params.db_per_division;
      let level = clamp((power_db(fft_values[fft_index(uv.x)]) - minimum) /
                        max(1.0, params.db_reference - minimum), 0.0, 1.0);
      let spectrum_y = 1.0 - level;
      let line_width = 2.0 / max(params.size.y * params.spectrum_ratio, 1.0);

      let major_x = abs(fract(uv.x * 10.0) - 0.5);
      let major_y = abs(fract(local_y * 10.0) - 0.5);
      var background = vec3<f32>(0.012, 0.018, 0.028);
      if (major_x > 0.492 || major_y > 0.492) {
        background = vec3<f32>(0.09, 0.12, 0.15);
      }
      if (abs(local_y - spectrum_y) <= line_width) {
        return vec4<f32>(0.35, 1.0, 0.28, 1.0);
      }
      return vec4<f32>(background, 1.0);
    }
  `;

  class FosphorRenderer {
    constructor(manager, id, options) {
      this.manager = manager;
      this.device = manager.device;
      this.id = id;
      this.memory = options.memory;
      this.controlPointer = options.controlPointer;
      this.samplesPointer = options.samplesPointer;
      this.sinkPointer = options.sinkPointer;
      this.publishFrequency = options.publishFrequency;
      this.centerFrequency = Number(options.centerFrequency) || 0;
      this.frequencySpan = Math.max(1, Number(options.frequencySpan) || 1);
      this.windowType = options.windowType | 0;
      this.dbReference = 0;
      this.dbPerDivisionIndex = 3;
      this.dbPerDivisions = [1, 2, 5, 10, 20];
      this.zoomEnabled = false;
      this.zoomCenter = 0.5;
      this.zoomWidth = 0.2;
      this.spectrumRatio = 0.35;
      this.frozen = false;
      this.historyRow = 0;
      this.lastSequence = 0;
      this.dirty = true;
      this.destroyed = false;
      this.frameCopy = new Float32Array(FRAME_FLOATS);
      this.renderedFrames = 0;
      this.skippedFrames = 0;
      this.statsFrames = 0;
      this.statsFps = 0;
      this.gpuFrameMs = 0;
      this.gpuDutyPercent = 0;
      this.statsUpdatedAt = performance.now();
      this.nextTimingAt = 0;
      this.timingPending = false;

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'gr-fosphor-webgpu';
      this.canvas.tabIndex = 0;
      this.canvas.title =
        'gr-fosphor WebGPU — duty is fosphor GPU time / wall time; click for keyboard controls';
      Object.assign(this.canvas.style, {
        position: 'fixed', left: '0', top: '0', width: '1px', height: '1px',
        zIndex: '10000', display: 'none', outline: 'none', background: '#05070b',
      });
      document.body.appendChild(this.canvas);
      this.statsBadge = document.createElement('div');
      this.statsBadge.className = 'gr-fosphor-webgpu-stats';
      this.statsBadge.textContent = 'WebGPU · measuring…';
      Object.assign(this.statsBadge.style, {
        position: 'fixed', left: '8px', top: '8px', zIndex: '10001',
        display: 'none', pointerEvents: 'none', padding: '4px 7px',
        border: '1px solid rgba(122, 211, 255, 0.45)', borderRadius: '4px',
        background: 'rgba(3, 8, 14, 0.82)', color: '#bfeaff',
        font: '12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'nowrap',
      });
      document.body.appendChild(this.statsBadge);
      this.context = this.canvas.getContext('webgpu');
      if (!this.context) throw new Error('could not create a WebGPU canvas context');
      this.context.configure({
        device: this.device,
        format: manager.canvasFormat,
        alphaMode: 'opaque',
      });

      this.createResources();
      this.createTimingResources();
      this.installControls();
      this.animationFrame = requestAnimationFrame(() => this.frame());
    }

    createResources() {
      const usage = GPUBufferUsage;
      this.inputBuffer = this.device.createBuffer({
        label: 'fosphor IQ input', size: FRAME_FLOATS * 4,
        usage: usage.STORAGE | usage.COPY_DST,
      });
      this.fftA = this.device.createBuffer({
        label: 'fosphor FFT A', size: FRAME_FLOATS * 4,
        // COPY_SRC is unused by the application; browser tests use it to verify
        // the computed peak without adding any readback to the render loop.
        usage: usage.STORAGE | usage.COPY_SRC,
      });
      this.fftB = this.device.createBuffer({
        label: 'fosphor FFT B', size: FRAME_FLOATS * 4, usage: usage.STORAGE,
      });
      this.windowParams = this.device.createBuffer({
        label: 'fosphor window params', size: 16,
        usage: usage.UNIFORM | usage.COPY_DST,
      });
      this.stageParams = Array.from({ length: FFT_STAGES }, (_, index) => {
        const buffer = this.device.createBuffer({
          label: `fosphor FFT stage ${index + 1}`, size: 16,
          usage: usage.UNIFORM | usage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, 0, new Uint32Array([index + 1, 0, 0, 0]));
        return buffer;
      });
      this.waterfallParams = this.device.createBuffer({
        label: 'fosphor waterfall params', size: 16,
        usage: usage.UNIFORM | usage.COPY_DST,
      });
      this.displayParams = this.device.createBuffer({
        label: 'fosphor display params', size: 48,
        usage: usage.UNIFORM | usage.COPY_DST,
      });
      this.history = this.device.createTexture({
        label: 'fosphor waterfall history',
        size: [FFT_SIZE, HISTORY_ROWS],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.historyView = this.history.createView();

      this.windowBindGroup = this.device.createBindGroup({
        layout: this.manager.windowPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.inputBuffer } },
          { binding: 1, resource: { buffer: this.fftA } },
          { binding: 2, resource: { buffer: this.windowParams } },
        ],
      });
      this.fftBindGroups = this.stageParams.map((stage, index) => {
        const input = index % 2 === 0 ? this.fftA : this.fftB;
        const output = index % 2 === 0 ? this.fftB : this.fftA;
        return this.device.createBindGroup({
          layout: this.manager.fftPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
            { binding: 2, resource: { buffer: stage } },
          ],
        });
      });
      this.waterfallBindGroup = this.device.createBindGroup({
        layout: this.manager.waterfallPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.fftA } },
          { binding: 1, resource: this.historyView },
          { binding: 2, resource: { buffer: this.waterfallParams } },
        ],
      });
      this.renderBindGroup = this.device.createBindGroup({
        layout: this.manager.renderPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.fftA } },
          { binding: 1, resource: this.historyView },
          { binding: 2, resource: { buffer: this.displayParams } },
        ],
      });
      this.setWindow(this.windowType);
    }

    createTimingResources() {
      this.timingSupported = this.manager.timestampQuerySupported;
      if (!this.timingSupported) return;
      try {
        const byteLength = TIMING_QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;
        this.timingQuerySet = this.device.createQuerySet({
          label: 'fosphor GPU timing', type: 'timestamp', count: TIMING_QUERY_COUNT,
        });
        this.timingResolveBuffer = this.device.createBuffer({
          label: 'fosphor GPU timing resolve', size: byteLength,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this.timingReadBuffer = this.device.createBuffer({
          label: 'fosphor GPU timing readback', size: byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      } catch (error) {
        this.timingSupported = false;
        console.warn(`gr-fosphor: GPU timing unavailable (${error.message || error})`);
      }
    }

    installControls() {
      this.keyHandler = event => {
        let handled = true;
        switch (event.key) {
          case 'ArrowUp': this.dbReference -= this.dbPerDivisions[this.dbPerDivisionIndex]; break;
          case 'ArrowDown': this.dbReference += this.dbPerDivisions[this.dbPerDivisionIndex]; break;
          case 'ArrowLeft': this.dbPerDivisionIndex = Math.max(0, this.dbPerDivisionIndex - 1); break;
          case 'ArrowRight': this.dbPerDivisionIndex = Math.min(4, this.dbPerDivisionIndex + 1); break;
          case 'z': case 'Z': this.zoomEnabled = !this.zoomEnabled; break;
          case 'w': case 'W': if (this.zoomEnabled) this.zoomWidth = Math.min(1, this.zoomWidth * 2); break;
          case 's': case 'S': if (this.zoomEnabled) this.zoomWidth = Math.max(1 / FFT_SIZE, this.zoomWidth / 2); break;
          case 'a': case 'A': if (this.zoomEnabled) this.zoomCenter -= this.zoomWidth / 8; break;
          case 'd': case 'D': if (this.zoomEnabled) this.zoomCenter += this.zoomWidth / 8; break;
          case 'q': case 'Q': this.spectrumRatio = Math.min(0.8, this.spectrumRatio + 0.05); break;
          case 'e': case 'E': this.spectrumRatio = Math.max(0.2, this.spectrumRatio - 0.05); break;
          case ' ': this.frozen = !this.frozen; break;
          default: handled = false;
        }
        if (!handled) return;
        this.zoomCenter = Math.min(1 - this.zoomWidth / 2,
          Math.max(this.zoomWidth / 2, this.zoomCenter));
        this.dirty = true;
        event.preventDefault();
        event.stopPropagation();
      };
      this.doubleClickHandler = event => {
        const x = Math.min(1, Math.max(0, event.offsetX / Math.max(1, this.canvas.clientWidth)));
        const visiblePosition = this.zoomEnabled
          ? this.zoomCenter - this.zoomWidth / 2 + x * this.zoomWidth : x;
        const frequency = this.centerFrequency + (visiblePosition - 0.5) * this.frequencySpan;
        this.publishFrequency(this.sinkPointer, frequency);
      };
      this.canvas.addEventListener('keydown', this.keyHandler);
      this.canvas.addEventListener('dblclick', this.doubleClickHandler);
    }

    setWindow(kind) {
      this.windowType = kind | 0;
      this.device.queue.writeBuffer(this.windowParams, 0,
        new Int32Array([this.windowType, 0, 0, 0]));
    }

    setFrequencyRange(center, span) {
      this.centerFrequency = Number(center) || 0;
      this.frequencySpan = Math.max(1, Number(span) || 1);
      this.dirty = true;
    }

    layout(x, y, width, height, visible) {
      const cssWidth = Math.max(1, width | 0);
      const cssHeight = Math.max(1, height | 0);
      Object.assign(this.canvas.style, {
        left: `${x | 0}px`, top: `${y | 0}px`, width: `${cssWidth}px`,
        height: `${cssHeight}px`, display: visible ? 'block' : 'none',
      });
      Object.assign(this.statsBadge.style, {
        left: `${(x | 0) + 8}px`, top: `${(y | 0) + 8}px`,
        display: visible ? 'block' : 'none',
      });
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
      const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
        this.dirty = true;
      }
    }

    copyNewestFrame() {
      const buffer = this.memory.buffer;
      const control = new Int32Array(buffer, this.controlPointer, 1);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = Atomics.load(control, 0) >>> 0;
        if (!before || before === this.lastSequence) return false;
        const offset = this.samplesPointer + (before & 1) * FRAME_FLOATS * 4;
        this.frameCopy.set(new Float32Array(buffer, offset, FRAME_FLOATS));
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

    writeUniforms() {
      const division = this.dbPerDivisions[this.dbPerDivisionIndex];
      const waterfall = new ArrayBuffer(16);
      const waterfallView = new DataView(waterfall);
      waterfallView.setUint32(0, this.historyRow, true);
      waterfallView.setFloat32(4, this.dbReference, true);
      waterfallView.setFloat32(8, division, true);
      this.device.queue.writeBuffer(this.waterfallParams, 0, waterfall);

      const display = new ArrayBuffer(48);
      const displayView = new DataView(display);
      displayView.setFloat32(0, this.canvas.width, true);
      displayView.setFloat32(4, this.canvas.height, true);
      displayView.setFloat32(8, this.spectrumRatio, true);
      displayView.setFloat32(12, this.zoomEnabled ? this.zoomCenter : 0.5, true);
      displayView.setFloat32(16, this.zoomEnabled ? this.zoomWidth : 1.0, true);
      displayView.setFloat32(20, this.dbReference, true);
      displayView.setFloat32(24, division, true);
      displayView.setUint32(28, this.historyRow, true);
      displayView.setUint32(32, this.frozen ? 1 : 0, true);
      this.device.queue.writeBuffer(this.displayParams, 0, display);
    }

    timestampWrites(beginning, end, enabled) {
      return enabled ? {
        querySet: this.timingQuerySet,
        beginningOfPassWriteIndex: beginning,
        endOfPassWriteIndex: end,
      } : undefined;
    }

    collectGpuTiming() {
      this.timingPending = true;
      this.timingReadBuffer.mapAsync(GPUMapMode.READ).then(() => {
        if (this.destroyed) return;
        const values = new BigUint64Array(this.timingReadBuffer.getMappedRange());
        let elapsedNanoseconds = 0n;
        for (let index = 0; index < TIMING_QUERY_COUNT; index += 2) {
          if (values[index + 1] >= values[index])
            elapsedNanoseconds += values[index + 1] - values[index];
        }
        const milliseconds = Number(elapsedNanoseconds) / 1e6;
        if (milliseconds > 0 && Number.isFinite(milliseconds)) {
          this.gpuFrameMs = this.gpuFrameMs
            ? this.gpuFrameMs * 0.8 + milliseconds * 0.2
            : milliseconds;
        }
        this.timingReadBuffer.unmap();
      }).catch(error => {
        this.timingSupported = false;
        console.warn(`gr-fosphor: GPU timing readback failed (${error.message || error})`);
      }).finally(() => {
        this.timingPending = false;
      });
    }

    updateStats(now) {
      const elapsed = now - this.statsUpdatedAt;
      if (elapsed < STATS_UPDATE_MS) return;
      const frames = this.renderedFrames - this.statsFrames;
      this.statsFps = frames * 1000 / elapsed;
      this.gpuDutyPercent = this.timingSupported && this.gpuFrameMs
        ? this.gpuFrameMs * this.statsFps / 10
        : 0;
      const timing = this.timingSupported && this.gpuFrameMs
        ? `${this.gpuFrameMs.toFixed(2)} ms/frame · ${this.gpuDutyPercent.toFixed(1)}% duty`
        : 'GPU timing unavailable';
      this.statsBadge.textContent =
        `WebGPU · ${this.statsFps.toFixed(0)} fps · ${timing} · ${this.skippedFrames} skipped`;
      this.statsFrames = this.renderedFrames;
      this.statsUpdatedAt = now;
      this.stats = {
        fps: this.statsFps,
        gpuFrameMs: this.gpuFrameMs,
        gpuDutyPercent: this.gpuDutyPercent,
        skippedFrames: this.skippedFrames,
        timingSupported: this.timingSupported,
      };
    }

    frame() {
      if (this.destroyed) return;
      this.animationFrame = requestAnimationFrame(() => this.frame());
      const now = performance.now();
      const hasFrame = !this.frozen && this.copyNewestFrame();
      this.updateStats(now);
      if (!hasFrame && !this.dirty) return;
      if (!this.canvas.width || !this.canvas.height || this.canvas.style.display === 'none') return;

      if (hasFrame) {
        this.device.queue.writeBuffer(this.inputBuffer, 0, this.frameCopy);
        this.historyRow = (this.historyRow + 1) % HISTORY_ROWS;
      }
      this.writeUniforms();
      const measureTiming = hasFrame && this.timingSupported &&
        !this.timingPending && now >= this.nextTimingAt;
      if (measureTiming) this.nextTimingAt = now + TIMING_SAMPLE_MS;
      const encoder = this.device.createCommandEncoder({ label: 'fosphor frame' });
      if (hasFrame) {
        let pass = encoder.beginComputePass({
          label: 'fosphor window and FFT',
          timestampWrites: this.timestampWrites(0, 1, measureTiming),
        });
        pass.setPipeline(this.manager.windowPipeline);
        pass.setBindGroup(0, this.windowBindGroup);
        pass.dispatchWorkgroups(FFT_SIZE / 64);
        for (let stage = 0; stage < FFT_STAGES; stage++) {
          pass.setPipeline(this.manager.fftPipeline);
          pass.setBindGroup(0, this.fftBindGroups[stage]);
          pass.dispatchWorkgroups((FFT_SIZE / 2) / 64);
        }
        pass.end();
        pass = encoder.beginComputePass({
          label: 'fosphor waterfall',
          timestampWrites: this.timestampWrites(2, 3, measureTiming),
        });
        pass.setPipeline(this.manager.waterfallPipeline);
        pass.setBindGroup(0, this.waterfallBindGroup);
        pass.dispatchWorkgroups(FFT_SIZE / 64);
        pass.end();
      }

      const view = this.context.getCurrentTexture().createView();
      const render = encoder.beginRenderPass({
        label: 'fosphor display',
        timestampWrites: this.timestampWrites(4, 5, measureTiming),
        colorAttachments: [{
          view,
          clearValue: { r: 0.005, g: 0.008, b: 0.015, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        }],
      });
      render.setPipeline(this.manager.renderPipeline);
      render.setBindGroup(0, this.renderBindGroup);
      render.draw(3);
      render.end();
      if (measureTiming) {
        const byteLength = TIMING_QUERY_COUNT * BigUint64Array.BYTES_PER_ELEMENT;
        encoder.resolveQuerySet(
          this.timingQuerySet, 0, TIMING_QUERY_COUNT, this.timingResolveBuffer, 0);
        encoder.copyBufferToBuffer(
          this.timingResolveBuffer, 0, this.timingReadBuffer, 0, byteLength);
      }
      this.device.queue.submit([encoder.finish()]);
      if (measureTiming) this.collectGpuTiming();
      if (hasFrame) this.renderedFrames++;
      this.dirty = false;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.animationFrame);
      this.canvas.removeEventListener('keydown', this.keyHandler);
      this.canvas.removeEventListener('dblclick', this.doubleClickHandler);
      this.context.unconfigure();
      this.canvas.remove();
      this.statsBadge.remove();
      for (const buffer of [this.inputBuffer, this.fftA, this.fftB,
        this.windowParams, this.waterfallParams, this.displayParams,
        ...this.stageParams]) buffer.destroy();
      this.timingResolveBuffer?.destroy();
      this.timingReadBuffer?.destroy();
      this.timingQuerySet?.destroy();
      this.history.destroy();
    }
  }

  class FosphorWebGpuManager {
    constructor() {
      this.device = null;
      this.ready = false;
      this.reason = 'not requested';
      this.timestampQuerySupported = false;
      this.instances = new Map();
      this.nextId = 1;
      this.lastBackendMessage = '';
      globalThis.__grFosphorBackend = 'uninitialized';
      globalThis.__grFosphorState = { backend: 'uninitialized', reason: this.reason };
    }

    async prepare() {
      if (this.ready) return true;
      if (globalThis.__grForceCpuFosphor) {
        this.markCpu('WebGPU disabled by test/user override');
        return false;
      }
      if (!navigator.gpu) {
        this.markCpu('navigator.gpu is unavailable');
        return false;
      }
      try {
        const adapter =
          await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) ||
          await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('requestAdapter returned no adapter');
        const wantsTimestamps = adapter.features.has('timestamp-query');
        try {
          this.device = await adapter.requestDevice({
            requiredFeatures: wantsTimestamps ? ['timestamp-query'] : [],
          });
        } catch (error) {
          if (!wantsTimestamps) throw error;
          console.warn(
            `gr-fosphor: timestamp queries could not be enabled (${error.message || error})`);
          this.device = await adapter.requestDevice();
        }
        this.timestampQuerySupported = this.device.features.has('timestamp-query');
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
        this.device.addEventListener('uncapturederror', event =>
          console.error('gr-fosphor WebGPU validation error:', event.error));
        this.device.lost.then(info => {
          this.ready = false;
          this.reason = `WebGPU device lost: ${info.message || info.reason}`;
          globalThis.__grFosphorState = { backend: 'device-lost', reason: this.reason };
          console.error(this.reason);
        });
        await this.createPipelines();
        this.ready = true;
        this.reason = '';
        return true;
      } catch (error) {
        this.device = null;
        this.markCpu(`WebGPU initialization failed: ${error.message || error}`);
        return false;
      }
    }

    async createPipelines() {
      const module = code => this.device.createShaderModule({ code });
      const [windowPipeline, fftPipeline, waterfallPipeline, renderPipeline] =
        await Promise.all([
          this.device.createComputePipelineAsync({
            label: 'fosphor window/bit reversal', layout: 'auto',
            compute: { module: module(WINDOW_SHADER), entryPoint: 'main' },
          }),
          this.device.createComputePipelineAsync({
            label: 'fosphor radix-2 FFT', layout: 'auto',
            compute: { module: module(FFT_SHADER), entryPoint: 'main' },
          }),
          this.device.createComputePipelineAsync({
            label: 'fosphor waterfall update', layout: 'auto',
            compute: { module: module(WATERFALL_SHADER), entryPoint: 'main' },
          }),
          this.device.createRenderPipelineAsync({
            label: 'fosphor display', layout: 'auto',
            vertex: { module: module(RENDER_SHADER), entryPoint: 'vertex_main' },
            fragment: {
              module: module(RENDER_SHADER), entryPoint: 'fragment_main',
              targets: [{ format: this.canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
          }),
        ]);
      this.windowPipeline = windowPipeline;
      this.fftPipeline = fftPipeline;
      this.waterfallPipeline = waterfallPipeline;
      this.renderPipeline = renderPipeline;
    }

    create(options) {
      if (!this.ready || !this.device) return 0;
      const id = this.nextId++;
      try {
        const renderer = new FosphorRenderer(this, id, options);
        this.instances.set(id, renderer);
        globalThis.__grFosphorBackend = 'webgpu';
        globalThis.__grFosphorState = { backend: 'webgpu', reason: '', rendererId: id };
        this.reportBackend('webgpu');
        return id;
      } catch (error) {
        this.reason = `WebGPU canvas initialization failed: ${error.message || error}`;
        console.error(this.reason);
        this.markCpu(this.reason);
        return 0;
      }
    }

    reportBackend(backend, reason = '') {
      const message = backend === 'webgpu'
        ? 'gr-fosphor: using WebGPU renderer'
        : `gr-fosphor: using CPU renderer (${reason})`;
      if (message === this.lastBackendMessage) return;
      this.lastBackendMessage = message;
      console.info(message);
      if (window.parent && window.parent !== window)
        window.parent.postMessage({ type: 'gr-info', message }, '*');
    }

    markCpu(reason) {
      this.reason = reason;
      globalThis.__grFosphorBackend = 'cpu';
      globalThis.__grFosphorState = { backend: 'cpu', reason };
      this.reportBackend('cpu', reason);
    }

    layout(id, x, y, width, height, visible) {
      this.instances.get(id)?.layout(x, y, width, height, visible);
    }
    setFrequencyRange(id, center, span) {
      this.instances.get(id)?.setFrequencyRange(center, span);
    }
    setWindow(id, kind) { this.instances.get(id)?.setWindow(kind); }
    destroy(id) {
      this.instances.get(id)?.destroy();
      this.instances.delete(id);
    }
  }

  globalThis.__grFosphorWebGpu = new FosphorWebGpuManager();
})();
