<!-- block: digital_header_payload_demux -->
<!-- title: Header/Payload Demux -->
<!-- source: https://wiki.gnuradio.org/index.php/Header/Payload_Demux -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block is designed to demultiplex packets from a bursty transmission. The typical application for this block is the case when you are receiving packets with yet-to-determine length. This block will pass the header section to other blocks for demodulation. Using the information from the demodulated header, it will then output the payload. The beginning of the header needs to be identified by a trigger signal (see below).
## Theory of Operation
- Input 0 takes a continuous transmission of samples (items).
- Input 1 is an optional input for the trigger signal (mark beginning of packets).
- In this case, a non-zero value on input 1 identifies the beginning of a packet. Otherwise, a tag with the key specified in trigger_tag_key is used as a trigger (its value is irrelevant).

Until a trigger signal is detected, all samples are dropped onto the floor. Once a trigger is detected, a total of header_len items are copied to output 0 out_hdr. The block then stalls until it receives a message on the message port header_data. The message must be a PMT dictionary. All key/value pairs are copied as tags to the first item of the payload (which is assumed to be the first item after the header). The value corresponding to the key specified in length_tag_key is read and taken as the payload length. The payload, together with the header data as tags, is then copied to output 1 out_payload.

If the header demodulation fails, the header must send a PMT with value pmt::PMT_F. The state gets reset and the header is ignored.
### Symbols, Items and Item Sizes
To generically and transparently handle different kinds of modulations, including OFDM, this block distinguishes between symbols and items.

Items are what are consumed at the input. Anything that uses complex samples will therefore use an itemsize of sizeof(gr_complex). Symbols are a way of grouping items. In OFDM, we usually don't care about individual samples, but we do care about full OFDM symbols, so we set items_per_symbol to the IFFT / FFT length of the OFDM modulator / demodulator. For single-carrier modulations, this value can be set to the number of samples per symbol, to handle data in number of symbols, or to 1 to handle data in number of samples. If specified, guard_interval items are discarded before every symbol. This is useful for demuxing bursts of OFDM signals.

On the output, we can deal with symbols directly by setting output_symbols to true. In that case, the output item size is the symbol size.

#### Example:
OFDM with 48 sub-carriers, using a length-64 IFFT on the modulator, and a cyclic-prefix length of 16 samples. In this case, itemsize is sizeof(gr_complex), because we're receiving complex samples. One OFDM symbol has 64 samples, hence items_per_symbol is set to 64, and guard_interval to 16. The header length is specified in number of OFDM symbols. Because we want to deal with full OFDM symbols, we set output_symbols to true.

#### Example:
PSK-modulated signals, with 4 samples per symbol. Again, itemsize is sizeof(gr_complex) because we're still dealing with complex samples. items_per_symbol is 4, because one item is one sample. guard_interval must be set to 0. The header length is given in number of PSK symbols.

### Handling timing uncertainty on the trigger
By default, the assumption is made that the trigger arrives on exactly the sample that the header starts. These triggers typically come from timing synchronization algorithms which may be suboptimal, and have a known timing uncertainty (e.g., we know the trigger might be a sample too early or too late).

The demuxer has an option for this case, the header_padding. If this value is non-zero, it specifies the number of items that are prepended and appended to the header before copying it to the header output.

#### Example:
Say our synchronization algorithm can be off by up to two samples, and the header length is 20 samples. So we set header_len to 20, and header_padding to 2. Now assume a trigger arrives on sample of index 100. We copy a total of 24 samples to the header port out_hdr, starting at sample of index 98.

#### Payload and padding
The payload is not padded. Let's say the header demod reports a payload length of 100. In the previous examples, we would copy 100 samples to the payload port, starting at sample index 120 (this means the padded samples appended to the header are copied to both ports!). However, the header demodulator has the option to specify a payload offset, which cannot exceed the padding value. To do this, include a key payload_offset in the message sent back to the HPD. A negative value means the payload starts earlier than otherwise. (If you wanted to always pad the payload, you could set payload_offset to -header_padding and increase the reported length of the payload).

Because the padding is specified in number of items, and not symbols, this value can only be multiples of the number of items per symbol if either output_symbols is true, or a guard interval is specified (or both). Note that in practice, it is rare that both a guard interval is specified and a padding value is required. The difference between the padding value and a guard interval is that a guard interval is part of the signal, and comes with every symbol, whereas the header padding is added to only the header, and is not by design.

### Tag Handling
Any tags on the input stream are copied to the corresponding output if they're on an item that is propagated. Note that a tag on the header items is copied to the header stream; that means the header-parsing block must handle these tags if they should go on the payload. A special case are tags on items that make up the guard interval. These are copied to the first item of the following symbol. If a tag is situated very close to the end of the payload, it might be unclear if it belongs to this packet or the following. In this case, it is possible that the tag might be propagated twice.

Tags outside of packets are generally discarded. If there are tags that carry important information that must not be list, there are two additional mechanisms to preserve the tags:

1. Timing tags might be relevant to know when a packet was received. By specifying the name of a timestamp tag and the sample rate at this block, it keeps track of the time and will add the time to the first item of every packet. The name of the timestamp tag is usually 'rx_time' (see, e.g., gr::uhd::usrp_source::make()). The time value must be specified in the UHD time format.
1. Other tags are simply stored and updated. As an example, the user might want to know the rx frequency, which UHD stores in the rx_freq tag. In this case, add the tag name 'rx_freq' to the list of special_tags. This block will then always save the most current value of 'rx_freq' and add it to the beginning of every packet.

## Parameters
- header_len
  Number of symbols per header

- header_padding
  A number of items that is appended and prepended to the header.

- items_per_symbol
  Number of items per symbol

- guard_interval
  Number of items between two consecutive symbols

- length_tag_key
  Key of the frame length tag

- trigger_tag_key
  Key of the trigger tag

- Output Format
  Output is either items or symbols

- timing_tag_key
  The name of the tag with timing information, usually 'rx_time' or empty (this means timing info is discarded)

- samp_rate
  Sampling rate at the input. Necessary to calculate the rx time of packets.

- Special Tag Keys
  A vector of strings denoting tags which shall be preserved (see Tag Handling)

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/packet/packet_rx.grc]

## Source Files
- C++ files
  header_payload_demux_impl.cc

- Header files
  header_payload_demux_impl.h

- Public header files
  header_payload_demux.h

- Block definition
  digital_header_payload_demux.block.yml
