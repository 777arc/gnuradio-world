// Help ▸ SDR Receive Speed Test: an internet-speed-test-style measurement of
// the complete WebUSB SDR receive path into GNU Radio.
//
// The private runner executes the selected radio Source -> Null Sink. Its
// headline rate is the Source block's item delta divided by the runner's uptime
// delta, so USB, IQ conversion, the shared ring and GNU Radio scheduling count.
// See docs/diagnostics.md and the three radio-specific docs.

import {
  authorizedHackRfDevices,
  hackRfLabel,
  HACKRF_USB_FILTERS,
} from './hackrf';
import {
  authorizedPlutoDevices,
  plutoLabel,
  PLUTOSDR_USB_FILTERS,
} from './plutosdr';
import {
  authorizedRtlDevices,
  rtlDriverProblem,
  rtlLabel,
  RTLSDR_USB_FILTERS,
} from './rtlsdr';
import {
  usbApi,
  type UsbFilter,
  type UsbLike,
  type UsbPreparationProblem,
} from './usb-radio';

export interface SdrSpeedTestDeps {
  openDialog: (
    title: string, build: (body: HTMLElement) => void, wide?: boolean,
  ) => HTMLElement;
  log: (message: string) => void;
  isFlowgraphRunning: () => boolean;
}

export interface SdrSpeedReading {
  seconds: number;
  items: number;
  actualRate: number;
  overruns: number;
  lostSamples: number;
  usbState: string;
}

export interface SdrSpeedResult {
  samplesPerSecond: number;
  actualRate: number;
  overruns: number;
  lostSamples: number;
}

export type SdrSpeedRadio = 'hackrf' | 'plutosdr' | 'rtlsdr';

type SdrSpeedRadioConfig = {
  id: SdrSpeedRadio;
  name: string;
  statsDevice: string;
  filters: UsbFilter[];
  rates: number[];
  bytesPerSample: number;
  iqDescription: string;
  authorized: () => Promise<UsbLike[]>;
  label: (device: UsbLike) => string;
};

const RADIOS: SdrSpeedRadioConfig[] = [
  {
    id: 'hackrf', name: 'HackRF', statsDevice: 'HackRF',
    filters: HACKRF_USB_FILTERS,
    rates: [20e6, 16e6, 12.5e6, 10e6, 8e6, 5e6, 2e6],
    bytesPerSample: 2, iqDescription: 'signed 8-bit IQ',
    authorized: authorizedHackRfDevices, label: hackRfLabel,
  },
  {
    id: 'plutosdr', name: 'PlutoSDR', statsDevice: 'PlutoSDR',
    filters: PLUTOSDR_USB_FILTERS,
    rates: [61.44e6, 56e6, 40e6, 30.72e6, 20e6, 10e6, 5e6, 2.5e6],
    bytesPerSample: 4, iqDescription: 'signed 16-bit IQ',
    authorized: authorizedPlutoDevices, label: plutoLabel,
  },
  {
    id: 'rtlsdr', name: 'RTL-SDR', statsDevice: 'RTL-SDR',
    filters: RTLSDR_USB_FILTERS,
    rates: [3.2e6, 2.88e6, 2.4e6, 2.048e6, 1.8e6, 1.024e6],
    bytesPerSample: 2, iqDescription: 'unsigned 8-bit IQ',
    authorized: authorizedRtlDevices, label: rtlLabel,
  },
];

function radioConfig(id: SdrSpeedRadio): SdrSpeedRadioConfig {
  return RADIOS.find(radio => radio.id === id) || RADIOS[0];
}

const WARM_SECONDS = 1;
const MEASURE_SECONDS = 5;
const POLL_MS = 80;
const START_TIMEOUT_MS = 30000;
const DEFAULT_PLUTO_BUFFER_SIZE = 32768;
const MAX_PLUTO_BUFFER_SIZE = 262144;

