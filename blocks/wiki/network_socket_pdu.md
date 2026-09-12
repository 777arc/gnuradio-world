<!-- block: network_socket_pdu -->
<!-- title: Socket PDU -->
<!-- source: https://wiki.gnuradio.org/index.php/Socket_PDU -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Creates socket interface and translates traffic to PDUs.

For server modes, leave Host blank to bind to all interfaces (equivalent to 0.0.0.0).

Note for 3.10 This block has been moved from gr-blocks to gr-network, which causes a name change of the id. See Porting_Existing_Flowgraphs_to_a_Newer_Version for details.

## Parameters
- Type
  Socket type (TCP/UDP, Client/Server)

- Host
  Network address to use

- Port
  Network port to use

- MTU
  Maximum transmission unit

- TCP No delay
  TCP No Delay option (set to True to disable Nagle algorithm)

## Example Flowgraph
Media:example_socket_pdu_server.grc

Media:example_socket_pdu_client.grc
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/socket_pdu_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/socket_pdu_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/socket_pdu.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_socket_pdu.block.yml]
