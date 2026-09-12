<!-- block: variable_qtgui_msg_push_button -->
<!-- title: QT GUI Msg Push Button -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Msg_Push_Button -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable push button that creates a message when clicked. Leave the label blank to use the variable id as the label. You can define both the output message pmt name as well as the value and value type.

Added in 3.9

## Parameters
(R): Run-time adjustable

- Id
  The variable name

- Label
  the name for the push button

- Type
  options: [Float, Integer, String, Boolean]

- Message Property Name
  default: pressed

- Message Value
  default: 1

- Button Background
  options: [default, silver, gray, black, white, red, green, blue, navy, yellow, orange, purple, lime, aqua, teal]

- Button Font Color
  options: see above

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_msgpush.grc]

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  qtgui_msgpushbutton.block.yml
