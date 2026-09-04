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
 * The runner exposes a renderer-neutral capture plan: Qt contributes its
 * window canvas, browser-native instruments contribute their own canvas
 * layers, and an unsupported renderer contributes an explicit note. The frame
 * is same-origin, so `drawImage` across the document boundary is allowed.
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

interface GuiCaptureLayer {
  source: HTMLCanvasElement;
  rect: { x: number; y: number; width: number; height: number };
  z?: number;
  widget?: string;
  provider?: string;
}

interface GuiCapturePlan {
  bounds?: { x: number; y: number; width: number; height: number };
  widgets: CaptureWidget[];
  layers: GuiCaptureLayer[];
  notes?: string[];
}

interface GuiObservationService {
  capturePlan(only?: string): GuiCapturePlan;
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
const WIDTH_LADDER = [896, 768, 640, 512, 384, 320, 256];

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

function observationService(live: Window): GuiObservationService {
  const service = (live as any).__grGuiObservation;
  if (!service || typeof service.capturePlan !== 'function')
    throw new CaptureError('this runner build cannot capture GUI widgets');
  return service;
}

type Rect = { x: number; y: number; width: number; height: number };

const validRect = (rect: Rect | undefined | null): rect is Rect => !!rect &&
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
  rect.width > 0 && rect.height > 0;

const intersection = (left: Rect, right: Rect): Rect | null => {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.width, right.x + right.width);
  const edgeY = Math.min(left.y + left.height, right.y + right.height);
  return edgeX > x && edgeY > y
    ? { x, y, width: edgeX - x, height: edgeY - y } : null;
};

/** Draw one renderer-owned canvas into a crop expressed entirely in CSS pixels. */
function drawLayer(
  layer: GuiCaptureLayer,
  target: HTMLCanvasElement,
  crop: Rect,
  notes: string[],
) {
  const context = target.getContext('2d');
  const overlap = intersection(layer.rect, crop);
  if (!context || !overlap || !layer.source.width || !layer.source.height) return;
  const sourceScaleX = layer.source.width / layer.rect.width;
  const sourceScaleY = layer.source.height / layer.rect.height;
  const outputScaleX = target.width / crop.width;
  const outputScaleY = target.height / crop.height;
  try {
    context.drawImage(
      layer.source,
      (overlap.x - layer.rect.x) * sourceScaleX,
      (overlap.y - layer.rect.y) * sourceScaleY,
      overlap.width * sourceScaleX,
      overlap.height * sourceScaleY,
      (overlap.x - crop.x) * outputScaleX,
      (overlap.y - crop.y) * outputScaleY,
      overlap.width * outputScaleX,
      overlap.height * outputScaleY,
    );
  } catch (error) {
    const note = `${layer.provider || 'a GUI renderer'} could not be captured: ${
      error instanceof Error ? error.message : String(error)}`;
    if (!notes.includes(note)) notes.push(note);
  }
}

export async function capturePlots(
  deps: CaptureDeps,
  options: { block?: string; settleSeconds?: number } = {},
  signal?: AbortSignal,
): Promise<PlotCapture> {
  const live = runnerWindow(deps);
  const settle = Math.min(5, Math.max(0, Number(
    options.settleSeconds ?? DEFAULT_SETTLE_SECONDS)));
  if (settle > 0) await sleep(settle * 1000, signal);

  const plan = observationService(live).capturePlan(options.block || '');
  const layout = deps.layout();
  const notes = [...(plan.notes || [])];
  const bounds = validRect(layout?.rect) ? layout.rect : plan.bounds;
  if (!validRect(bounds))
    throw new CaptureError(
      'the flowgraph window has not finished drawing yet — run it for longer first');

  let crop = { ...bounds };
  let croppedTo: string | undefined;
  if (options.block) {
    const available = plan.widgets.length ? plan.widgets : (layout?.widgets || []);
    const widget = available.find(entry => entry.name === options.block);
    if (!widget)
      throw new CaptureError(
        `no GUI widget named "${options.block}" is running` +
        (available.length
          ? `; this run has ${available.map(w => `"${w.name}"`).join(', ')}`
          : ''));
    if (!widget.rect)
      throw new CaptureError(
        `the runner did not report where "${options.block}" is on screen`);
    crop = { ...widget.rect };
    croppedTo = options.block;
  }

  // Clamp, so a widget partly outside the reported GUI area still yields its
  // visible portion rather than a zero-sized draw.
  crop = intersection(crop, bounds) || crop;

  const visibleLayers = plan.layers.filter(layer => intersection(layer.rect, crop));
  if (!visibleLayers.length)
    throw new CaptureError('the flowgraph window has no drawable GUI layer yet');

  // Preserve the sharpest renderer backing store that intersects this crop.
  // Qt and browser-native canvases may use different device-pixel ratios.
  const sourceScale = Math.max(1, ...visibleLayers.map(layer =>
    Math.max(layer.source.width / layer.rect.width,
             layer.source.height / layer.rect.height)));

  // Native size first, then progressively smaller — never larger, which would
  // spend bytes on interpolation rather than on detail.
  const native = Math.max(1, Math.round(crop.width * sourceScale));
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
    for (const layer of visibleLayers) drawLayer(layer, target, crop, notes);
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
    widgets: (plan.widgets.length ? plan.widgets : (layout?.widgets || []))
      .map(widget => ({ name: widget.name, id: widget.id })),
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
      'this flowgraph has no GUI sink to read — add a spectrum, time, or ' +
      'constellation display, or use a Probe Signal, whose value is in the ' +
      'run_flowgraph report');
  return parsed;
}
