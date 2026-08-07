// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

// The editor's chrome font (editor/index.html), which the viewer's DOM picks up
// from the base rules in features/ui/styles/tailwind_index.css. Text drawn on a
// canvas -- konva labels on the spectrogram, the plot axes in
// features/ui/canvas-plot -- inherits nothing from CSS, so it names them here.
// 16px is the one text size the whole application uses; the only thing set
// larger anywhere is a flowgraph block's title.
export const APP_FONT_FAMILY = 'system-ui, Arial, sans-serif';
export const APP_FONT_SIZE = 16;

// Same story for color: konva draws the rulers and the minimap scrollbar onto
// the page chrome, where the editor's palette applies (see
// editor/tailwind.config.cjs). Overlays drawn *on the spectrogram* are not in
// this set -- they sit over an arbitrary colormap and keep their high-contrast
// white/red/blue.
export const APP_TEXT_COLOR = '#e6e9f0'; // base-content
export const APP_TICK_COLOR = '#9aa7c6'; // muted
export const APP_WELL_COLOR = '#171a24'; // field, the recessed track/placeholder
export const APP_MARK_COLOR = '#7783a4'; // scrollbar-thumb grey of the editor's splitters

export const MINIMUM_SCROLL_HANDLE_HEIGHT_PIXELS = 10;
export const COLORMAP_DEFAULT = 'viridis';

// How each spectrogram row is turned into magnitudes: one FFT per block of
// fftSize samples ('fft', see utils/selector), or a polyphase
// near-perfect-reconstruction filter bank of the same fftSize channels
// ('channelizer', see utils/channelizer). FFT stays the default -- it is what a
// reader coming from any other SDR tool expects to be looking at.
export type SpectrogramMethod = 'fft' | 'channelizer';
export const SPECTROGRAM_METHOD_DEFAULT: SpectrogramMethod = 'fft';
export const MINIMAP_FFT_SIZE = 64;
// One FFT per row of the minimap image, so this is its height in pixels -- and,
// since each row is its own ranged read, also the number of requests it costs.
// It is drawn stretched to the spectrogram height either way, so more rows buy
// vertical detail, not size.
export const MINIMAP_NUM_FFTS = 200;
// How many of those reads are allowed in flight at once. Every one of them is a
// single FFT's worth of bytes, so the wall clock is round trips, not bandwidth.
export const MINIMAP_MAX_CONCURRENT_FETCHES = 16;
export const FETCH_PADDING = 50; // how many extra ffts we fetch, in order to smooth scrolling
export const MIN_SPECTROGRAM_HEIGHT = 650;
// Below this the settings stack under the plot instead of sitting beside it.
// Keep it equal to tailwind's `md` breakpoint: the flex direction in
// recording-view.tsx is a `md:` variant, and the spectrogram sizing that has to
// agree with it is computed in JS, where a media query is not in reach.
export const NARROW_LAYOUT_WIDTH = 768;
// A phone is stacking the settings under the spectrogram, so 650px of plot
// would push every control below the fold.
export const MIN_STACKED_SPECTROGRAM_HEIGHT = 300;
