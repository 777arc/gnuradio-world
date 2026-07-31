// A small 2D-canvas XY plot, written for this repo to take the place of the
// react-plotly.js `<Plot>` the Time / Frequency / IQ tabs used upstream.
//
// It is deliberately a lookalike rather than a general charting library: the
// colors, margins, tick style, hover readout, mode bar and range slider all
// mirror what plotly rendered with @/utils/plotlyTemplate, because that is the
// styling the rest of the recording view was built around. What it does NOT try
// to be is plotly -- there is no trace type beyond lines and markers, no
// subplots, no annotations.
//
// Why replace it at all: plotly.js is ~4.7 MB minified, several times the whole
// rest of this viewer, and these three tabs used one trace type from it.
//
// Dense traces are drawn with min/max decimation -- one vertical segment per
// pixel column spanning the extremes of the samples that land there. That is
// what keeps a 650k-point time series (spectrogramHeight * fftSize samples) at a
// few milliseconds a frame while looking identical to the full polyline.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// ---- theme (from @/utils/plotlyTemplate, so the plots keep matching the app) --
const PLOT_BG = '#05041C';
const GRID = '#283442';
const AXIS_LINE = '#506784';
const FONT_COLOR = '#f2f5fa';
const MUTED = '#a8b0c0';
const FONT_FAMILY = '"Open Sans", verdana, arial, sans-serif';
export const COLORWAY = [
  '#4CE091',
  '#84cae7',
  '#136f63',
  '#ab63fa',
  '#FFA15A',
  '#19d3f3',
  '#FF6692',
  '#B6E880',
  '#FF97FF',
  '#FECB52',
];

export interface PlotTrace {
  /** x values; omit for a plain index axis (0, 1, 2, ...), as plotly does. */
  x?: ArrayLike<number>;
  y: ArrayLike<number>;
  name?: string;
  color?: string;
  mode?: 'lines' | 'markers';
  markerSize?: number;
}

export interface CanvasPlotProps {
  traces: PlotTrace[];
  width: number;
  height: number;
  xTitle?: string;
  yTitle?: string;
  showLegend?: boolean;
  /** Zoom and pan act on x only, matching plotly's `yaxis: { fixedrange: true }`. */
  yFixedRange?: boolean;
  /** Overview strip with a draggable window, like plotly's `rangeslider: {}`. */
  rangeSlider?: boolean;
  /** Extra fraction of the x span to leave either side (markers want some). */
  xPad?: number;
}

interface Range {
  min: number;
  max: number;
}
interface Extent {
  x: Range;
  y: Range;
}
interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const MARGIN = { left: 64, right: 18, top: 18 };
const TICK_LABEL_H = 22;
const TITLE_H = 22;
const SLIDER_H = 44;
const SLIDER_GAP = 6;
const SLIDER_HANDLE_W = 8;

const finite = (value: number) => Number.isFinite(value);

// ---- data extent -------------------------------------------------------------
function computeExtent(traces: PlotTrace[]): Extent {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const trace of traces) {
    const { x, y } = trace;
    if (!y || !y.length) continue;
    for (let i = 0; i < y.length; i++) {
      const yv = y[i];
      // The spectrogram fills rows it has not fetched with -Infinity, and a
      // magnitude of zero becomes -Infinity in dB, so non-finite is normal here
      // and must never drag an axis to infinity.
      if (!finite(yv)) continue;
      if (yv < yMin) yMin = yv;
      if (yv > yMax) yMax = yv;
      const xv = x ? x[i] : i;
      if (!finite(xv)) continue;
      if (xv < xMin) xMin = xv;
      if (xv > xMax) xMax = xv;
    }
  }
  if (!finite(xMin) || !finite(xMax)) {
    xMin = 0;
    xMax = 1;
  }
  if (!finite(yMin) || !finite(yMax)) {
    yMin = 0;
    yMax = 1;
  }
  return { x: { min: xMin, max: xMax }, y: { min: yMin, max: yMax } };
}