function sourceBlock(
  radio: SdrSpeedRadio,
  serial: string,
  sampleRate: number,
  plutoBufferSize: number,
): string {
  const device = JSON.stringify(serial);
  const rate = Math.round(sampleRate);
  if (radio === 'plutosdr') return `    id: wasm_plutosdr_source
    parameters:
        bandwidth: '${Math.min(rate, 56000000)}'
        bb_dc: 'True'
        buffer_size: '${plutoBufferSize}'
        center_freq: '1000000000'
        channels: '1'
        device: ${device}
        gain1: '30'
        gain2: '30'
        gain_mode1: slow_attack
        gain_mode2: slow_attack
        quadrature: 'True'
        rf_dc: 'True'
        samp_rate: '${rate}'`;
  if (radio === 'rtlsdr') return `    id: wasm_rtlsdr_source
    parameters:
        bias_tee: 'False'
        bufflen: '262144'
        center_freq: '100000000'
        device: ${device}
        direct_samp: '0'
        freq_correction: '0'
        gain: '30'
        gain_mode: 'False'
        samp_rate: '${rate}'
        type: complex`;
  return `    id: wasm_hackrf_source
    parameters:
        amp: 'False'
        bandwidth: '0'
        bias_tee: 'False'
        center_freq: '100000000'
        device: ${device}
        lna_gain: '16'
        samp_rate: '${rate}'
        transfer_size: '262144'
        vga_gain: '16'`;
}

/** A self-paced hardware flowgraph whose only work is receiving into GNU Radio. */
export function sdrReceiveBenchmarkFlowgraph(
  radio: SdrSpeedRadio,
  serial: string,
  sampleRate: number,
  plutoBufferSize = DEFAULT_PLUTO_BUFFER_SIZE,
): string {
  if (radio === 'plutosdr' &&
      (!Number.isInteger(plutoBufferSize) || plutoBufferSize < 1 ||
       plutoBufferSize > MAX_PLUTO_BUFFER_SIZE))
    throw new Error(`PlutoSDR buffer size must be an integer from 1 to ${MAX_PLUTO_BUFFER_SIZE}`);
  return `options:
    parameters:
        id: sdr_receive_speed_test
    states:
        coordinate: [0, 0]
        rotation: 0
        state: enabled
blocks:
-   name: sdr_source
${sourceBlock(radio, serial, sampleRate, plutoBufferSize)}
    states:
        coordinate: [0, 0]
        rotation: 0
        state: enabled
-   name: sdr_sink
    id: blocks_null_sink
    parameters:
        type: complex
        vlen: '1'
    states:
        coordinate: [240, 0]
        rotation: 0
        state: enabled
connections:
- [sdr_source, '0', sdr_sink, '0']
metadata:
    file_format: 1
    grc_version: 3.11.0.0
`;
}

/** Samples/second between two diagnostics snapshots; null for a stale pair. */
export function receiveRate(
  first: Pick<SdrSpeedReading, 'seconds' | 'items'>,
  last: Pick<SdrSpeedReading, 'seconds' | 'items'>,
): number | null {
  const seconds = last.seconds - first.seconds;
  const items = last.items - first.items;
  if (!(seconds > 0) || items < 0) return null;
  const rate = items / seconds;
  return Number.isFinite(rate) ? rate : null;
}

/** Needle angle for the semicircular gauge. */
export function speedometerAngle(samplesPerSecond: number, maximum: number): number {
  const fraction = maximum > 0
    ? Math.max(0, Math.min(1, samplesPerSecond / maximum)) : 0;
  return -90 + fraction * 180;
}

export function formatSdrRate(samplesPerSecond: number): string {
  if (samplesPerSecond >= 1e6)
    return `${(samplesPerSecond / 1e6).toFixed(2)} MSamples/s`;
  if (samplesPerSecond >= 1e3)
    return `${(samplesPerSecond / 1e3).toFixed(1)} kSamples/s`;
  return `${Math.round(samplesPerSecond)} Samples/s`;
}

let speedFrame: HTMLIFrameElement | null = null;

/** Keep the private runner's messages out of the editor's normal Run state. */
export function isSdrSpeedTestFrameSource(event: MessageEvent): boolean {
  return !!speedFrame?.contentWindow && event.source === speedFrame.contentWindow;
}

function runnerFailure(frame: HTMLIFrameElement, search: string): string | null {
  try {
    if (frame.contentWindow?.location.search !== search) return null;
  } catch { return null; }
  const result = frame.contentDocument?.getElementById('result');
  if (!result || result.dataset.status !== 'fail') return null;
  return (result.textContent || 'flowgraph failed')
    .replace(/^RESULT:\s*RUNNER_FAIL\s*/, '');
}

