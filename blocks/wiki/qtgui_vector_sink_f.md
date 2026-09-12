<!-- block: qtgui_vector_sink_f -->
<!-- title: QT GUI Vector Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Vector_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This is a QT-based graphical sink that plots vectors of data as-is. Each signal is plotted with a different color.

## Parameters
(R): Run-time adjustable

- Name
  Title for the plot

- Vector Size
  Vector length at input

- X-Axis Start Value (R)
  The x-Axis value of the first vector element

- X-Axis Start Value (R)
  The step with which x-Axis values increment

- X-Axis Label
  The X-Axis label

- Y-Axis Label
  The Y-Axis label

- X-Axis Units (R)
  - Y-Axis Units (R)
  - Ref Level (R)
  - Grid
  - Autoscale
  - Average
  - Y min (R)
  - Y max (R)
  - Number of Inputs
  Number of signals connected to sink

- Update Period (R)
  - GUI Hint
  See GUI Hint for info about how to organize multiple QT GUIs

- Show Msg Ports
  True/False

- Line 1 Label
  - Line 1 Width
  - Line 1 Color
  - Line 1 Alpha
  ## Example Flowgraph
This flowgraph and output was produced by https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/qtgui_vector_sink_example.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/lib/vector_sink_f_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/lib/vector_sink_f_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/include/gnuradio/qtgui/vector_sink_f.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/grc/qtgui_vector_sink_f.block.yml]
