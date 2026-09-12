<!-- block: variable_qtgui_push_button -->
<!-- title: QT GUI Push Button -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Push_Button -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable push button. Leave the label blank to use the variable id as the label.

A push button selects between two values of similar type. The variable will take on one value or the other depending on whether the button is pressed or released.

## Parameters
(R): Run-time adjustable

- Label
  Name of the widget in the GUI

- Default Value (R)
  Value set before the first interaction

- Pressed
  Value to set when the button is pressed

- Released
  Value to set when the button is released

- GUI Hint
  See GUI Hint for info about how to organize multiple QT GUIs

## Example Flowgraph
This flowgraph and output show a QT GUI Push Button.

## Source Files
- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/grc/qtgui_push_button.block.yml]