function readSpeed(
  frame: HTMLIFrameElement,
  search: string,
  radio: SdrSpeedRadioConfig,
): SdrSpeedReading | null {
  let live: any;
  try {
    live = frame.contentWindow;
    if (!live || live.location.search !== search) return null;
  } catch { return null; }
  if (!live.__grstats) return null;
  try {
    const stats = JSON.parse(live.__grstats);
    const source = (stats.blocks || []).find((block: any) => block.name === 'sdr_source');
    const usb = Object.values(live.__grUsbStats || {}).find((entry: any) =>
      entry.device === radio.statsDevice && entry.direction === 'rx') as any;
    if (!source) return null;
    return {
      seconds: Number(stats.uptime_s),
      items: Number(source.items),
      actualRate: Number(usb?.actualRate || 0),
      overruns: Number(usb?.overruns || 0),
      lostSamples: Number(usb?.droppedSamples || usb?.droppedPairs || 0),
      usbState: String(usb?.state || ''),
    };
  } catch { return null; }
}

const sleep = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function measureReceive(
  frame: HTMLIFrameElement,
  radio: SdrSpeedRadioConfig,
  serial: string,
  sampleRate: number,
  plutoBufferSize: number,
  alive: () => boolean,
  progress: (rate: number, fraction: number, reading: SdrSpeedReading) => void,
): Promise<SdrSpeedResult> {
  const search = `?sdr-speed-test=${Date.now()}`;
  frame.src = `/runner/build/runner.html${search}#` +
    encodeURIComponent(sdrReceiveBenchmarkFlowgraph(
      radio.id, serial, sampleRate, plutoBufferSize));

  const deadline = Date.now() + START_TIMEOUT_MS;
  let baseline: SdrSpeedReading | null = null;
  for (;;) {
    await sleep(POLL_MS);
    if (!alive()) throw new Error('cancelled');
    const failure = runnerFailure(frame, search);
    if (failure) throw new Error(failure);
    const reading = readSpeed(frame, search, radio);
    if (reading && reading.items > 0 && reading.seconds >= WARM_SECONDS &&
        reading.usbState === 'running') {
      baseline = reading;
      break;
    }
    if (Date.now() > deadline)
      throw new Error(`the ${radio.name} receive flowgraph produced no samples`);
  }

  let last = baseline;
  let lastPublishedItems = -1;
  const measureDeadline = Date.now() + (MEASURE_SECONDS + 15) * 1000;
  for (;;) {
    await sleep(POLL_MS);
    if (!alive()) throw new Error('cancelled');
    if (Date.now() > measureDeadline)
      throw new Error(`the ${radio.name} receive rate stopped updating`);
    const failure = runnerFailure(frame, search);
    if (failure) throw new Error(failure);
    const reading = readSpeed(frame, search, radio);
    if (!reading || reading.items === lastPublishedItems) continue;
    lastPublishedItems = reading.items;
    last = reading;
    const elapsed = reading.seconds - baseline.seconds;
    const rate = receiveRate(baseline, reading) || 0;
    progress(rate, Math.min(1, elapsed / MEASURE_SECONDS), reading);
    if (elapsed >= MEASURE_SECONDS) break;
  }

  const rate = receiveRate(baseline, last);
  if (rate === null || !(rate > 0)) throw new Error('the receive rate could not be measured');
  return {
    samplesPerSecond: rate,
    actualRate: last.actualRate || sampleRate,
    overruns: Math.max(0, last.overruns - baseline.overruns),
    lostSamples: Math.max(0, last.lostSamples - baseline.lostSamples),
  };
}

