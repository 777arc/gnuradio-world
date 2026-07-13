cmake_minimum_required(VERSION 3.21)
project(gr_qtgui_timesink LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Port of gr-qtgui's TIME SINK only to Qt6 for WASM. The source is already Qt6-clean;
# gr-qtgui's own CMake is Qt5, so we build the needed sources standalone against Qt6.
find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets)
set(CMAKE_AUTOMOC ON)

set(GRQ /home/marc/gnuradio/gr-qtgui)
set(GR  /home/marc/gnuradio)
set(BUILDGR /home/marc/gnuradio/wasm/gr/build-gr)

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
  ${GRQ}/lib/freq_sink_c_impl.h
  ${GRQ}/lib/freq_sink_f_impl.h
  ${GRQ}/lib/time_sink_f_impl.h
  ${GRQ}/lib/time_sink_c_impl.h
)
target_include_directories(gr_qtgui_ts PUBLIC
  ${GRQ}/include ${GRQ}/lib
  ${GR}/gnuradio-runtime/include
  ${GR}/gr-blocks/include
  ${GR}/gr-fft/include
  ${GR}/gr-filter/include
  ${GR}/gr-analog/include
  ${BUILDGR}/gnuradio-runtime/include
  /home/marc/gnuradio/wasm/sysroot/include        # qwt headers
)
target_link_libraries(gr_qtgui_ts PUBLIC Qt6::Widgets Qt6::Gui Qt6::Core)
