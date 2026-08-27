/**
 * Seeing and reading the running flowgraph's plots.
 *
 * Two ways to observe the same window, and they answer different questions.
 * `capturePlots()` takes a picture — the right instrument for "is this
 * constellation tight", "is the demodulator locked", anything about shape.
 * `readPlotData()` asks the sinks what they are plotting, as numbers — the right
 * instrument for "where exactly is the peak", which pixels answer badly and
 * expensively.
 *
 * The picture comes off Qt's own canvas rather than anything DOM-level: Qt for
 * WebAssembly draws the whole flowgraph window into one `canvas.qt-window-canvas`
 * inside an open shadow root, so a single readback is the entire GUI. The frame
 * is same-origin, so the canvas is untainted and `drawImage` across the document
 * boundary is allowed.
 *
 * Not captured: gr-fosphor's WebGPU display, which floats its own canvas over a
 * placeholder widget instead of drawing into Qt's (see fosphor_webgpu.js). Its
 * tile comes out empty, and the result says so rather than leaving a reader to
 * wonder what the blank rectangle was.
 */

export interface CaptureWidget {
  name: string;
  id: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface CaptureLayout {
  rect: { x: number; y: number; width: number; height: number };
  widgets: CaptureWidget[];
}

export interface CaptureDeps {
  frame(): HTMLIFrameElement;
  /** The runner's last `gr-widgets` report, or null before one arrives. */
  layout(): CaptureLayout | null;
}

/**
 * PNG, and only PNG. JPEG rings around the thin bright traces every one of
 * these plots is made of — and measured *larger* than PNG on a dense one — while
 * WebP is smaller than both but is not accepted by every model endpoint this
 * editor can be pointed at. A screenshot that a provider rejects is worse than
 * one that costs a few more kilobytes.
 */
const IMAGE_TYPE = 'image/png';

/**
 * Encoded bytes one capture may spend. The transcript is resent on every round
 * of a turn, so this is multiplied by however many rounds follow it; the widths
 * below step down until the image fits.
 */
const MAX_IMAGE_BYTES = 48_000;
const WIDTH_LADDER = [896, 768, 640, 512, 384];

/** Long enough for a waterfall to have drawn something, short enough to batch. */
const DEFAULT_SETTLE_SECONDS = 1;

export interface PlotCapture {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** The widget the image was cropped to, when one was asked for. */
  block?: string;
  widgets: { name: string; id: string }[];
  notes: string[];
}

export class CaptureError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('The operation was aborted.', 'AbortError'));
    return;
  }
  const abort = () => {
    window.clearTimeout(timer);
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  };
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

/**
 * The live runner window, or a refusal naming what is missing. Every path out of
 * here is a sentence a model can act on: run something, wait, add a GUI sink.
 */
function runnerWindow(deps: CaptureDeps): Window {
  const frame = deps.frame();
  let live: Window | null = null;
  try { live = frame.contentWindow; } catch { live = null; }
  if (!live || !live.location.search.startsWith('?recordingToken='))
    throw new CaptureError('nothing is running — call run_flowgraph first');
  return live;
}

function qtCanvas(live: Window): HTMLCanvasElement {
  const container = live.document.querySelector('#qt-shadow-container');
  const canvas = container?.shadowRoot?.querySelector<HTMLCanvasElement>(
    'canvas.qt-window-canvas');
  if (!canvas || !canvas.width || !canvas.height)
    throw new CaptureError(
      'the flowgraph window has not finished drawing yet — run it for longer first');
  return canvas;
}

/** Fosphor draws outside Qt's canvas, so its tile is a hole in the picture. */
const fosphorPresent = (live: Window) =>
  !!live.document.querySelector('canvas.gr-fosphor-webgpu');

