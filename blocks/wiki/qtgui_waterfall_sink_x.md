<!-- block: qtgui_waterfall_sink_x -->
<!-- title: QT GUI Waterfall Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Waterfall_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A graphical sink to display signals on a waterfall (spectrogram) plot.
The Intensity Min and Max will determine how the colormap represents the range of values

## Parameters
(R): Run-time adjustable

- Type
  default: complex
  options: [Complex, Float, Complex Message, Float Message]

- Name
  default: none

- FFT Size
  default: '1024'
  options: ['32','64','128','256','512','1024','2048','4096','8192','16384','32768']

- Spectrum Width
  default: 'Full'
  options: [Full, Half]

- Window Type
  default: Blackman-harris
  options: [Blackman-harris, Hamming, Hann, Blackman, Rectangular, Kaiser, Flat-top]

- Center Frequency (Hz)
  default: '0'

- Bandwidth (Hz)
  default: samp_rate
- Intensity Min
  default: '-140'
- Intensity Max
  default: '10'
- Grid
  default: 'No'
  options: ['Yes', 'No']

- Number of Inputs
  default: '1'

- Update Period
  default: '0.10'

- Show Msg Ports
  default: 'No'
  options: ['Yes', 'No']

- GUI Hint
  The GUI hint can be used to position the widget within the application. The hint is of the form [tab_id@tab_index]: [row, col, row_span, col_span]. Both the tab specification and the grid position are optional.

- Legend
  default: 'Yes'
  options: ['Yes', 'No']

- Line 1 Label
  default: none

- Axis Labels
  default: 'Yes'
  options: ['Yes', 'No']

- Line 1 Color
  options: [Multi Color, White Hot, Black Hot, Incandescent, Sunset, Cool]

- Line 1 Alpha
  default: '1.0'
- Line 2 Label
  base_key: label1
- Line 2 Color
  base_key: color1
- Line 2 Alpha
  base_key: alpha1
- Line 3 Label
  base_key: label1
- Line 3 Color
  base_key: color1
- Line 3 Alpha
  base_key: alpha1
- Line 4 Label
  base_key: label1
- Line 4 Color
  base_key: color1
- Line 4 Alpha
  base_key: alpha1
- Line 5 Label
  base_key: label1
- Line 5 Color
  base_key: color1
- Line 5 Alpha
  base_key: alpha1
- Line 6 Label
  base_key: label1
- Line 6 Color
  base_key: color1
- Line 6 Alpha
  base_key: alpha1
- Line 7 Label
  base_key: label1
- Line 7 Color
  base_key: color1
- Line 7 Alpha
  base_key: alpha1
- Line 8 Label
  base_key: label1
- Line 8 Color
  base_key: color1
- Line 8 Alpha
  base_key: alpha1
- Line 9 Label
  base_key: label1
- Line 9 Color
  base_key: color1
- Line 9 Alpha
  base_key: alpha1
- Line 10 Label
  base_key: label1
- Line 10 Color
  base_key: color1
- Line 10 Alpha
  base_key: alpha1

## Example Flowgraph
## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  qtgui_waterfall_sink_x.block.yml