// Plotly leaves a little air above and below a trace but fits x exactly, except
// for marker traces where the outermost points would otherwise sit on the frame.
function autoView(extent: Extent, xPad: number): View {
  const xSpan = extent.x.max - extent.x.min || 1;
  const ySpan = extent.y.max - extent.y.min || 1;
  return {
    x0: extent.x.min - xSpan * xPad,
    x1: extent.x.max + xSpan * xPad,
    y0: extent.y.min - ySpan * 0.06,
    y1: extent.y.max + ySpan * 0.06,
  };
}

// ---- ticks -------------------------------------------------------------------
function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1;
  const rough = span / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function ticksFor(min: number, max: number, target: number): { values: number[]; step: number } {
  const step = niceStep(max - min, target);
  const values: number[] = [];
  // A tiny epsilon keeps a tick that lands exactly on the edge from being lost
  // to floating point, which otherwise makes the axis flicker while panning.
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) values.push(v);
  return { values, step };
}

// Shared SI suffix across a whole axis, the way plotly labels 20000000 as "20M".
function makeFormatter(values: number[], step: number): (value: number) => string {
  let scale = 1;
  let suffix = '';
  const maxAbs = values.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
  if (maxAbs >= 1e9) {
    scale = 1e9;
    suffix = 'G';
  } else if (maxAbs >= 1e6) {
    scale = 1e6;
    suffix = 'M';
  } else if (maxAbs >= 1e3) {
    scale = 1e3;
    suffix = 'k';
  }
  const scaledStep = step / scale;
  const decimals = scaledStep >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(scaledStep)));
  return (value: number) => {
    // Number() rather than the raw toFixed string, so 5.00 prints as 5 and the
    // sign of a rounded-to-zero tick does not show up as "-0".
    const scaled = Number((value / scale).toFixed(decimals));
    return `${scaled === 0 ? 0 : scaled}${suffix}`;
  };
}

// ---- drawing -----------------------------------------------------------------
interface Geometry {
  plotX: number;
  plotY: number;
  plotW: number;
  plotH: number;
  sliderY: number;
  sliderH: number;
}

function geometryFor(width: number, height: number, xTitle: boolean, rangeSlider: boolean): Geometry {
  const titleH = xTitle ? TITLE_H : 0;
  const sliderH = rangeSlider ? SLIDER_H : 0;
  const sliderGap = rangeSlider ? SLIDER_GAP : 0;
  const plotH = Math.max(40, height - MARGIN.top - TICK_LABEL_H - sliderGap - sliderH - titleH);
  return {
    plotX: MARGIN.left,
    plotY: MARGIN.top,
    plotW: Math.max(20, width - MARGIN.left - MARGIN.right),
    plotH,
    sliderY: MARGIN.top + plotH + TICK_LABEL_H + sliderGap,
    sliderH,
  };
}

// One vertical segment per pixel column spanning the min and max of whatever
// landed in it. Falls back to a plain polyline when the trace is sparse enough
// that decimation would be visible.
function strokeTrace(
  ctx: CanvasRenderingContext2D,
  trace: PlotTrace,
  view: View,
  geo: { x: number; y: number; w: number; h: number }
) {
  const { x, y } = trace;
  if (!y || !y.length) return;
  const xSpan = view.x1 - view.x0 || 1;
  const ySpan = view.y1 - view.y0 || 1;
  const toPx = (value: number) => geo.x + ((value - view.x0) / xSpan) * geo.w;
  const toPy = (value: number) => geo.y + geo.h - ((value - view.y0) / ySpan) * geo.h;

  ctx.beginPath();
  if (y.length <= geo.w * 2) {
    let started = false;
    for (let i = 0; i < y.length; i++) {
      const yv = y[i];
      if (!finite(yv)) {
        started = false; // a gap, not a line down to nowhere
        continue;
      }
      const px = toPx(x ? x[i] : i);
      const py = toPy(yv);
      if (started) ctx.lineTo(px, py);
      else {
        ctx.moveTo(px, py);
        started = true;
      }
    }
  } else {
    const columns = Math.ceil(geo.w);
    const mins = new Float64Array(columns).fill(NaN);
    const maxs = new Float64Array(columns).fill(NaN);
    for (let i = 0; i < y.length; i++) {
      const yv = y[i];
      if (!finite(yv)) continue;
      const column = Math.floor(((x ? x[i] : i) - view.x0) / xSpan * geo.w);
      if (column < 0 || column >= columns) continue;
      if (Number.isNaN(mins[column])) {
        mins[column] = yv;
        maxs[column] = yv;
      } else {
        if (yv < mins[column]) mins[column] = yv;
        if (yv > maxs[column]) maxs[column] = yv;
      }
    }
    let started = false;
    for (let column = 0; column < columns; column++) {
      if (Number.isNaN(mins[column])) continue;
      const px = geo.x + column + 0.5;
      const top = toPy(maxs[column]);
      const bottom = toPy(mins[column]);
      if (started) ctx.lineTo(px, top);
      else {
        ctx.moveTo(px, top);
        started = true;
      }
      ctx.lineTo(px, bottom);
    }
  }
  ctx.stroke();
}

