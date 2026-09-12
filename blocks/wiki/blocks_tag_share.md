<!-- block: blocks_tag_share -->
<!-- title: Tag Share -->
<!-- source: https://wiki.gnuradio.org/index.php/Tag_Share -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Adds tags from Input 1 onto Input 0's stream.

This block utilizes the GNU Radio runtime's tag propagation policy to transfer or share Input 1's tags to Input 0's stream. This is useful when a signal is detected via a correlate_access_code_bb or a threshold crossing from a complex_to_mag_squared block. The tag from that detection is on the alternate stream, either bytes or floats. Often there is further signal processing that should be done on the complex stream. This block allows the detection tags to be added to the complex stream to trigger downstream processing without the need of redundant trigger inputs on all subsequent blocks.

## Example Flowgraph
Media:example_tag_share.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/tag_share_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/tag_share_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/tag_share.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_tag_share.block.yml]
