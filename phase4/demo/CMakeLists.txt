cmake_minimum_required(VERSION 3.21)
project(phase4 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
qt_standard_project_setup()

set(GR /home/marc/gnuradio)
set(BUILDGR ${GR}/wasm/gr/build-gr)
set(SYSROOT ${GR}/wasm/sysroot)
set(QTGUI_TS ${GR}/wasm/phase4/qtgui/build/libgr_qtgui_ts.a)

# SysV-shm stubs (double-mapped vmcircbuf refs; never used with single-mapped).
add_library(shmstubs STATIC ${GR}/wasm/phase2/shm_stubs.c)

qt_add_executable(phase4 main.cpp)
target_compile_definitions(phase4 PRIVATE FORCE_SINGLE_MAPPED)
target_include_directories(phase4 PRIVATE
  ${GR}/gnuradio-runtime/include ${GR}/gr-blocks/include ${GR}/gr-fft/include
  ${GR}/gr-filter/include ${GR}/gr-analog/include ${GR}/gr-qtgui/include
  ${BUILDGR}/gnuradio-runtime/include ${SYSROOT}/include)

# GR module static libs (high-level first for static link resolution).
target_link_libraries(phase4 PRIVATE
  ${QTGUI_TS}
  ${BUILDGR}/gr-analog/lib/libgnuradio-analog.a
  ${BUILDGR}/gr-filter/lib/libgnuradio-filter.a
  ${BUILDGR}/gr-fft/lib/libgnuradio-fft.a
  ${BUILDGR}/gr-blocks/lib/libgnuradio-blocks.a
  ${BUILDGR}/gnuradio-runtime/lib/libgnuradio-runtime.a
  ${BUILDGR}/gnuradio-runtime/lib/pmt/libgnuradio-pmt.a
  ${SYSROOT}/lib/libqwt.a
  ${SYSROOT}/lib/libvolk.a
  ${SYSROOT}/lib/libfftw3f.a ${SYSROOT}/lib/libfftw3.a
  ${SYSROOT}/lib/libboost_thread.a ${SYSROOT}/lib/libboost_program_options.a
  ${SYSROOT}/lib/libboost_regex.a ${SYSROOT}/lib/libboost_chrono.a
  ${SYSROOT}/lib/libboost_atomic.a ${SYSROOT}/lib/libboost_date_time.a
  ${SYSROOT}/lib/libboost_system.a
  ${SYSROOT}/lib/libspdlog.a ${SYSROOT}/lib/libgmpxx.a ${SYSROOT}/lib/libgmp.a
  shmstubs
  Qt6::Widgets Qt6::Gui Qt6::Core)

# Enough worker threads for the GR blocks + Qt.
target_link_options(phase4 PRIVATE
  -sPTHREAD_POOL_SIZE=16 -sPTHREAD_POOL_SIZE_STRICT=0
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456
  # GNU Radio uses C++ exceptions, but Qt-for-WASM links with catching disabled.
  -sNO_DISABLE_EXCEPTION_CATCHING)
