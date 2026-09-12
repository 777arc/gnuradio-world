<!-- block: digital_hdlc_deframer_bp -->
<!-- title: HDLC Deframer -->
<!-- source: https://wiki.gnuradio.org/index.php/HDLC_Deframer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

HDLC deframer which takes in unpacked bits, and outputs PDU binary blobs. Frames which do not pass CRC are rejected. This block also unstuffs the bits in the HDLC frame.

This block goes with HDLC Framer

## Parameters
- Min length
  Minimum frame size (bytes)

- Max length
  Maximum frame size (bytes)

## Example Flowgraph
## Source Files
- C++ files
  hdlc_deframer_bp_impl.cc

- Header files
  hdlc_deframer_bp_impl.h

- Public header files
  hdlc_deframer_bp.h

- Block definition
  digital_hdlc_deframer_bp.block.yml
