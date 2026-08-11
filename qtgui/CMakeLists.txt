cmake_minimum_required(VERSION 3.21)
project(gr_qtgui_timesink LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Port of gr-qtgui's TIME SINK only to Qt6 for WASM. The source is already Qt6-clean;
# gr-qtgui's own CMake is Qt5, so we build the needed sources standalone against Qt6.
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
set(CMAKE_AUTOMOC ON)

# GNU Radio is a submodule of the world repo. Keep its source root separate from
# the WebAssembly build/output directories; this mirrors runner/CMakeLists.txt.
get_filename_component(WORLD "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
if(DEFINED ENV{GR})
  set(GR $ENV{GR})
else()
  set(GR "${WORLD}/gnuradio")
endif()
set(GRQ ${GR}/gr-qtgui)
set(WASM_ROOT "${WORLD}")
set(BUILDGR ${WASM_ROOT}/gr/build-gr)
set(SYSROOT ${WASM_ROOT}/sysroot)

add_library(gr_qtgui_ts STATIC
  ${GRQ}/lib/DisplayPlot.cc
  ${GRQ}/lib/TimeDomainDisplayPlot.cc
  ${GRQ}/lib/displayform.cc
  ${GRQ}/lib/timedisplayform.cc
  ${GRQ}/lib/timecontrolpanel.cc
  ${GRQ}/lib/qtgui_util.cc
  ${GRQ}/lib/spectrumUpdateEvents.cc
  ${GRQ}/lib/time_sink_f_impl.cc
  ${GRQ}/lib/time_sink_c_impl.cc
  # frequency (spectrum) sink chain
  ${GRQ}/lib/FrequencyDisplayPlot.cc
  ${GRQ}/lib/freqdisplayform.cc
  ${GRQ}/lib/freqcontrolpanel.cc
  ${GRQ}/lib/freq_sink_c_impl.cc
  ${GRQ}/lib/freq_sink_f_impl.cc
  # constellation sink chain
  ${GRQ}/lib/ConstellationDisplayPlot.cc
  ${GRQ}/lib/constellationdisplayform.cc
  ${GRQ}/lib/const_sink_c_impl.cc
  # waterfall (spectrogram) sink chain
  ${GRQ}/lib/WaterfallDisplayPlot.cc
  ${GRQ}/lib/plot_waterfall.cc
  ${GRQ}/lib/waterfallGlobalData.cc
  ${GRQ}/lib/waterfalldisplayform.cc
  ${GRQ}/lib/waterfall_sink_c_impl.cc
  ${GRQ}/lib/waterfall_sink_f_impl.cc
  # message edit box -- the one GUI *control* upstream writes in C++ rather than
  # in Python, so unlike the rest of GRC's GUI Widgets/QT family it needs no
  # rebuild, only compiling for Qt6 (blocks/src/qtgui_controls.hpp has the rest).
  ${GRQ}/lib/edit_box_msg_impl.cc
  # Q_OBJECT headers listed so AUTOMOC generates their meta-object code
  # (multi-class headers like form_menus.h have no matching .cc).
  ${GRQ}/include/gnuradio/qtgui/DisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/TimeDomainDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/displayform.h
  ${GRQ}/include/gnuradio/qtgui/timedisplayform.h
  ${GRQ}/include/gnuradio/qtgui/timecontrolpanel.h
  ${GRQ}/include/gnuradio/qtgui/form_menus.h
  ${GRQ}/include/gnuradio/qtgui/spectrumUpdateEvents.h
  ${GRQ}/include/gnuradio/qtgui/FrequencyDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/freqdisplayform.h
  ${GRQ}/include/gnuradio/qtgui/freqcontrolpanel.h
  ${GRQ}/include/gnuradio/qtgui/ConstellationDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/constellationdisplayform.h
  ${GRQ}/include/gnuradio/qtgui/WaterfallDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/waterfalldisplayform.h
  ${GRQ}/lib/freq_sink_c_impl.h
  ${GRQ}/lib/freq_sink_f_impl.h
  ${GRQ}/lib/const_sink_c_impl.h
  ${GRQ}/lib/waterfall_sink_c_impl.h
  ${GRQ}/lib/waterfall_sink_f_impl.h
  ${GRQ}/lib/time_sink_f_impl.h
  ${GRQ}/lib/time_sink_c_impl.h
  ${GRQ}/lib/edit_box_msg_impl.h
)
target_include_directories(gr_qtgui_ts PUBLIC
  ${GRQ}/include ${GRQ}/lib
  ${GR}/gnuradio-runtime/include
  ${GR}/gr-blocks/include
  ${GR}/gr-fft/include
  ${GR}/gr-filter/include
  ${GR}/gr-analog/include
  ${BUILDGR}/gnuradio-runtime/include
  ${SYSROOT}/include                              # qwt headers
)
target_link_libraries(gr_qtgui_ts PUBLIC Qt6::Widgets Qt6::Gui Qt6::Core)
