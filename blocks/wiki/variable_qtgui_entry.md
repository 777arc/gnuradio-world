<!-- block: variable_qtgui_entry -->
<!-- title: QT GUI Entry -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Entry -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable with a text entry box.

Note: Before version 3.10.8.0, after typing the entry, the 'Enter/Return' key must be pressed. With version 3.10.8.0, the parameter "Update Trigger" allows selection of the behavior. See the parameter below.

## Parameters
(R): Run-time adjustable

- Label
  Leave the label blank to use the variable id as the label.
- Type
  options: [Float, Integer, String, Boolean, Any]
- Default Value (R)
  default: '0'
- Update Trigger - only version 3.10.8.0 and after
  options: ["'Enter'", "'Enter' or focus lost"]
- GUI Hint
  See GUI Hint for how to position the widget within the application.

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  qtgui_entry.block.yml
