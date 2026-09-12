<!-- block: variable_qtgui_msgcheckbox -->
<!-- title: QT GUI Msg CheckBox -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Msg_CheckBox -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable checkbox. Leave the label blank to use the variable id as the label. This checkbox selects between two values of similar type, but will stay clicked until clicked again. The variable will take on one value or the other depending on whether the button is pressed or released. This control also will produce a state message matching the set values.

Added in 3.9

## Parameters
(R): Run-time adjustable

- Id
  The variable name

- Label
  the name for the check box

- Type
  options: [Float, Integer, String, Boolean]

- Default Value
  default: 0

- Initial State
  options: [Unchecked, Checked]

- Checked
  default: 1

- Unchecked
  default: 0

- Cell Alignment
  options: [Center,Left,Right]

- Vertical Alignment
  options: [Center,Top,Bottom]

- Message Property Name
  default: value

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This file can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_msgcheckbox.grc]

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
