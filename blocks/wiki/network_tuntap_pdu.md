<!-- block: network_tuntap_pdu -->
<!-- title: TUNTAP PDU -->
<!-- source: https://wiki.gnuradio.org/index.php/TUNTAP_PDU -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Creates TUNTAP interface and translates traffic to PDUs. See TUN/TAP for an explanation of the functions.

When the TUN option is chosen, a virtual ethernet interface is allocated to the specified Interface name (tun). It's IP address can then  be set by:

 sudo ifconfig tun 192.168.200.1

or:

 sudo ip addr add dev tun 192.168.200.1/24
 sudo ip link set dev tun up

GNU Radio needs root privileges to use this block.

Alternatively, the "ip" command can be used beforehand to create a persistent tun or tap interface owned by the user. The following commands set up a persistent tap interface named tap0 with an IP address of 192.168.200.1:

 sudo ip tuntap add dev tap0 mode tap user $USER
 sudo ip addr add dev tap0 192.168.200.1/24
 sudo ip link set dev tap0 up

Once these commands are run, GNU Radio no longer needs root privileges to use this block.

Afterwards, to delete the tap0 interface:
 sudo ip tuntap del dev tap0 mode tap

Note for 3.10 This block has been moved from gr-blocks to gr-network, which causes a name change of the id. See Porting_Existing_Flowgraphs_to_a_Newer_Version for details.

## Parameters
- Interface name
  Device name to create

- MTU
  Maximum Transmission Unit size

- Flag
  Flag to indicate TUN or Tap

## Example Flowgraph
This flowgraph can be downloaded from Media:Tuntap_pdu.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
