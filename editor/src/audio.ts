// Audio Sink and Audio Source's editor half: the two things about browser audio
// that the runner frame cannot do for itself, because both need the user
// gesture that only the editor's Run click has.
//
//  - Microphone permission, obtained here so the prompt appears on the click
//    the reader just made. Like a WebUSB grant, it is per origin and outlives
//    the tab, so nothing is handed to the runner frame -- it simply calls
//    getUserMedia() again and is answered from the stored permission.
//  - The autoplay policy, which keeps an AudioContext suspended until the page
//    has been interacted with. The runner frame says when it is stuck; this
//    relays the reader's next click into it.
//
// See docs/audio.md.

import type { Inst } from './graph-model';

export const AUDIO_SOURCE_ID = 'audio_source';

/** Whether this flowgraph will actually open a microphone when it runs. */
function usesAudioCapture(blocks: Inst[]): boolean {
  return blocks.some(block =>
    block.id === AUDIO_SOURCE_ID && block.enabled && !block.bypassed);
}

/**
 * Obtains microphone permission for a flowgraph that captures audio.
 *
 * Must be called from a user gesture: Chrome will answer getUserMedia() without
 * one, but the prompt is then detached from anything the reader did, and Safari
 * refuses outright. The tracks are stopped immediately -- all this call is
 * after is the permission, which the runner frame's own getUserMedia() then
 * inherits.
 *
 * @returns a message to report, or null when everything is in place.
 */
export async function prepareAudioCapture(blocks: Inst[]): Promise<string | null> {
  if (!usesAudioCapture(blocks)) return null;
  if (!navigator.mediaDevices?.getUserMedia)
    return 'Audio Source needs getUserMedia, which this browser does not ' +
           'provide (a page served over plain HTTP does not get it either).';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error) {
    const name = (error as DOMException)?.name || '';
    if (name === 'NotAllowedError')
      return 'Audio Source cannot run: microphone permission was denied for ' +
             'this site. Allow it from the browser\'s address bar and run again.';
    if (name === 'NotFoundError')
      return 'Audio Source cannot run: this computer has no audio input device.';
    return `Audio Source cannot open a microphone: ${(error as Error)?.message || error}`;
  }
}

/**
 * The gesture relay. The runner frame reports an AudioContext its autoplay
 * policy will not let start; from then until it reports otherwise, every click
 * or keypress in the editor is passed down as a chance to start it. The
 * listeners are installed once and cost nothing while no audio is blocked.
 */
export function installAudioResumeRelay(
  frame: () => HTMLIFrameElement | null, notify: (message: string) => void,
): { blocked(): void; running(): void } {
  let waiting = false;
  const relay = () => {
    if (!waiting) return;
    frame()?.contentWindow?.postMessage({ type: 'gr-audio-resume' }, location.origin);
  };
  for (const type of ['pointerdown', 'keydown'] as const)
    window.addEventListener(type, relay, true);
  return {
    blocked() {
      if (waiting) return;
      waiting = true;
      notify('audio is waiting for a click: browsers block sound until the ' +
             'page is interacted with — click anywhere to start it');
    },
    running() {
      waiting = false;
    },
  };
}
