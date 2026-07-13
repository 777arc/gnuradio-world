cmake_minimum_required(VERSION 3.21)
project(gr_runner LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
qt_standard_project_setup()

set(GR /home/marc/gnuradio)
set(BUILDGR ${GR}/wasm/gr/build-gr)
set(SYSROOT ${GR}/wasm/sysroot)
set(QTGUI_TS ${GR}/wasm/qtgui/build/libgr_qtgui_ts.a)

qt_add_executable(runner src/runner.cpp src/registry.cpp)
target_include_directories(runner PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${GR}/gnuradio-runtime/include ${GR}/gr-blocks/include ${GR}/gr-fft/include
  ${GR}/gr-filter/include ${GR}/gr-analog/include ${GR}/gr-qtgui/include
  ${BUILDGR}/gnuradio-runtime/include ${SYSROOT}/include)

target_link_libraries(runner PRIVATE
  ${QTGUI_TS}
  ${BUILDGR}/gr-analog/lib/libgnuradio-analog.a
  ${BUILDGR}/gr-filter/lib/libgnuradio-filter.a
  ${BUILDGR}/gr-fft/lib/libgnuradio-fft.a
  ${BUILDGR}/gr-blocks/lib/libgnuradio-blocks.a
  ${BUILDGR}/gnuradio-runtime/lib/libgnuradio-runtime.a
  ${BUILDGR}/gnuradio-runtime/lib/pmt/libgnuradio-pmt.a
  ${SYSROOT}/lib/libqwt.a ${SYSROOT}/lib/libvolk.a
  ${SYSROOT}/lib/libfftw3f.a ${SYSROOT}/lib/libfftw3.a
  ${SYSROOT}/lib/libboost_thread.a ${SYSROOT}/lib/libboost_program_options.a
  ${SYSROOT}/lib/libboost_regex.a ${SYSROOT}/lib/libboost_chrono.a
  ${SYSROOT}/lib/libboost_atomic.a ${SYSROOT}/lib/libboost_date_time.a
  ${SYSROOT}/lib/libboost_system.a
  ${SYSROOT}/lib/libspdlog.a ${SYSROOT}/lib/libgmpxx.a ${SYSROOT}/lib/libgmp.a
  Qt6::Widgets Qt6::Gui Qt6::Core)

target_link_options(runner PRIVATE
  # Prewarm a large worker pool: GR runs one thread per block, and if start()
  # exhausts the pool it blocks the main browser thread creating a worker
  # (deadlock). Must cover Qt's threads + the largest flowgraph's block count.
  -sPTHREAD_POOL_SIZE=64 -sPTHREAD_POOL_SIZE_STRICT=0
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456
  -sNO_DISABLE_EXCEPTION_CATCHING
  -sEXPORTED_FUNCTIONS=_main,_gr_run_json,_free
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8,UTF8ToString
  # Diagnostics panel: injected into the page, survives Qt's html regeneration.
  --post-js ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)

# Rebuild the link step when the panel JS changes (--post-js isn't a tracked dep).
set_property(TARGET runner APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/diag.js)
