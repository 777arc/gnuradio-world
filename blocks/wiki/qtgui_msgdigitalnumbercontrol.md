<!-- block: qtgui_msgdigitalnumbercontrol -->
<!-- title: QT GUI Digital Number Control -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Digital_Number_Control -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

While it can be used for anything, this block replicates the frequency display found in many SDR receivers.

Added in 3.9

## Parameters
(R): Run-time adjustable

- Id
  The variable name

- Label
  The label of the display

- Min Freq (Hz)
  The minimum value which can be displayed

- Max Freq (Hz)
  The maximum value which can be displayed

- Value (R)
  The initial value to be displayed

- Thousands Separator
  options: [Comma, Period, None]

- Message Property Name
  The name paired with the message value

- Background
  options: [silver, gray, black, white, red, green, blue, navy, yellow, orange, purple, lime, aqua, teal]

- Font Color
  options: see above

- Read Only
  True / False

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This file can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_digitalnumcontrol.grc]

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
