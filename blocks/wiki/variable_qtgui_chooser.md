<!-- block: variable_qtgui_chooser -->
<!-- title: QT GUI Chooser -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Chooser -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block creates a variable with enumerated options. The gui widget is implemented as a combo box or radio button group. When the label is left blank, the option will be used as the label. If the number of options is greater than five, or you would rather enter a list, set the number of options to "list" to enter a list of options and a list of labels. See an example below. Note that the "Default option" must be one of the Option values.

## Parameters
(R): Run-time adjustable

See GUI Hint for how to position the GUI within your window.

## Example Parameters
Here is an example of using the "List" option. A flowgraph using this option can be found at [https://raw.githubusercontent.com/duggabe/gr-control/main/Transmitters/NFM_xmt.grc]

## Example Flowgraph
This shows the QT GUI Chooser block and how it looks in the output.

Note: Added field for 3.8.1 in July 2020 The "Option 0 (Default)" field has been split into two fields: "Default option" and "Option 0". Whereas the old format forced the default value to be entered as Option 0, the new format allows any of the options to be the default value. Here are what the parameters of the Chooser look like before and after:

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  [https://raw.githubusercontent.com/gnuradio/gnuradio/main/gr-qtgui/grc/qtgui_chooser.block.yml]
