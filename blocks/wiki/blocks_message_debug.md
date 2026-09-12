<!-- block: blocks_message_debug -->
<!-- title: Message Debug -->
<!-- source: https://wiki.gnuradio.org/index.php/Message_Debug -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

__NOTOC__

Debug block for the message passing system.

The message debug block is used to capture and print or store messages as they are received. Any block that generates a message may connect that message port to one or more of the three message input ports of this debug block.

## Parameters
(R): Run-time adjustable

Added in 3.9
- PDU Vectors (R)
  On or Off - determines if the uniform vector is printed or not.

Version 3.8
- None

Version 3.11, 3.10.6++
- Log level
  Sets the "log" input's log level to trace, debug, info, warning, error or critical

## Messages
### Inputs
#### Versions 3.11 (and >3.10.6.1)
----
- log
  Logs all messages to the logging system (which by default prints it to your console). Generally, this is preferred over the "print" input.
- print
  Prints all messages to standard out. If the message is a PDU, it will receive special formatting and the PDU Vectors block parameter will determine if the uniform vector is printed or not.
- store
  Stores the message in an internal vector. It works in conjunction with a message_debug::get_message(size_t i) call that allows us to retrieve message i afterward.
- print_pdu
  PDU messages are redirected to the print port. This is included for compatibility and is no longer recommended for use.

#### Versions 3.9 and 3.10
----
- print
  Prints all messages to standard out. If the message is a PDU, it will receive special formatting and the PDU Vectors block parameter will determine if the uniform vector is printed or not.
- store
  Stores the message in an internal vector. It works in conjunction with a message_debug::get_message(size_t i) call that allows us to retrieve message i afterward.
- print_pdu
  PDU messages are redirected to the print port. This is included for compatibility and is no longer recommended for use.

#### Version 3.8
----
- print
  Prints the message to standard out.
- store
  Stores the message in an internal vector. It works in conjunction with a message_debug::get_message(size_t i) call that allows us to retrieve message i afterward.
- print_pdu
  Specifically designed to handle formatted PDUs (see pdu.h). It discards messages that aren't PDU pairs (or are null).

## Example Flowgraph
In this example, a Message Strobe block sends the string "Demo" once per second. It is displayed on the user terminal by the Message Debug block.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/message_debug_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/message_debug_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/message_debug.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_message_debug.block.yml]
