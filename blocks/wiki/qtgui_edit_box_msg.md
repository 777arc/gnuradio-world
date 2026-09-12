<!-- block: qtgui_edit_box_msg -->
<!-- title: QT GUI Message Edit Box -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Message_Edit_Box -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Message Edit Box is a QT widget which manages data through message passing interfaces. The interface ports are Polymorphic Types (PMT), which are opaque data types designed as generic containers of data.

The 'msg' output port produces messages based on the text in the input field(s) and the data type set by the type argument. The data types are checked, and WARN log messages are produced when the data is in the wrong format.

The value of the input field(s) can be updated programmatically through the 'val' input message port. It is also checked for the correct data type.

The is_pair argument determines if the input field handles a key:value pair. If set to True, two input fields are created with the left for the key and right for the value. The key is always assumed to be a string and the value is restricted by the data type setting as above.

The block can take a default value. Because the block is capable of handling multiple data types, the default value is entered as a string in the same format as the user enters it into the Value input field of the widget.

Complex numbers are handled a bit differently. Because the Boost lexical_cast function is used, complex numbers MUST be in the form "(a,b)" to represent "a + jb". Note that a space is not valid after the comma, so "(1.23,10.56)" is correct while "(1.23, 10.56)" is not.

The static mode prevents the user from changing the data type or the key used in the widget. If also in pair mode, the key is not displayed and so must be set in the constructor. It is an error if using static and pair modes with no default key set.

### Message Ports
- msg (output):
  Produces a PMT message from the data in the input field. If the data is not of the correct type and the conversion fails, the block produces a log WARN message, but does not output the data.

- val (input):
  Accepts PMT messages to update the value in the input field(s). The messages are first checked for the correct type (integer, float, string, or complex), and then converted to string(s) to display in the input field(s). When using is_pair, the PMT is checked to make sure it is a valid PMT pair. Then the key is extracted as a string and the value is processed according to the data type.

## Parameters
- Value
  The default value of the message. This is entered as a string regardless of the type and converted internally.

- Label
  A label to identify the input field on the screen.

- Pair Mode
  True If a key:value pair.

- Static Mode
  True If the key input field is a static text box (cannot be edited live).

- Key
  True If the key used in a key:value pair message.

- GUI Hint
  See GUI Hint for information on how to arrange multiple QT GUIs on the screen.

## Example Flowgraph
This flowgraph shows how a Message Edit Box can send a string. When the string has been processed by the Embedded Python Block, the 'clear input' port sends a null string back to the 'val' port of the Message Edit Box to clear the input field. In the flowgraph, the text is sent through a Throttle to a File Sink, sending the output to the user terminal (/dev/stdout).

Other examples:

- Embedded Python Block
- https://github.com/duggabe/gr-morse-code-gen

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/lib/edit_box_msg_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/lib/edit_box_msg_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/include/gnuradio/qtgui/edit_box_msg.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/grc/qtgui_edit_box_msg.block.yml]
