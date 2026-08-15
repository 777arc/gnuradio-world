cmake_minimum_required(VERSION 3.21)
project(gr_qtgui_timesink LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Port of gr-qtgui's sink chains to Qt6 for WASM. The source is very nearly
# Qt6-clean; gr-qtgui's own CMake is Qt5, so we build the sinks we offer
# standalone against Qt6. What is left out is what has no C++ upstream at all --
# the gauges, the Number Sink and the rest of the Python QWidgets, which
# blocks/src/ rebuilds instead.
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

# spectrumdisplayform.h includes <spectrumdisplayform.ui.h>, which is not what
# uic (or AUTOUIC) names its output; upstream's own CMake copies ui_foo.h to
# foo.ui.h for the same reason. Run uic by hand rather than turning AUTOUIC on
# for the whole target, so the one Designer form in gr-qtgui does not impose a
# scan of every other source.
#
# `--connections string` is not cosmetic. The form's <connections> name slots of
# SpectrumDisplayForm, but the top-level widget's class in the .ui is plain
# QWidget, so setupUi() takes a QWidget*. Qt6's uic defaults to pointer-to-member
# connects, which then resolve against QWidget and fail to compile
# ("no member named 'maxHoldCheckBox_toggled' in 'QWidget'"); the string syntax is
# what Qt5's uic emitted, and it resolves through the meta-object at run time.
add_custom_command(
  OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/spectrumdisplayform.ui.h
  COMMAND Qt6::uic --connections string
          -o ${CMAKE_CURRENT_BINARY_DIR}/spectrumdisplayform.ui.h
          ${GRQ}/lib/spectrumdisplayform.ui
  DEPENDS ${GRQ}/lib/spectrumdisplayform.ui Qt6::uic
  COMMENT "uic spectrumdisplayform.ui -> spectrumdisplayform.ui.h")

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
  # eye diagram sink chain
  ${GRQ}/lib/EyeDisplayPlot.cc
  ${GRQ}/lib/eyedisplayform.cc
  ${GRQ}/lib/eyedisplaysform.cc
  ${GRQ}/lib/eyecontrolpanel.cc
  ${GRQ}/lib/eye_sink_c_impl.cc
  ${GRQ}/lib/eye_sink_f_impl.cc
  # histogram sink chain
  ${GRQ}/lib/HistogramDisplayPlot.cc
  ${GRQ}/lib/histogramdisplayform.cc
  ${GRQ}/lib/histogram_sink_f_impl.cc
  # time raster sink chain
  ${GRQ}/lib/TimeRasterDisplayPlot.cc
  ${GRQ}/lib/timerasterdisplayform.cc
  ${GRQ}/lib/timeRasterGlobalData.cc
  ${GRQ}/lib/plot_raster.cc
  ${GRQ}/lib/time_raster_sink_b_impl.cc
  ${GRQ}/lib/time_raster_sink_f_impl.cc
  # vector sink chain
  ${GRQ}/lib/VectorDisplayPlot.cc
  ${GRQ}/lib/vectordisplayform.cc
  ${GRQ}/lib/vector_sink_f_impl.cc
  # matrix sink (its own QwtPlotSpectrogram-based display, no displayform)
  ${GRQ}/lib/matrix_display.cc
  ${GRQ}/lib/matrix_sink_impl.cc
  # BER curve sink -- reuses the constellation display form to plot BER vs Es/No
  ${GRQ}/lib/ber_sink_b_impl.cc
  # the combined four-pane sink (freq + waterfall + time + constellation). Unlike
  # every other sink here it drives spectrumdisplayform, a Qt Designer form, so it
  # is the one that needs uic (see the custom command below).
  ${GRQ}/lib/SpectrumGUIClass.cc
  ${GRQ}/lib/spectrumdisplayform.cc
  ${GRQ}/lib/sink_c_impl.cc
  ${GRQ}/lib/sink_f_impl.cc
  ${CMAKE_CURRENT_BINARY_DIR}/spectrumdisplayform.ui.h
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
  ${GRQ}/include/gnuradio/qtgui/EyeDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/eyedisplayform.h
  ${GRQ}/include/gnuradio/qtgui/eyedisplaysform.h
  ${GRQ}/include/gnuradio/qtgui/eyecontrolpanel.h
  ${GRQ}/include/gnuradio/qtgui/HistogramDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/histogramdisplayform.h
  ${GRQ}/include/gnuradio/qtgui/TimeRasterDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/timerasterdisplayform.h
  ${GRQ}/include/gnuradio/qtgui/VectorDisplayPlot.h
  ${GRQ}/include/gnuradio/qtgui/vectordisplayform.h
  ${GRQ}/include/gnuradio/qtgui/spectrumdisplayform.h
  ${GRQ}/lib/matrix_display.h
  ${GRQ}/lib/matrix_display_signal.h
  ${GRQ}/lib/eye_sink_c_impl.h
  ${GRQ}/lib/eye_sink_f_impl.h
  ${GRQ}/lib/histogram_sink_f_impl.h
  ${GRQ}/lib/time_raster_sink_b_impl.h
  ${GRQ}/lib/time_raster_sink_f_impl.h
  ${GRQ}/lib/vector_sink_f_impl.h
  ${GRQ}/lib/matrix_sink_impl.h
  ${GRQ}/lib/ber_sink_b_impl.h
  ${GRQ}/lib/sink_c_impl.h
  ${GRQ}/lib/sink_f_impl.h
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
  ${WASM_ROOT}/blocks/src                         # qtgui_plot_title.hpp
  ${CMAKE_CURRENT_BINARY_DIR}                     # spectrumdisplayform.ui.h
  ${GR}/gnuradio-runtime/include
  ${GR}/gr-blocks/include
  ${GR}/gr-fft/include
  ${GR}/gr-filter/include
  ${GR}/gr-analog/include
  ${BUILDGR}/gnuradio-runtime/include
  ${SYSROOT}/include                              # qwt headers
)
target_link_libraries(gr_qtgui_ts PUBLIC Qt6::Widgets Qt6::Gui Qt6::Core)