export async function capturePlots(
  deps: CaptureDeps,
  options: { block?: string; settleSeconds?: number } = {},
  signal?: AbortSignal,
): Promise<PlotCapture> {
  const live = runnerWindow(deps);
  const settle = Math.min(5, Math.max(0, Number(
    options.settleSeconds ?? DEFAULT_SETTLE_SECONDS)));
  if (settle > 0) await sleep(settle * 1000, signal);

  const canvas = qtCanvas(live);
  const layout = deps.layout();
  const notes: string[] = [];

  // Qt reports geometry in the iframe's CSS pixels; the canvas backing store is
  // those times the device pixel ratio.
  const scale = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;

  let crop = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  let croppedTo: string | undefined;
  if (options.block) {
    const widget = layout?.widgets.find(entry => entry.name === options.block);
    if (!widget)
      throw new CaptureError(
        `no GUI widget named "${options.block}" is running` +
        (layout?.widgets.length
          ? `; this run has ${layout.widgets.map(w => `"${w.name}"`).join(', ')}`
          : ''));
    if (!widget.rect)
      throw new CaptureError(
        `the runner did not report where "${options.block}" is on screen`);
    crop = {
      x: widget.rect.x * scale, y: widget.rect.y * scale,
      width: widget.rect.width * scale, height: widget.rect.height * scale,
    };
    croppedTo = options.block;
  } else if (layout?.rect?.width && layout.rect.height) {
    // The grid area only: the window's title bar and the grey around it are
    // pixels that say nothing and are billed like the ones that do.
    crop = {
      x: layout.rect.x * scale, y: layout.rect.y * scale,
      width: layout.rect.width * scale, height: layout.rect.height * scale,
    };
  }

  // Clamp, so a widget that has been dragged partly off-screen still yields the
  // part that is on it rather than a zero-sized draw.
  crop.x = Math.max(0, Math.min(crop.x, canvas.width - 1));
  crop.y = Math.max(0, Math.min(crop.y, canvas.height - 1));
  crop.width = Math.max(1, Math.min(crop.width, canvas.width - crop.x));
  crop.height = Math.max(1, Math.min(crop.height, canvas.height - crop.y));

  if (fosphorPresent(live))
    notes.push('a fosphor display is in this window and does not appear in the ' +
               'image: it draws on its own canvas outside Qt\'s');

  // Native size first, then progressively smaller — never larger, which would
  // spend bytes on interpolation rather than on detail.
  const native = Math.max(1, Math.round(crop.width));
  const ladder = [native, ...WIDTH_LADDER.filter(width => width < native)];
  let best: { dataUrl: string; width: number; height: number; bytes: number } | null = null;
  for (const width of ladder) {
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(width));
    target.height = Math.max(1, Math.round(crop.height * (width / crop.width)));
    const context = target.getContext('2d');
    if (!context) throw new CaptureError('this browser refused a 2D canvas for the capture');
    context.imageSmoothingQuality = 'high';
    // The plots are drawn on a light background; a transparent margin would
    // otherwise composite against whatever the reader shows it on.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(canvas, crop.x, crop.y, crop.width, crop.height,
                      0, 0, target.width, target.height);
    let dataUrl: string;
    try {
      dataUrl = target.toDataURL(IMAGE_TYPE);
    } catch (error) {
      throw new CaptureError(
        `the flowgraph window could not be read back: ${
          error instanceof Error ? error.message : String(error)}`);
    }
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    best = { dataUrl, width: target.width, height: target.height, bytes };
    if (bytes <= MAX_IMAGE_BYTES) break;
  }
  if (!best) throw new CaptureError('the flowgraph window produced no image');
  if (best.bytes > MAX_IMAGE_BYTES)
    notes.push('this plot is detailed enough that shrinking it did not help; ' +
               'the image is larger than usual');

  return {
    ...best,
    ...(croppedTo ? { block: croppedTo } : {}),
    widgets: (layout?.widgets || []).map(widget => ({ name: widget.name, id: widget.id })),
    notes,
  };
}

/**
 * What the sinks are plotting, as numbers. Synchronous inside the frame — the
 * export builds the JSON on the browser main thread, which is the thread the
 * sinks repaint on, so no snapshot is ever half-written.
 */
export async function readPlotData(
  deps: CaptureDeps,
  options: { block?: string; points?: number; settleSeconds?: number } = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const live = runnerWindow(deps) as any;
  const settle = Math.min(5, Math.max(0, Number(options.settleSeconds ?? 0)));
  if (settle > 0) await sleep(settle * 1000, signal);
  if (typeof live.__grReadPlotData !== 'function')
    throw new CaptureError('this runner build cannot report plot data');

  const points = Math.min(256, Math.max(4, Math.round(Number(options.points) || 32)));
  const raw = live.__grReadPlotData(options.block || '', points);
  if (!raw) throw new CaptureError(
    'the flowgraph window has not finished starting — run it for longer first');
  let parsed: any;
  try { parsed = JSON.parse(String(raw)); } catch {
    throw new CaptureError('the runner returned unreadable plot data');
  }
  if (parsed?.error) throw new CaptureError(String(parsed.error));
  if (!parsed?.widgets?.length)
    throw new CaptureError(
      'this flowgraph has no GUI sink to read — add one (a QT GUI Frequency Sink, ' +
      'Time Sink or Constellation Sink), or use a Probe Signal, whose value is in ' +
      'the run_flowgraph report');
  return parsed;
}
