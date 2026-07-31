// Which plot the recording view is showing. Lives in its own module so both the
// page and the settings pane (which holds the chooser) can import it without a
// cycle. Upstream has a fifth, Cyclostationary tab, which is not part of this port.
export enum Tab {
  Spectrogram,
  Time,
  Frequency,
  IQ,
}

export const TAB_NAMES = Object.keys(Tab).filter((key) => isNaN(Number(key))) as (keyof typeof Tab)[];
