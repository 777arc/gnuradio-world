<!-- block: blocks_vector_sink_x -->
<!-- title: Vector Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/Vector_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Stores stream to a vector, useful if you’re running for a short time, for example
in a test. You can access that data using snk.data() after tb.run() has completed.

So something like:
 tb.run()
 time.sleep(10)
 my_data = tb.my_vec_snk.data()
 print("data: ",my_data)

To extract data from a running flow graph use the probe blocks.
 tb.start()
 time.sleep(10)
 my_data = tb.my_probe_signal.level()
 print("data: ",my_data)

## Parameters
- Reserve Memory for Items
  Reserve space in the internal storage for this many items; the internal storage will still grow to accommodate more item if necessary, but setting this to a realistic value can avoid memory allocations during runtime, especially if you know a priori how many items you're going to store.

## Example Flowgraph
This flowgraph can be downloaded from Media:Vector_sink_nongui.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
