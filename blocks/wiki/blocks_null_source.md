<!-- block: blocks_null_source -->
<!-- title: Null Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Null_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Null Source Sink Block consists of two main components:
    - Null Source: This part of the Null Source Sink Block generates a continuous stream of zero-valued samples. It can serve as the starting point in a data path, providing a predictable and controlled input for testing downstream processing blocks.
    - Null Sink: This component receives and discards incoming data streams. As the endpoint in a data path, it consumes data without performing any additional processing, ensuring that upstream components can be tested without worrying about the handling of output data.

The Block can operate as either Null Source, Null Sink or both simultaniously.
## Parameters
- Block Type
  options: [Sink, Source, Both]
  default: Sink
  Whether the block acts as a sink, a source, or both

- Block Args
  default: ""
  Viable properties can be found at RFNoC Null Source Sink control.

- Device Select / Instance Select
  Default: -1 / Default: -1
  These properties specify the device and instance to be used. It is best practice to always explicitly specify both. This is crucial because many USRP setups involve multiple instances of different blocks, and GNU Radio tends to select the first device or instance it finds, which may not be the most suitable choice. Explicit specification helps to prevent errors and ensures the correct setup is used.
  - Use uhd_usrp_probe to determine the correct device and instance numbers.
  - Always specify the device and instance explicitly to avoid automatic mismatches by GNU Radio.
  Even with a single device with multiple instances:
  - 0/Radio#0 → Device 0, Instance 0
  - 0/Radio#1 → Device 0, Instance 1
  Specification with multiple devices:
  - 0/Radio#1 → Device 0, Instance 1
  - 1/Radio#1 → Device 1, Instance 1
  By consistently specifying the device and instance, you ensure that the most appropriate settings are applied and avoid potential issues caused by automatic selection.

## Example Flowgraph
When a flowgraph has no hardware devices, a Throttle is needed to limit the CPU utilization. Since the "main" data flow is via messages, the Throttle is fed with a Null Source. This file can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_digitalnumcontrol.grc]

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  uhd_rfnoc_null_src_sink.block.yml
