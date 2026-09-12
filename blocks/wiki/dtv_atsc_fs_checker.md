<!-- block: dtv_atsc_fs_checker -->
<!-- title: ATSC Field Sync Checker -->
<!-- source: https://wiki.gnuradio.org/index.php/ATSC_Field_Sync_Checker -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This page represents the documentation for all of the ATSC blocks, simply because they are intended to be used together, and most of the blocks have no parameters.

GNU Radio's ATSC (Advanced Television Systems Committee) module contains everything needed to transmit or a receive an ATSC 1.0 signal.  ATSC 1.0 uses "8VSB" meaning 8-level vestigial sideband modulation.  Each symbol includes two bits from the MPEG transport stream, which are then trellis modulated to produce a third bit.  The 6 MHz channel used for broadcast ATSC 1.0 carries a symbol rate of 10.76 megabaud, a gross bit rate of 32 Mbit/s, and a net bit rate of 19.39 Mbit/s of usable data.

Note that on the receive side, ATSC Receive Pipeline is a hier block defined here.

## ATSC 1.0 vs ATSC 3.0
These blocks do not currently work with ATSC 3.0 ("Nextgen TV"). ATSC 3.0 is based on orthogonal frequency division multiplexing (OFDM) of multiple quadrature amplitude modulated (QAM) signals, as opposed to ATSC 1.0's use of 8VSB, as discussed above.

## ATSC Transmission
Transmitting ATSC with Gnu Radio requires an appropriate MPEG2 transport stream. Here's how to create one in Linux:

1. If you do not have 'ffmpeg' installed, install it with sudo apt install ffmpeg.
1. Navigate to the folder containing your video file, such as a .MP4, .mkv, or other file.
1. Type the following command: ffmpeg -i inputFile.mp4 -c:v mpeg2video -b:v 3000k -acodec ac3 -b:a 768k -ar 48k -ac 2 -muxrate 19392658 -f mpegts outputFile.ts, where inputFile.mp4 is the file you wish to convert to the MPEG2 transport stream, and outputFile.ts is the transport stream file (TS) that you will use in Gnu Radio to create the ATSC signal.
1. In the transmission flowgraph shown below, use the outputFile.ts in the File Source block.

This is the example ATSC transmitter.

A ready-made file can also be found here. Use the TS file you created above in the File Source. You can transmit this signal by removing the Throttle block and adding an SDR sink to the output of the FFT filter.

## ATSC Reception
The simplest ATSC receiver uses the ATSC Receive Pipeline block. It has two parameters, the sample rate going into it and an oversampling ratio, a.k.a. the samples per symbol.  The default is 1.5 but people have used 1.1 as well (someone please explain this).

This is one example of an ATSC receiver. Another example can be found here.

Here's a flowgraph to receive ATSC signals from a File Source.

In both cases above, the output can be streamed to a File Sink as a transport stream (TS) file, as shown below. Such a transport stream file can be viewed with any of the stream players discussed below.

## Setting up a Player
Here are three viewer programs you can use to view the transport stream (TS) output of Gnu Radio's ATSC receive blocks.

- VLC: To install, open a terminal and type: sudo apt install vlc
- SMPlayer: To install, open a terminal and type: sudo apt install smplayer
- Celluloid: To install, open a terminal and type: sudo apt install celluloid

To configure each player, perform the following:

### SMPlayer
To play the stream, select Open > URL > use the address udp://@:, where the  is the port value in the UDP Sink in the transmitter. Click OK to begin streaming. Ex: The UDP Sink is set to a port number of 2000. The address to use would be udp://@:2000.

If there are problems, try the following:
1. Options -> Preferences
1. Under the performance sidebar item check the boxes:
1. * allow frame drop
1. * allow hard frame drop
1. Under the cache tab, uncheck 'auto', and set cache for streams to 8096

### VLC
To play the stream, select Media > Open Network Stream > use the address udp://@:, where the  is the port value in the UDP Sink in the transmitter. Click Play to begin streaming. Ex: The UDP Sink is set to a port number of 2000. The address to use would be udp://@:2000.

### Celluloid
To play the stream, click on the + symbol > Open Location > use the address udp://@:, where the  is the port value in the UDP Sink in the transmitter. Click Open to begin streaming. Ex: The UDP Sink is set to a port number of 2000. The address to use would be udp://@:2000.

## Issues of ATSC Reception
There are four things that you need in order to properly receive an ATSC signal using Gnu Radio. These are:

1. A SDR capable of at least 6 MHz instantaneous bandwidth. This means that it's not possible to receive an ATSC signal with a RTL-SDR, as those are only capable of ~2.5 MHz instantaneous bandwidth.
1. A relatively powerful processor. Demodulating and decoding ATSC is processor-intensive. Trying to receive and display an ATSC signal in real-time may not be possible. The only way to determine if your system is capable of real-time processing is to try it.
1. A relatively high signal-to-noise ratio (SNR). This means you need a strong signal, so you'll either need a good, high antenna, or close proximity to a TV broadcast tower.
1. A flat spectrum. The Gnu Radio ATSC receive blocks are extremely sensitive to frequency-selective fading. Any such fading will most likely either cause the system not to properly recover the signal, or to lose synchronization.

The signal below shows a relatively flat spectrum with a high signal-to-noise ratio. It was possible to receive this ATSC signal.

The signal below shows an ATSC signal with frequency-selective fading (FSF). Such fading can be seen as notches throughout the spectrum of the signal. The signal does have a high SNR, but the fading makes recovery of the information in this signal impossible.