function fillMarkers(
  ctx: CanvasRenderingContext2D,
  trace: PlotTrace,
  view: View,
  geo: { x: number; y: number; w: number; h: number }
) {
  const { x, y } = trace;
  if (!y || !y.length) return;
  const radius = (trace.markerSize ?? 3) / 2;
  const xSpan = view.x1 - view.x0 || 1;
  const ySpan = view.y1 - view.y0 || 1;
  ctx.beginPath();
  for (let i = 0; i < y.length; i++) {
    const yv = y[i];
    const xv = x ? x[i] : i;
    if (!finite(yv) || !finite(xv)) continue;
    const px = geo.x + ((xv - view.x0) / xSpan) * geo.w;
    const py = geo.y + geo.h - ((yv - view.y0) / ySpan) * geo.h;
    if (px < geo.x - radius || px > geo.x + geo.w + radius) continue;
    if (py < geo.y - radius || py > geo.y + geo.h + radius) continue;
    ctx.moveTo(px + radius, py);
    ctx.arc(px, py, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

// ---- component ---------------------------------------------------------------
export const CanvasPlot = ({
  traces,
  width,
  height,
  xTitle,
  yTitle,
  showLegend = false,
  yFixedRange = false,
  rangeSlider = false,
  xPad = 0,
}: CanvasPlotProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View | null>(null);
  // Plotly's `uirevision`: once the reader has zoomed or panned, new data must
  // not yank the axes back out from under them.
  const [userAdjusted, setUserAdjusted] = useState(false);
  const [hover, setHover] = useState<{ px: number; py: number } | null>(null);

  // Recompute the data extent only when the underlying arrays actually change.
  // The parents rebuild the traces array on every render, so keying off it
  // directly would rescan a million samples for a mouse move.
  const extentRef = useRef<{ arrays: unknown[]; extent: Extent } | null>(null);
  const arrays: unknown[] = [];
  for (const trace of traces) arrays.push(trace.x, trace.y);
  const cached = extentRef.current;
  if (!cached || cached.arrays.length !== arrays.length || arrays.some((a, i) => a !== cached.arrays[i])) {
    extentRef.current = { arrays, extent: computeExtent(traces) };
  }
  const extent = extentRef.current!.extent;

  const autoscale = useCallback(() => {
    setView(autoView(extent, xPad));
    setUserAdjusted(false);
  }, [extent, xPad]);

  // Autorange while the reader has not taken control, exactly as plotly does.
  useEffect(() => {
    if (!userAdjusted) setView(autoView(extent, xPad));
  }, [extent, xPad, userAdjusted]);

  const geo = geometryFor(width, height, !!xTitle, rangeSlider);
  const tracesRef = useRef(traces);
  tracesRef.current = traces;
  const viewRef = useRef(view);
  viewRef.current = view;

  // ---- painting --------------------------------------------------------------
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    // The recording view derives these from useWindowSize(), which reports 0
    // until it has measured, so width arrives as `0 - 430` on the first pass.
    // A negative canvas size is not merely useless, it throws.
    if (!canvas || !view || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = PLOT_BG;
    ctx.fillRect(0, 0, width, height);

    const { plotX, plotY, plotW, plotH } = geo;
    const xTicks = ticksFor(view.x0, view.x1, Math.max(2, Math.round(plotW / 110)));
    const yTicks = ticksFor(view.y0, view.y1, Math.max(2, Math.round(plotH / 60)));
    const formatX = makeFormatter(xTicks.values, xTicks.step);
    const formatY = makeFormatter(yTicks.values, yTicks.step);
    const toPx = (value: number) => plotX + ((value - view.x0) / (view.x1 - view.x0 || 1)) * plotW;
    const toPy = (value: number) => plotY + plotH - ((value - view.y0) / (view.y1 - view.y0 || 1)) * plotH;

    // grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    for (const value of xTicks.values) {
      const px = Math.round(toPx(value)) + 0.5;
      if (px < plotX || px > plotX + plotW) continue;
      ctx.moveTo(px, plotY);
      ctx.lineTo(px, plotY + plotH);
    }
    for (const value of yTicks.values) {
      const py = Math.round(toPy(value)) + 0.5;
      if (py < plotY || py > plotY + plotH) continue;
      ctx.moveTo(plotX, py);
      ctx.lineTo(plotX + plotW, py);
    }
    ctx.stroke();

    // zero lines, which the template draws heavier than the grid
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (view.y0 < 0 && view.y1 > 0) {
      const py = Math.round(toPy(0)) + 0.5;
      ctx.moveTo(plotX, py);
      ctx.lineTo(plotX + plotW, py);
    }
    if (view.x0 < 0 && view.x1 > 0) {
      const px = Math.round(toPx(0)) + 0.5;
      ctx.moveTo(px, plotY);
      ctx.lineTo(px, plotY + plotH);
    }
    ctx.stroke();

    // traces, clipped to the plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, plotY, plotW, plotH);
    ctx.clip();
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    traces.forEach((trace, index) => {
      const color = trace.color ?? COLORWAY[index % COLORWAY.length];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      if (trace.mode === 'markers') fillMarkers(ctx, trace, view, { x: plotX, y: plotY, w: plotW, h: plotH });
      else strokeTrace(ctx, trace, view, { x: plotX, y: plotY, w: plotW, h: plotH });
    });
    ctx.restore();

    // axis frame
    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_LINE;
    ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW - 1, plotH - 1);

    // tick labels
    ctx.fillStyle = MUTED;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const value of xTicks.values) {
      const px = toPx(value);
      if (px < plotX - 1 || px > plotX + plotW + 1) continue;
      ctx.fillText(formatX(value), px, plotY + plotH + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const value of yTicks.values) {
      const py = toPy(value);
      if (py < plotY - 1 || py > plotY + plotH + 1) continue;
      ctx.fillText(formatY(value), plotX - 8, py);
    }

    // axis titles
    ctx.fillStyle = FONT_COLOR;
    ctx.font = `13px ${FONT_FAMILY}`;
    if (xTitle) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(xTitle, plotX + plotW / 2, height - 4);
    }
    if (yTitle) {
      ctx.save();
      ctx.translate(14, plotY + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(yTitle, 0, 0);
      ctx.restore();
    }

    // range slider: the whole data extent with the current window picked out
    if (rangeSlider && geo.sliderH > 0) {
      const full = autoView(extent, xPad);
      const sliderView: View = { x0: full.x0, x1: full.x1, y0: full.y0, y1: full.y1 };
      ctx.fillStyle = '#0b0a26';
      ctx.fillRect(plotX, geo.sliderY, plotW, geo.sliderH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, geo.sliderY, plotW, geo.sliderH);
      ctx.clip();
      ctx.lineWidth = 1;
      traces.forEach((trace, index) => {
        const color = trace.color ?? COLORWAY[index % COLORWAY.length];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        const box = { x: plotX, y: geo.sliderY + 3, w: plotW, h: geo.sliderH - 6 };
        if (trace.mode === 'markers') fillMarkers(ctx, trace, sliderView, box);
        else strokeTrace(ctx, trace, sliderView, box);
      });
      ctx.restore();
      const span = sliderView.x1 - sliderView.x0 || 1;
      const left = plotX + ((view.x0 - sliderView.x0) / span) * plotW;
      const right = plotX + ((view.x1 - sliderView.x0) / span) * plotW;
      // Mask what is outside the window, then outline it and its two handles.
      ctx.fillStyle = 'rgba(5, 4, 28, 0.72)';
      ctx.fillRect(plotX, geo.sliderY, Math.max(0, left - plotX), geo.sliderH);
      ctx.fillRect(Math.min(right, plotX + plotW), geo.sliderY, Math.max(0, plotX + plotW - right), geo.sliderH);
      ctx.strokeStyle = AXIS_LINE;
      ctx.strokeRect(plotX + 0.5, geo.sliderY + 0.5, plotW - 1, geo.sliderH - 1);
      ctx.fillStyle = '#f2f5fa';
      ctx.fillRect(left - SLIDER_HANDLE_W / 2, geo.sliderY, SLIDER_HANDLE_W / 2, geo.sliderH);
      ctx.fillRect(right, geo.sliderY, SLIDER_HANDLE_W / 2, geo.sliderH);
    }

    // legend, top-right inside the plot area like plotly's default
    if (showLegend) {
      const named = traces.filter((trace) => trace.name);
      if (named.length) {
        ctx.font = `12px ${FONT_FAMILY}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const rowH = 18;
        const boxW =
          28 + named.reduce((acc, trace) => Math.max(acc, ctx.measureText(trace.name!).width), 0) + 10;
        const boxH = named.length * rowH + 8;
        const boxX = plotX + plotW - boxW - 8;
        const boxY = plotY + 8;
        ctx.fillStyle = 'rgba(5, 4, 28, 0.7)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        named.forEach((trace, index) => {
          const color = trace.color ?? COLORWAY[traces.indexOf(trace) % COLORWAY.length];
          const y = boxY + 4 + rowH * index + rowH / 2;
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(boxX + 8, y);
          ctx.lineTo(boxX + 24, y);
          ctx.stroke();
          ctx.fillStyle = FONT_COLOR;
          ctx.fillText(trace.name!, boxX + 30, y);
        });
      }
    }

    // hover crosshair and readout
    if (hover && hover.px >= plotX && hover.px <= plotX + plotW && hover.py >= plotY && hover.py <= plotY + plotH) {
      const xValue = view.x0 + ((hover.px - plotX) / plotW) * (view.x1 - view.x0);
      ctx.save();
      ctx.strokeStyle = 'rgba(242, 245, 250, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.px) + 0.5, plotY);
      ctx.lineTo(Math.round(hover.px) + 0.5, plotY + plotH);
      ctx.stroke();
      ctx.restore();

      const rows: { text: string; color: string }[] = [];
      for (let index = 0; index < traces.length; index++) {
        const trace = traces[index];
        if (!trace.y || !trace.y.length) continue;
        const sample = sampleAt(trace, xValue);
        if (sample === null) continue;
        rows.push({
          text: `${trace.name ? `${trace.name}: ` : ''}${formatReadout(sample)}`,
          color: trace.color ?? COLORWAY[index % COLORWAY.length],
        });
      }
      if (rows.length) {
        ctx.font = `12px ${FONT_FAMILY}`;
        const header = `${xTitle ?? 'x'}: ${formatReadout(xValue)}`;
        const textW = Math.max(
          ctx.measureText(header).width,
          ...rows.map((row) => ctx.measureText(row.text).width + 14)
        );
        const boxW = textW + 16;
        const boxH = 8 + (rows.length + 1) * 16;
        const boxX = Math.min(hover.px + 12, plotX + plotW - boxW - 2);
        const boxY = Math.min(Math.max(hover.py - boxH / 2, plotY + 2), plotY + plotH - boxH - 2);
        ctx.fillStyle = 'rgba(5, 4, 28, 0.92)';
        ctx.strokeStyle = AXIS_LINE;
        ctx.lineWidth = 1;
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = MUTED;
        ctx.fillText(header, boxX + 8, boxY + 12);
        rows.forEach((row, index) => {
          const y = boxY + 12 + 16 * (index + 1);
          ctx.fillStyle = row.color;
          ctx.fillRect(boxX + 8, y - 3, 6, 6);
          ctx.fillStyle = FONT_COLOR;
          ctx.fillText(row.text, boxX + 20, y);
        });
      }
    }
  }, [traces, view, width, height, xTitle, yTitle, showLegend, rangeSlider, hover, extent, xPad, geo]);

  // ---- interaction -----------------------------------------------------------
  const dragRef = useRef<
    | { kind: 'pan'; px: number; py: number; view: View }
    | { kind: 'slider-move' | 'slider-left' | 'slider-right'; px: number; view: View }
    | null
  >(null);

  const localPoint = (event: React.MouseEvent | MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };

  const inSlider = (py: number) => rangeSlider && py >= geo.sliderY && py <= geo.sliderY + geo.sliderH;

  const onMouseDown = (event: React.MouseEvent) => {
    if (!view) return;
    const { px, py } = localPoint(event);
    if (inSlider(py)) {
      const full = autoView(extent, xPad);
      const span = full.x1 - full.x0 || 1;
      const left = geo.plotX + ((view.x0 - full.x0) / span) * geo.plotW;
      const right = geo.plotX + ((view.x1 - full.x0) / span) * geo.plotW;
      const kind =
        Math.abs(px - left) <= SLIDER_HANDLE_W
          ? 'slider-left'
          : Math.abs(px - right) <= SLIDER_HANDLE_W
            ? 'slider-right'
            : 'slider-move';
      dragRef.current = { kind, px, view };
      setUserAdjusted(true);
      event.preventDefault();
      return;
    }
    dragRef.current = { kind: 'pan', px, py, view };
    event.preventDefault();
  };

  useEffect(() => {
    if (!view) return;
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      if (drag.kind === 'pan') {
        const dx = ((px - drag.px) / geo.plotW) * (drag.view.x1 - drag.view.x0);
        const dy = ((py - drag.py) / geo.plotH) * (drag.view.y1 - drag.view.y0);
        setUserAdjusted(true);
        setView(
          yFixedRange
            ? { ...drag.view, x0: drag.view.x0 - dx, x1: drag.view.x1 - dx }
            : {
                x0: drag.view.x0 - dx,
                x1: drag.view.x1 - dx,
                y0: drag.view.y0 + dy,
                y1: drag.view.y1 + dy,
              }
        );
        return;
      }
      const full = autoView(extent, xPad);
      const span = full.x1 - full.x0 || 1;
      const delta = ((px - drag.px) / geo.plotW) * span;
      if (drag.kind === 'slider-move') {
        setView({ ...drag.view, x0: drag.view.x0 + delta, x1: drag.view.x1 + delta });
      } else if (drag.kind === 'slider-left') {
        const x0 = Math.min(drag.view.x0 + delta, drag.view.x1 - span / 1000);
        setView({ ...drag.view, x0 });
      } else {
        const x1 = Math.max(drag.view.x1 + delta, drag.view.x0 + span / 1000);
        setView({ ...drag.view, x1 });
      }
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [view, geo, yFixedRange, extent, xPad]);

  // Wheel zoom about the cursor. Registered by hand and non-passive, because
  // React's synthetic onWheel is passive and cannot preventDefault the page
  // scroll -- the recording view is in an iframe and would scroll instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const current = viewRef.current;
      if (!current) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      if (px < geo.plotX || px > geo.plotX + geo.plotW || py < geo.plotY || py > geo.plotY + geo.plotH) return;
      event.preventDefault();
      const factor = Math.pow(1.0015, event.deltaY);
      const ax = (px - geo.plotX) / geo.plotW;
      const ay = 1 - (py - geo.plotY) / geo.plotH;
      const xAt = current.x0 + ax * (current.x1 - current.x0);
      const yAt = current.y0 + ay * (current.y1 - current.y0);
      setUserAdjusted(true);
      setView({
        x0: xAt - (xAt - current.x0) * factor,
        x1: xAt + (current.x1 - xAt) * factor,
        y0: yFixedRange ? current.y0 : yAt - (yAt - current.y0) * factor,
        y1: yFixedRange ? current.y1 : yAt + (current.y1 - yAt) * factor,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [geo, yFixedRange]);

  const zoomBy = (factor: number) => {
    const current = viewRef.current;
    if (!current) return;
    const cx = (current.x0 + current.x1) / 2;
    const cy = (current.y0 + current.y1) / 2;
    setUserAdjusted(true);
    setView({
      x0: cx - ((cx - current.x0) * factor),
      x1: cx + ((current.x1 - cx) * factor),
      y0: yFixedRange ? current.y0 : cy - (cy - current.y0) * factor,
      y1: yFixedRange ? current.y1 : cy + (current.y1 - cy) * factor,
    });
  };

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'plot.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  return (
    <div className="relative group" style={{ width: Math.max(0, width), height: Math.max(0, height) }}>
      <canvas
        ref={canvasRef}
        style={{
          width: Math.max(0, width),
          height: Math.max(0, height),
          cursor: dragRef.current ? 'grabbing' : 'crosshair',
          display: 'block',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={(event) => setHover(localPoint(event))}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={autoscale}
      />
      <div className="absolute top-1 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <ModeBarButton title="Download plot as a png" onClick={downloadPng}>
          <path d="M2 5h2.5l1-1.5h3L9.5 5H12v6H2V5zm5 5a2 2 0 100-4 2 2 0 000 4z" />
        </ModeBarButton>
        <ModeBarButton title="Zoom in" onClick={() => zoomBy(0.5)}>
          <path d="M7 3v8M3 7h8" />
        </ModeBarButton>
        <ModeBarButton title="Zoom out" onClick={() => zoomBy(2)}>
          <path d="M3 7h8" />
        </ModeBarButton>
        <ModeBarButton title="Autoscale" onClick={autoscale}>
          <path d="M2 5V2h3M12 9v3H9M2 9v3h3M12 5V2H9" />
        </ModeBarButton>
      </div>
    </div>
  );
};

const ModeBarButton = ({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    // !bg-transparent because the app's base layer styles every <button> as a
    // filled primary button, which is not what a mode bar icon should look like.
    className="!bg-transparent !p-0 !shadow-none w-6 h-6 flex items-center justify-center text-base-content/60 hover:!text-primary"
  >
    <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4">
      {children}
    </svg>
  </button>
);

// Nearest sample of a trace at an x value; assumes x is ascending when present,
// which holds for the index and frequency axes these plots use.
function sampleAt(trace: PlotTrace, xValue: number): number | null {
  const { x, y } = trace;
  if (!y || !y.length) return null;
  let index: number;
  if (!x) index = Math.round(xValue);
  else {
    let lo = 0;
    let hi = x.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x[mid] < xValue) lo = mid + 1;
      else hi = mid;
    }
    index = lo > 0 && Math.abs(x[lo - 1] - xValue) < Math.abs(x[lo] - xValue) ? lo - 1 : lo;
  }
  if (index < 0 || index >= y.length) return null;
  const value = y[index];
  return finite(value) ? value : null;
}

function formatReadout(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${Number((value / 1e9).toFixed(4))}G`;
  if (abs >= 1e6) return `${Number((value / 1e6).toFixed(4))}M`;
  if (abs >= 1e3) return `${Number((value / 1e3).toFixed(4))}k`;
  if (abs === 0) return '0';
  if (abs < 1e-3) return value.toExponential(3);
  return `${Number(value.toFixed(5))}`;
}

export default CanvasPlot;
