<!-- block: blocks_message_strobe -->
<!-- title: Message Strobe -->
<!-- source: https://wiki.gnuradio.org/index.php/Message_Strobe -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Send message at defined interval.

Takes a PMT message and sends it out every  milliseconds. Useful for testing/debugging the message system.

## Parameters
(R): Run-time adjustable

- Message PMT (R)
  The message to send as a PMT. For example, the following message creates a payload of a simple vector of 16 bytes that contains all 1's.

  pmt.cons(pmt.PMT_NIL, pmt.make_u8vector(16, 0xFF))

- Period (ms) (R)
  The specified time interval after which data is sent at the output repeatedly.

## Example Flowgraph
### Example 1
In this example, a Message Strobe block sends the string "Demo" once per second.

### Example 2
In another example, we change the frequency of a signal source to 1kHz after 5 seconds.

The message strobe settings in the above example are as follows:

### Example 3
Another example that uses a Message Strobe block can be found in gr-blocks/examples/msg_passing.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/message_strobe_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/message_strobe_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/message_strobe.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_message_strobe.block.yml]