function makeGauge() {
  const wrap = document.createElement('div');
  wrap.className = 'sdr-gauge';
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-valuemin', '0');

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 360 210');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(ns, 'defs');
  const gradient = document.createElementNS(ns, 'linearGradient');
  const gradientId = `sdr-speed-gradient-${Math.random().toString(36).slice(2)}`;
  gradient.id = gradientId;
  for (const [offset, color] of [['0%', '#58a6ff'], ['58%', '#4fc3d6'], ['100%', '#55d17d']]) {
    const stop = document.createElementNS(ns, 'stop');
    stop.setAttribute('offset', offset); stop.setAttribute('stop-color', color);
    gradient.appendChild(stop);
  }
  defs.appendChild(gradient); svg.appendChild(defs);

  const arc = (className: string, stroke: string) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M 40 180 A 140 140 0 0 1 320 180');
    path.setAttribute('class', className); path.setAttribute('stroke', stroke);
    svg.appendChild(path);
  };
  arc('sdr-gauge-track', '#171a24');
  arc('sdr-gauge-color', `url(#${gradientId})`);

  const needle = document.createElementNS(ns, 'g');
  needle.setAttribute('class', 'sdr-gauge-needle');
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', '180'); line.setAttribute('y1', '180');
  line.setAttribute('x2', '180'); line.setAttribute('y2', '62');
  const hub = document.createElementNS(ns, 'circle');
  hub.setAttribute('cx', '180'); hub.setAttribute('cy', '180'); hub.setAttribute('r', '10');
  needle.append(line, hub); svg.appendChild(needle);

  const labels = [-90, -45, 0, 45, 90].map((angle, index) => {
    const radians = (angle - 90) * Math.PI / 180;
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(180 + Math.cos(radians) * 112));
    text.setAttribute('y', String(180 + Math.sin(radians) * 112 - 8));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'sdr-gauge-tick');
    text.textContent = String(index);
    svg.appendChild(text);
    return text;
  });

  const value = document.createElement('div');
  value.className = 'sdr-gauge-value'; value.textContent = '0 Samples/s';
  const caption = document.createElement('div');
  caption.className = 'sdr-gauge-caption'; caption.textContent = 'into GNU Radio World';
  wrap.append(svg, value, caption);

  const update = (rate: number, maximum: number) => {
    needle.style.transform = `rotate(${speedometerAngle(rate, maximum)}deg)`;
    value.textContent = formatSdrRate(rate);
    wrap.setAttribute('aria-valuemax', String(maximum));
    wrap.setAttribute('aria-valuenow', String(Math.round(rate)));
    wrap.setAttribute('aria-valuetext', `${formatSdrRate(rate)} into GNU Radio World`);
    labels.forEach((label, index) => {
      const tickRate = maximum * index / (labels.length - 1);
      label.textContent = tickRate === 0 ? '0' : tickRate >= 1e6
        ? `${tickRate / 1e6}` : `${tickRate / 1e3}k`;
    });
  };
  return { wrap, update };
}

const lastResults = new Map<SdrSpeedRadio, SdrSpeedResult>();

