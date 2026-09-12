<!-- block: digital_hdlc_framer_pb -->
<!-- title: HDLC Framer -->
<!-- source: https://wiki.gnuradio.org/index.php/HDLC_Framer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

HDLC framer which takes in PMT binary blobs and outputs HDLC frames as unpacked bits, with CRC and bit stuffing added. The first sample of the frame is tagged with the tag frame_tag_name and includes a length field for tagged_stream use.

This block outputs one whole frame at a time; if there is not enough output buffer space to fit a frame, it is pushed onto a queue. As a result flowgraphs which only run for a finite number of samples may not receive all frames in the queue, due to the scheduler's granularity. For flowgraphs that stream continuously (anything using a USRP) this should not be an issue.

This block goes with HDLC Deframer

## Parameters
- Frame tag name
  The tag to add to the first sample of each frame.

## Example Flowgraph
## Source Files
- C++ files
  hdlc_framer_pb_impl.cc

- Header files
  hdlc_framer_pb_impl.h

- Public header files
  hdlc_framer_pb.h

- Block definition
  digital_hdlc_framer_pb.block.yml
