<!-- block: blocks_message_strobe_random -->
<!-- title: Message Strobe Random-Delay -->
<!-- source: https://wiki.gnuradio.org/index.php/Message_Strobe_Random-Delay -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Send message at random interval.

Takes a PMT message and sends it out every at random intervals. The interval is based on a random distribution, with specified mean () and variance (). Useful for testing/debugging the message system.

Please note some peculiarities below:
- poisson does not care about your std
- gaussian operates as expected
- uniform is actually of the range (mean-std, mean+std) - thus we are lying and it is not actually an std here

## Parameters
(R): Run-time adjustable

- Message PMT (R)
  The message to send as a PMT.

- Distribution (R)
  The random distribution from which to draw events.

- Mean (ms) (R)
  The mean of the distribution.

- Std (ms) (R)
  The standard deviation of the distribution.

## Example Flowgraph
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
