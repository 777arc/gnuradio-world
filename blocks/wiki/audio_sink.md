<!-- block: audio_sink -->
<!-- title: Audio Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/Audio_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Allows a signal to be played through your speakers. See Audio Source for a block that inputs from an audio device such as a microphone.

Not all sampling rates will be supported by your hardware. The audio sink can have multiple inputs depending upon your hardware.

## Parameters
### Sample Rate
To set the Audio sampling rate, click the drop-down menu to see popular rates.  Note: not all sampling rates will be supported by your hardware. For typical applications, this should be set to 48kHz.

### Device Name
Leave the device name blank to choose the default audio device.

To select a particular output device, a name ([string]) or index number ([int]) can be specified.
The exact name or index number depends on the Operating System and the audio system in use (see below).

### OK to Block
On by default, which should be used when this sink is not throttled by any other block.

### Num Inputs
The audio sink can have multiple inputs depending upon your hardware. For example, set the inputs to 2 for stereo or 1 for mono.

## Operating System
#### OSX
On OSX, go into the System Preferences, click on "Sound", and then the "Output" tab. The listings under "Name" contain the exact device names currently available; if a new audio device is attached to the computer then a new name will appear -- for example "Headphones" for some Macs. Since most such device names contain spaces, make sure to put quotes around the name argument, for example:

    spectrum_inversion.py -O "MacBook Pro Speakers"

#### Linux
On Linux, the device is selected via ALSA, where typical choices include:
- default (selected if left empty)
  This will use the default device. Note that in most desktop systems this is actually managed by PipeWire or PulseAudio, to check this, you can execute aplay -L | grep -A1 ^default.
- hw:0,0
  This will select the hardware card 0, device 0. To check the list of available cards/devices, issue the command aplay -l (note that -l is lower case here).
- plughw:0,0
  This is the same as hw:0,0 but enables software processing, which allows e.g. selecting a sample rate not natively supported by the sound card.
- pipewire (to explicitly use PipeWire)
- pulse (to explicitly use PulseAudio)

For ALSA users with audio trouble, follow this procedure:
- from a terminal window enter aplay -L

- find the desired entry such as:

```
hw:CARD=Generic,DEV=0
    HD-Audio Generic, ALC662 rev3 Analog
    Direct hardware device without any conversions
```

  from the list which matches your device. To use an HDMI monitor with speakers, find an appropriate entry with "HDMI" in it.

- use the first line of that entry (e.g. "hw:CARD=Generic,DEV=0") as the device name. Unless the name has spaces in it, the quotes are optional.

- For issues or debugging, see ALSAPulseAudio.

#### Windows
On Windows, go into the Settings, cllck on "System", click on "Sound", and then the "Output" tab. The listings under "Name" contain the exact device names currently available; if a new audio device is attached to the computer then a new name will appear, for example "Headphones". Since most of the device names contain spaces, make sure to put quotes around the name argument, for example:

    "Speakers (Realtek High Definition Audio)"

- portaudio

  When this backend module is in use (see gr-audio.conf), the names given to audio devices are adopted from Windows.

  An alternate method to see the names of output devices is to use the Multimedia System Control Panel.
  Type the Windows Key, then type mmsys.cpl, and hit Enter. The output devices are found in the Playback tab.

  To see the index numbers of output devices, ensure the python-sounddevice package is installed in the radioconda environment,
  after which the command python -m sounddevice will produce a complete list.

- windows

  When this backend module is in use, the names and index numbers are as assigned by Windows.

  Windows PowerShell must be configured in advance just once to list the names and index numbers.

  Start PowerShell using Run as Administrator and issue the command Install-Module -Name AudioDeviceCmdlets.

  After that, run PowerShell normally and the cmdlet get-audiodevice -list will produce the list.

## Example Flowgraph
This flowgraph should play a 1 kHz tone out of your speakers.  Note that you don't need a throttle block, the Audio Sink should throttle for you.  If you do end up using an already-throttled signal source, then set "OK to Block" to No.
