<!-- block: variable_qtgui_toggle_switch -->
<!-- title: QT GUI Toggle Switch -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Toggle_Switch -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Added in 3.9

This block creates a modern toggle switch. The variable will take on one value or the other as set in the dialog.

This button also will produce a state message matching the set values.

## Parameters
(R): Run-time adjustable

- Label
  the name for the toggle switch.

- Label Position
  options: [Left, Right]

- Type
  options: [Float, Integer, String, Boolean]

- Default Value
  initial value (default: 0)

- Initial State
  options: [Released, Pressed]

- On Value
  default: 1

- Off Value
  default: 0

- Message Property Name
  default: value

- Switch On Background
  options: [silver, gray, black, white, red, green, blue, navy, yellow, orange, purple, lime, aqua, teal]

- switchOffBackground
  see above

- Cell Alignment
  options: [Center,Left,Right]

- Vertical Alignment
  options: [Center,Top,Bottom]

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_toggleswitch.grc]

## Example Output
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_toggleswitch2.grc]

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
