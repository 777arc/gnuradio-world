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
true VM aliases. See [double-mapped-buffer.md](double-mapped-buffer.md).

## gr-qtgui

Not built by `gr/build-gr` (`ENABLE_GR_QTGUI=OFF`) — `qtgui/` compiles its
sources against Qt 6 instead — but they carry WASM guards too:

- `gr-qtgui/lib/displayform.cc`, `include/gnuradio/qtgui/form_menus.h` — the
  context menu and its dialogs use `popup()`/`open()` rather than `exec()`.
  `exec()` runs a nested event loop, which cannot block the browser main thread in
  a non-Asyncify build. The screenshot dialog keeps the captured pixmap alive and
  saves it from the dialog's accepted signal instead of after `exec()` returns.
- `gr-qtgui/lib/time_sink_c_impl.cc`, `time_sink_f_impl.cc` — drop an already
  queued update event before posting a new one, so a display that paints slower
  than the flowgraph produces shows the newest frame instead of accumulating
  latency.
- `gr-qtgui/lib/spectrumdisplayform.cc` — QT GUI Sink's FFT Size selector,
  reconnected under `QT_VERSION >= 6`. Its `.ui` file connects
  `QComboBox::activated(const QString&)`, an overload Qt6 removed; the connection
  is resolved by name at run time, so it costs one warning rather than a build
  error and leaves the selector doing nothing. The replacement uses the `int`
  overload both versions have. See also `qtgui/CMakeLists.txt`, where the same
  file needs `uic --connections string`.
- `gr-qtgui/lib/TimeDomainDisplayPlot.cc`, its header — `QwtPlotCanvas::ImmediatePaint`
  plus antialiasing off and `FilterPointsAggressive` on the curves; Qwt's backing
  pixmap and Qt's antialiased polyline rasterizer are both disproportionately
  expensive on the browser canvas.
