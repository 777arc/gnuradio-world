<!-- block: variable_qtgui_range -->
<!-- title: QT GUI Range -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Range -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable with a choice of widgets. The variable can be given a default value and its value can be changed at runtime within a specified range.

The ID will be the variable name, so that ID can be used as a parameter in another block to make it adjustable in real-time.

Leave the label blank to use the variable id as the label.

This block does not support C++ output, so it cannot be used when the output language of a flowgraph in GRC is C++.

## Parameters
- Id (R)
  ID of the variable

- Label
  The label of the variable

- Type
  * float
  * int

- Default Value (R)
  The default value must be between the start and stop values.

- Start
  The starting value of the variable

- Stop
  The ending value of the variable

- Step
  The increment in the variable's values that will be shown on the widget

- Widget
  * Counter + Slider
  * Counter
  * Slider
  * Knob

- Minimum length
  - GUI hint
  See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
The following flowgraph has three QT GUI Range blocks for the variables 'volume', 'tuning', and 'sq_lvl'.

The run-time window shows the three QT GUI Range widgets.

## Source Files
- Block definition
  qtgui_range.block.yml
