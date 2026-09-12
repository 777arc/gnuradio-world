<!-- block: qtgui_eye_sink_x -->
<!-- title: QT GUI Eye Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Eye_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A graphical sink to display eye diagrams.

Added in 3.9

This is a QT-based graphical sink which takes a set of complex streams and plots them as an eye pattern. For each signal, both the signal's I and Q eye patterns are plotted. Eye patterns are 2 symbol periods long.

The symbol rate of the signal being provided as input to the eye sink must be an integer multiple of the eye sink's sample rate to obtain the eye pattern. This integer multiple is the samples per symbol value that is provided to the eye sink block.

The set_title and set_color functions can be used to change the label and color for a given input number.

Trigger occurs at the beginning of each stream used to plot the eye pattern; whilst a real eye diagram would be triggered with a (recovered) symbol clock. For these reasons, triggering of noisy and/or unsynchronized signals may lead to incorrect eye pattern.

The sink supports plotting streaming complex data or messages. The message port is named "in". The two modes cannot be used simultaneously, and nconnections should be set to 0 when using the message mode. GRC handles this issue by providing the "Complex Message" type that removes the streaming port(s).

This sink can plot messages that contain either uniform vectors of complex 32 values (pmt::is_c32vector) or PDUs where the data is a uniform vector of complex 32 values.

See GUI Hint for info about how to organize multiple QT GUIs

### Triggering Info
Set up a trigger for the sink to know when to start
plotting. Useful to isolate events and avoid noise.

The trigger modes are Free, Auto, Normal, and Tag (see
gr::qtgui::trigger_mode). The first three are like a normal
oscope trigger function. Free means free running with no
trigger, auto will trigger if the trigger event is seen, but
will still plot otherwise, and normal will hold until the
trigger event is observed. The Tag trigger mode allows us to
trigger off a specific stream tag. The tag trigger is based
only on the name of the tag, so when a tag of the given name
is seen, the trigger is activated.

In auto and normal mode, we look for the slope of the of the
signal. Given a gr::qtgui::trigger_slope as either Positive
or Negative, if the value between two samples moves in the
given direction (x[1] > x[0] for Positive or x[1] < x[0] for
Negative), then the trigger is activated.

With the complex eye sink, each input has two eye patterns
drawn for the real and imaginary parts of the signal. When
selecting the \p channel value, channel 0 is the real signal
and channel 1 is the imaginary signal. For more than 1 input
stream, channel 2i is the real part of the ith input and
channel (2i+1) is the imaginary part of the ith input
channel.

The \p delay value is specified in time based off the sample
rate. If the sample rate of the block is set to 1, the delay
is then also the sample number offset. This is the offset
from the left-hand y-axis of the plot. It delays the signal
to show the trigger event at the given delay along with some
portion of the signal before the event. The delay must be
within 0 - t_max where t_max is the maximum amount of time
displayed on the eye pattern equal to 2 symbol time.

## Parameters
- samp_rate
  sample rate (used to set x-axis labels)

- name
  title for the plot

- nconnections
  number of signals connected to sink

- parent
  a QWidget parent object, if any

- trigger_mode
  free, auto, normal, or tag.

- slope
  The trigger_slope: positive or negative. Only used for auto and normal modes.

- level
  The magnitude of the trigger even for auto or normal modes.

- delay
  The delay (in units of time) for where the trigger happens.

- channel
  Which input channel to use for the trigger events.

- tag_key
  The name (as a string) of the tag to trigger off of if using the tag mode.

## Example Flowgraph
The flowgraph for this plot can be found in [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/qtgui_eye_sink_example.grc]
