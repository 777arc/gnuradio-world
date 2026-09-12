<!-- block: variable_qtgui_dial_control -->
<!-- title: QT GUI Dial -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Dial -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a dial control. The dial controls a variable which can be used for other items. Leave the label blank to use the variable id as the label. The block also creates an optional message with the control value that can be used in message-based applications. Note the Message Debug output in the Example Output below.

Added in 3.9

## Parameters
(R): Run-time adjustable

- Id
  The variable name

- Label
  the name for the dial

- Type
  Float or Integer

- Default Value
  default: 0

- Minimum
  default: 0

- Maximum
  default: 100

- Scale Factor
  default: 1

- Show Value
  default: False

- Minimum Size
  default: 100

- Message Property Name
  default: 'value'

- Color
  options: [default, silver, gray, black, white, red, green, blue, navy, yellow, orange, purple, lime, aqua, teal]

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This file can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_dialcontrol.grc]

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
