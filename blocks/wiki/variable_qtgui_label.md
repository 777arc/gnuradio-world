<!-- block: variable_qtgui_label -->
<!-- title: QT GUI Label -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Label -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable with a label widget for text. Leave the label blank to use the variable id as the label.

## Parameters
(R): Run-time adjustable

- Label
  - Type (R)
  Type of data to handle

- Defaut Value (R)
  - Formatter
  Function returning string. Something like lambda x: f'{x:.3f}' can be used to format a number.

- GUI Hint
  See GUI Hint for info about how to organize multiple QT GUIs

## Example Flowgraph
This flowgraph and output show a QT GUI Label with an id:freq and a value of 0.1  Note that the output shows the Label: value 'Frequency' and the Default Value: value '100.0m'. The freq value is used to set the Signal Source Frequency.

## Source Files
- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/grc/qtgui_label.block.yml]
