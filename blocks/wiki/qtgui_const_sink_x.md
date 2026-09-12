<!-- block: qtgui_const_sink_x -->
<!-- title: QT GUI Constellation Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Constellation_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A graphical sink to display the IQ constellation of multiple signals.

The sink supports plotting streaming complex data or messages. The message port is named "in". The two modes cannot be used simultaneously, and  should be set to 0 when using the message mode. GRC handles this issue by providing the "Complex Message" type that removes the streaming port(s).

There are many parameters across three tabs, most of them self-explanatory.

## Example Flowgraph
This flowgraph creates a BPSK signal with 4 samples per symbol, then adds noise to simulate an AWGN channel, then performs timing synchronization and displays the constellation (aka IQ plot)
