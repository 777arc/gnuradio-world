# Changes to the GNU Radio submodules

Every one is guarded by `#ifdef __EMSCRIPTEN__` or an equivalent CMake option, so
the desktop build is unaffected. Keep it that way: a change here that a native
build can see is a change that has to be justified upstream instead.

## `gnuradio/`

- `gnuradio-runtime/lib/thread/thread.cc` — `__EMSCRIPTEN__` branch (no
  prctl/affinity); `set_thread_name()` is a silent no-op there rather than an
  error log, which would otherwise fire once per block thread and show up in the
  runner's error banner.
- `gnuradio-runtime/lib/constants.cc.in` — fixed prefix under WASM (no
  `boost::dll`).
- `gnuradio-runtime/lib/CMakeLists.txt` — libunwind made optional. Configure with
  `-DCMAKE_DISABLE_FIND_PACKAGE_libunwind=ON`.
- `gnuradio-runtime/lib/pmt/CMakeLists.txt`, `gr-fft`, `gr-blocks`, `gr-analog`
  `lib/CMakeLists.txt` — register libs for install/export in static builds too.
- `gnuradio-runtime/lib/vmcircbuf.cc` — `__EMSCRIPTEN__` branch that returns the
  `vmcircbuf_emulated` factory directly instead of probing the mmap /
  shared-memory / temp-file backends, none of which can work in one flat linear
  memory (`all_factories()` is narrowed the same way).
- `gr-fft/lib/fft.cc` — use `FFTW_ESTIMATE` under WASM (`FFTW_MEASURE`
  benchmarking hangs there).

`vmcircbuf_emulated` is a contiguous 2N-byte software mirror that preserves the
native double-mapped scheduler and pointer behavior, then synchronizes completed
writes before publishing them to readers. It uses twice the physical buffer
memory and one mirror copy per produced byte, because WebAssembly cannot create
true VM aliases. Under Emscripten its factory reports byte granularity rather
than the 64 KiB WASM page size: ordinary contiguous storage needs no virtual-map
alignment, and page rounding would impose a 16,384-item minimum on float buffers.
See [double-mapped-buffer.md](double-mapped-buffer.md).

## gr-qtgui

Not built by `gr/build-gr` (`ENABLE_GR_QTGUI=OFF`) — upstream's integrated Qt 6
target still requires Python libraries when this cross-build has
`ENABLE_PYTHON=OFF`. `qtgui/` therefore builds the browser's selected upstream
Qt 6 sources as a standalone archive. They carry these WASM guards:

- `gr-qtgui/lib/displayform.cc`, `include/gnuradio/qtgui/form_menus.h` — the
  context menu and its dialogs use `popup()`/`open()` rather than `exec()`.
  `exec()` runs a nested event loop, which cannot block the browser main thread in
  a non-Asyncify build. The screenshot dialog keeps the captured pixmap alive and
  saves it from the dialog's accepted signal instead of after `exec()` returns.
- `gr-qtgui/lib/time_sink_c_impl.cc`, `time_sink_f_impl.cc` — drop an already
  queued update event before posting a new one, so a display that paints slower
  than the flowgraph produces shows the newest frame instead of accumulating
  latency.
- `gr-qtgui/lib/displayform.cc`, `lib/matrix_display.cc` — a plot's title is drawn
  *inside* its canvas, centered along the top, instead of in Qwt's title widget
  above it. A sink here is one tile of the runner's grid layout, so a title
  stacked on top of the canvas costs the trace real height and leaves a row of
  tiles with plots of differing sizes depending on which of them are named. Both
  call `wasm_qtgui::set_canvas_title()` in
  [`blocks/src/qtgui_plot_title.hpp`](../blocks/src/qtgui_plot_title.hpp), which
  attaches a `QwtPlotTextLabel` with a plate behind the text so it stays legible
  over a waterfall's colormap; `qtgui/CMakeLists.txt` puts `blocks/src` on the
  include path for it. `DisplayForm::setTitle` is the single funnel every
  DisplayForm-based sink's `set_title()` and its Title menu item go through;
  Matrix Sink has no DisplayForm and upstream shows its `name` nowhere at all, so
  its display sets the title once at construction.
- `gr-qtgui/lib/TimeDomainDisplayPlot.cc`, its header — `QwtPlotCanvas::ImmediatePaint`
  plus antialiasing off and `FilterPointsAggressive` on the curves; Qwt's backing
  pixmap and Qt's antialiased polyline rasterizer are both disproportionately
  expensive on the browser canvas.