export function showSdrSpeedTestDialog(deps: SdrSpeedTestDeps): void {
  const { openDialog, log, isFlowgraphRunning } = deps;
  let overlay: HTMLElement | null = null;
  let running = false;
  let devices: UsbLike[] = [];
  let selectedRadio = radioConfig('hackrf');
  let refreshSequence = 0;

  overlay = openDialog('SDR Receive Speed Test', body => {
    body.classList.add('debug-body', 'sdr-speed-body');

    const intro = document.createElement('p');
    intro.className = 'sdr-speed-intro';
    intro.textContent = 'Measures the complete SDR receive path: USB into the browser, ' +
      'IQ conversion and the GNU Radio scheduler. The test receives at the selected rate ' +
      'for five seconds and discards the samples in a Null Sink.';
    body.appendChild(intro);

    const gauge = makeGauge();
    body.appendChild(gauge.wrap);

    const form = document.createElement('div');
    form.className = 'sdr-speed-form';
    const radioLabel = document.createElement('label');
    radioLabel.textContent = 'SDR type';
    const radioSelect = document.createElement('select');
    for (const radio of RADIOS)
      radioSelect.appendChild(new Option(radio.name, radio.id));
    radioLabel.appendChild(radioSelect);
    const deviceLabel = document.createElement('label');
    deviceLabel.textContent = `${selectedRadio.name} device`;
    const deviceSelect = document.createElement('select');
    deviceLabel.appendChild(deviceSelect);
    const share = document.createElement('button');
    share.type = 'button'; share.textContent = `Share ${selectedRadio.name}…`;
    const rateLabel = document.createElement('label');
    rateLabel.textContent = 'Test ceiling';
    const rateSelect = document.createElement('select');
    rateLabel.appendChild(rateSelect);
    const bufferLabel = document.createElement('label');
    bufferLabel.className = 'sdr-speed-buffer';
    bufferLabel.textContent = 'IIO buffer (samples)';
    const bufferInput = document.createElement('input');
    bufferInput.type = 'number';
    bufferInput.min = '1';
    bufferInput.max = String(MAX_PLUTO_BUFFER_SIZE);
    bufferInput.step = '1';
    bufferInput.value = String(DEFAULT_PLUTO_BUFFER_SIZE);
    bufferLabel.appendChild(bufferInput);
    form.append(radioLabel, deviceLabel, share, rateLabel, bufferLabel);
    body.appendChild(form);

    const progress = document.createElement('div');
    progress.className = 'sdr-speed-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
    const progressFill = document.createElement('div');
    progressFill.className = 'sdr-speed-progress-fill'; progress.appendChild(progressFill);
    body.appendChild(progress);

    const controls = document.createElement('div');
    controls.className = 'sdr-speed-controls';
    const runButton = document.createElement('button');
    runButton.className = 'sdr-speed-run'; runButton.textContent = 'Start Speed Test';
    const status = document.createElement('span');
    status.className = 'sdr-speed-status';
    status.textContent = 'Choose a device, then start the test.';
    controls.append(runButton, status); body.appendChild(controls);

    const detail = document.createElement('div');
    detail.className = 'sdr-speed-detail';
    body.appendChild(detail);

    const setProgress = (fraction: number) => {
      const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      progressFill.style.width = `${percent}%`;
      progress.setAttribute('aria-valuenow', String(percent));
    };

    const renderDevices = (preferred = '') => {
      const selected = preferred || deviceSelect.value;
      deviceSelect.textContent = '';
      if (!devices.length)
        deviceSelect.appendChild(new Option(
          `No ${selectedRadio.name} shared with this site`, ''));
      else
        for (const device of devices)
          deviceSelect.appendChild(new Option(
            selectedRadio.label(device), device.serialNumber || ''));
      if ([...deviceSelect.options].some(option => option.value === selected))
        deviceSelect.value = selected;
      deviceSelect.disabled = running || !devices.length;
    };

    const refreshDevices = async (preferred = '') => {
      const radio = selectedRadio;
      const sequence = ++refreshSequence;
      const refreshed = await radio.authorized();
      if (!overlay?.isConnected || sequence !== refreshSequence || selectedRadio !== radio)
        return;
      devices = refreshed;
      renderDevices(preferred);
    };

    const renderRates = () => {
      rateSelect.textContent = '';
      for (const rate of selectedRadio.rates)
        rateSelect.appendChild(new Option(`${rate / 1e6} MSamples/s`, String(rate)));
    };

    const renderRadio = () => {
      deviceLabel.firstChild!.textContent = `${selectedRadio.name} device`;
      share.textContent = `Share ${selectedRadio.name}…`;
      form.classList.toggle('has-pluto-buffer', selectedRadio.id === 'plutosdr');
      bufferLabel.hidden = selectedRadio.id !== 'plutosdr';
      bufferInput.disabled = running || selectedRadio.id !== 'plutosdr';
      devices = [];
      renderDevices();
      renderRates();
      const previous = lastResults.get(selectedRadio.id);
      gauge.update(previous?.samplesPerSecond || 0, Number(rateSelect.value));
      status.textContent = previous
        ? `Last ${selectedRadio.name} result: ${formatSdrRate(previous.samplesPerSecond)}`
        : `Choose a ${selectedRadio.name}, then start the test.`;
      void refreshDevices();
    };

    const requestDevice = async (radio: SdrSpeedRadioConfig): Promise<UsbLike | null> => {
      const usb = usbApi();
      if (!usb) throw new Error('WebUSB is unavailable; use Chrome, Edge or Opera.');
      // The call itself must happen directly under this button click.
      const device = await usb.requestDevice({ filters: radio.filters });
      if (selectedRadio === radio) await refreshDevices(device.serialNumber || '');
      return device;
    };

    const showPreparationProblem = (
      problem: Exclude<UsbPreparationProblem, string>,
    ) => {
      status.textContent = problem.message;
      openDialog(problem.title, problemBody => {
        const message = document.createElement('p');
        message.textContent = problem.message;
        problemBody.appendChild(message);
      });
    };

    const rtlIsAccessible = async (
      radio: SdrSpeedRadioConfig, device: UsbLike | null,
    ): Promise<boolean> => {
      if (radio.id !== 'rtlsdr' || !device) return true;
      const problem = await rtlDriverProblem(device);
      if (!problem || typeof problem === 'string') return true;
      showPreparationProblem(problem);
      return false;
    };

    share.onclick = () => {
      if (running) return;
      const radio = selectedRadio;
      void requestDevice(radio)
        .then(device => rtlIsAccessible(radio, device))
        .catch(error => {
          status.textContent = error instanceof Error ? error.message : String(error);
        });
    };

    radioSelect.onchange = () => {
      if (running) return;
      selectedRadio = radioConfig(radioSelect.value as SdrSpeedRadio);
      renderRadio();
    };

    const alive = () => !!overlay?.isConnected && running;
    const run = async () => {
      if (isFlowgraphRunning()) {
        status.textContent = 'Stop the running flowgraph before testing the SDR.';
        return;
      }
      const radio = selectedRadio;
      const plutoBufferSize = Number(bufferInput.value);
      if (radio.id === 'plutosdr' &&
          (!Number.isInteger(plutoBufferSize) || plutoBufferSize < 1 ||
           plutoBufferSize > MAX_PLUTO_BUFFER_SIZE)) {
        status.textContent =
          `Enter a PlutoSDR buffer size from 1 to ${MAX_PLUTO_BUFFER_SIZE} samples.`;
        bufferInput.focus();
        return;
      }
      let serial = deviceSelect.value;
      let device = serial
        ? devices.find(candidate => candidate.serialNumber === serial) || null
        : devices[0] || null;
      if (!devices.length) {
        try {
          // No await precedes requestDevice(), preserving the Run button's
          // transient user activation for the WebUSB chooser.
          device = await requestDevice(radio);
          serial = device?.serialNumber || '';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          return;
        }
      }
      if (!await rtlIsAccessible(radio, device)) return;

      running = true;
      runButton.textContent = 'Cancel';
      share.disabled = true; radioSelect.disabled = true;
      deviceSelect.disabled = true; rateSelect.disabled = true; bufferInput.disabled = true;
      gauge.update(0, Number(rateSelect.value)); setProgress(0);
      detail.textContent = '';
      status.textContent = `Starting the ${radio.name} receive flowgraph…`;

      const frame = document.createElement('iframe');
      frame.id = 'sdrSpeedFrame'; frame.title = 'SDR receive speed test runner';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:420px;height:280px;border:0;';
      document.body.appendChild(frame); speedFrame = frame;
      const target = Number(rateSelect.value);
      try {
        const result = await measureReceive(
          frame, radio, serial, target, plutoBufferSize, alive,
          (rate, fraction, reading) => {
            gauge.update(rate, target); setProgress(fraction);
            status.textContent = fraction < 0.02 ? 'Warming up…' :
              `Testing… ${Math.round(fraction * 100)}%`;
            detail.textContent = reading.overruns
              ? `${reading.overruns.toLocaleString()} receive overruns so far`
              : `${(rate * radio.bytesPerSample / 1e6).toFixed(1)} MB/s of ` +
                radio.iqDescription;
          });
        lastResults.set(radio.id, result);
        gauge.update(result.samplesPerSecond, target); setProgress(1);
        const utilization = result.actualRate > 0
          ? result.samplesPerSecond / result.actualRate * 100 : 0;
        status.textContent = `Complete: ${formatSdrRate(result.samplesPerSecond)}`;
        detail.textContent =
          `${(result.samplesPerSecond * radio.bytesPerSample / 1e6).toFixed(1)} MB/s IQ · ` +
          `${utilization.toFixed(1)}% of ${formatSdrRate(result.actualRate)}` +
          (radio.id === 'plutosdr'
            ? ` · ${plutoBufferSize.toLocaleString()} sample IIO buffer`
            : '') +
          (result.overruns
            ? ` · ${result.overruns.toLocaleString()} overruns, ` +
              `${result.lostSamples.toLocaleString()} samples dropped`
            : ' · no receive overruns');
        log(`${radio.name} receive speed test: ` +
          `${formatSdrRate(result.samplesPerSecond)} into GNU Radio World, ` +
          `${result.overruns} overruns` +
          (radio.id === 'plutosdr'
            ? `, ${plutoBufferSize} sample IIO buffer`
            : ''));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'cancelled') {
          if (overlay?.isConnected) status.textContent = 'Test cancelled.';
        } else {
          status.textContent = `Test failed: ${message}`;
          log(`${radio.name} receive speed test failed: ${message}`);
        }
      } finally {
        running = false;
        frame.src = 'about:blank'; frame.remove();
        if (speedFrame === frame) speedFrame = null;
        if (overlay?.isConnected) {
          runButton.disabled = false;
          runButton.textContent = 'Start Speed Test';
          share.disabled = false; radioSelect.disabled = false; rateSelect.disabled = false;
          bufferInput.disabled = selectedRadio.id !== 'plutosdr';
          renderDevices(serial);
        }
      }
    };

    runButton.onclick = () => {
      if (running) {
        running = false;
        runButton.disabled = true;
        status.textContent = 'Stopping…';
      } else {
        runButton.disabled = false;
        void run();
      }
    };

    renderRadio();
    rateSelect.onchange = () => {
      if (!running) gauge.update(
        lastResults.get(selectedRadio.id)?.samplesPerSecond || 0,
        Number(rateSelect.value));
    };
  }, true);

  const observer = new MutationObserver(() => {
    if (overlay && !overlay.isConnected) {
      running = false;
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
}
