import { useState, useEffect } from 'react';
import { ArrowRightIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import DualRangeSlider from '@/features/ui/dual-range-slider/DualRangeSlider';
import { colMaps } from '@/utils/colormap';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';
import { unitPrefixHz } from '@/utils/rf-functions';
import { CHANNELIZER_OVERSAMPLING_CHOICES, CHANNELIZER_TAPS_CHOICES } from '@/utils/channelizer';
import { Tab, TAB_NAMES } from '../tabs';
import {
  float32IqBytes,
  sampleSelection,
  trimmedSigmfMetadata,
} from '@/utils/selection-export';

// The dropdown triggers are <label>s, so the base layer's <button> rule does not
// reach them; these restate the editor's button and menu popup over daisyUI's
// .btn / .dropdown-content.
const DROPDOWN_BUTTON =
  'btn btn-sm w-full font-normal bg-neutral border-secondary text-base-content hover:bg-raised hover:border-secondary';
const DROPDOWN_MENU = 'p-2 shadow-lg menu dropdown-content z-[1] mt-0 bg-base-100 border border-secondary rounded-md';

interface SettingsPaneProps {
  currentFFT: number;
  currentTab: Tab;
  setCurrentTab: (tab: Tab) => void;
}

const SettingsPane = ({ currentFFT, currentTab, setCurrentTab }: SettingsPaneProps) => {
  const fftSizes = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const zoomLevels = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  // These strings are the ones windowCoefficient() in utils/selector.ts matches
  // on; a name that does not match there silently applies no window at all.
  const windowFunctions = ['hamming', 'rectangle', 'hanning', 'bartlett', 'blackman'];
  const context = useSpectrogramContext();
  const sampleRate = context.meta?.getSampleRate() || 0;
  const coreFrequency = context.meta?.getCenterFrequency();
  const cursorContext = useCursorContext();
  const isChannelizer = context.spectrogramMethod === 'channelizer';
  const [localFreqShift, setLocalFreqShift] = useState('');

  const onChangeWindowFunction = (event) => {
    const newWindowFunction = event.currentTarget.dataset.value;
    context.setWindowFunction(newWindowFunction);
  };

  // When you drag the freqshift selector line, update the text box
  useEffect(() => {
    setLocalFreqShift(String(Math.round(cursorContext.cursorFreqShift * 100000) / 100000));
  }, [cursorContext.cursorFreqShift]);

  const onPressDownloadSelectedSamples = (e) => {
    const selection = sampleSelection(
      cursorContext.cursorTime.start,
      cursorContext.cursorTime.end,
      context.meta.getTotalSamples(),
    );
    if (selection.count === 0 || cursorContext.cursorData.length !== selection.count * 2) return;
    const metaClone = trimmedSigmfMetadata(context.meta, selection);
    const a = document.createElement('a');
    const sampleBytes = float32IqBytes(cursorContext.cursorData);
    const blobUrl = window.URL.createObjectURL(
      new Blob([sampleBytes], { type: 'application/octet-stream' })
    );
    a.href = blobUrl;
    a.download = 'trimmedSamples.sigmf-data';
    a.click();
    window.URL.revokeObjectURL(blobUrl);
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(JSON.stringify(metaClone, null, 2));
    a.download = 'trimmedSamples.sigmf-meta';
    a.click();
    a.remove(); // remove element from dom
  };

  // Calculate number of ffts we skip per image line in order to show N% of the total file in the spectrogram. The first element in the array is special, don't skip
  const onePercent = context.meta.getTotalSamples() / context.fftSize / 100;
  const zoomStepSizes = zoomLevels.map((z) => Math.floor((onePercent * z) / context.spectrogramHeight));

  return (
    <div className="form-control">
      {/* Which plot is shown; replaces the tab bar that used to sit above the spectrogram */}
      <div className="flex w-full mb-3" id="plotchooser">
        {TAB_NAMES.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setCurrentTab(Tab[key])}
            /* The editor's workspace tabs: a recessed strip, the active tab
               raised to the panel color with a blue underline. The base layer
               styles every <button> as a bordered slate button, so all of it
               has to be named here. */
            className={`${
              currentTab === Tab[key]
                ? 'bg-base-100 text-base-content font-semibold shadow-[inset_0_-2px_0_#58a6ff]'
                : 'bg-base-200 text-muted hover:bg-raised hover:text-base-content'
            } flex-auto px-1 py-1 rounded-none border-0 border-r border-base-300 last:border-r-0 whitespace-nowrap`}
          >
            {key}
          </button>
        ))}
      </div>

      <label className="mb-3" id="formZoom">
        <span className="label-text">Zoom Out Level</span>
        <input
          type="range"
          className="range range-xs range-primary"
          value={zoomStepSizes.indexOf(context.fftStepSize)}
          min={0}
          max={zoomStepSizes.length - 1}
          step={1}
          onChange={(e) => {
            const newZoomLevel = zoomStepSizes[parseInt(e.target.value)];
            context.setFFTStepSize(newZoomLevel);
          }}
        />
      </label>

      <label className="mb-1" id="toggle">
        <span className="label-text">Toggle Time Cursors</span>
        <input
          type="checkbox"
          className="toggle toggle-primary float-right"
          checked={cursorContext.cursorTimeEnabled}
          onChange={(e) => {
            if (!cursorContext.cursorTimeEnabled && cursorContext.cursorTime.start == cursorContext.cursorTime.end) {
              cursorContext.setCursorTime({
                start: (currentFFT + context.spectrogramHeight / 4 * (context.fftStepSize + 1)) * context.fftSize,
                end: (currentFFT + context.spectrogramHeight / 2 * (context.fftStepSize + 1)) * context.fftSize,
              });
            }
            cursorContext.setCursorTimeEnabled(e.target.checked);
            context.setCanDownload(e.target.checked);
          }}
        />
      </label>

      <label className="mb-3" id="toggle">
        <span className="label-text">Toggle Freq. Cursors</span>
        <input
          type="checkbox"
          className="toggle toggle-primary float-right"
          checked={cursorContext.cursorFreqEnabled}
          onChange={(e) => {
            if (!cursorContext.cursorFreqEnabled && cursorContext.cursorFreq.start == cursorContext.cursorFreq.end) {
              cursorContext.setCursorFreq({
                start: -0.2,
                end: 0.2,
              });
            }
            cursorContext.setCursorFreqEnabled(e.target.checked);
          }}
        />
      </label>

      <button
        className="mb-3"
        onClick={onPressDownloadSelectedSamples}
        style={{ width: '100%', marginTop: '5px' }}
        disabled={!context.canDownload || cursorContext.cursorData.length === 0}
      >
        Download Selected Samples
      </button>

      <div className="mb-3" id="formMagMax">
        <label>
          <span className="label-text">Magnitude Color Mapping</span>
        </label>

        <DualRangeSlider
          min={-100.0}
          minValue={context.magnitudeMin}
          max={50.0}
          maxValue={context.magnitudeMax}
          setMin={context.setMagnitudeMin}
          setMax={context.setMagnitudeMax}
          unit="dB"
        />
      </div>

      <div className="mt-4">
        <div className="dropdown dropdown-hover dropdown-right w-full">
          <label tabIndex={0} className={DROPDOWN_BUTTON}>
            Colormap <ChevronRightIcon className="inline-block h-4 w-4" />
          </label>
          <ul className={`${DROPDOWN_MENU} w-52`}>
            {Object.entries(colMaps).map(([value]) => (
              <li
                key={value}
                data-value={value}
                onClick={(e) => {
                  context.setColmap(e.currentTarget.dataset.value);
                }}
              >
                {context.colmap === value ? <a className="bg-selected text-base-content">{value}</a> : <a>{value}</a>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-4">
        <div className="dropdown dropdown-hover dropdown-right w-full">
          <label tabIndex={0} className={DROPDOWN_BUTTON}>
            {/* The same number under either method -- it is the DFT length for
                the FFT and the branch count for the channelizer -- but nobody
                calls a filter bank's channel count an FFT size. */}
            {isChannelizer ? 'Channels' : 'FFT Size'} <ChevronRightIcon className="inline-block h-4 w-4" />
          </label>
          <ul className={`${DROPDOWN_MENU} w-52`}>
            {fftSizes.map((x, index) => (
              <li
                key={index}
                data-value={String(x)}
                onClick={(e) => {
                  context.setFFTSize(parseInt(e.currentTarget.dataset.value));
                }}
              >
                {context.fftSize === x ? <a className="bg-selected text-base-content">{x}</a> : <a>{x}</a>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* How a row of the spectrogram is computed. Off is one FFT per block of
          fftSize samples, which is what every other SDR tool shows; on is a
          polyphase near-perfect-reconstruction filter bank of fftSize channels
          (see @/utils/channelizer), which confines a tone to the one or two
          channels it falls in instead of smearing it across the row. The window
          function only means anything to the FFT, so it is swapped out for the
          channelizer's own description. */}
      <div className="mt-4" id="toggleChannelizer">
        <label className="label py-0">
          <span className="label-text">Polyphase Channelizer</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={context.spectrogramMethod === 'channelizer'}
            onChange={(e) => {
              context.setSpectrogramMethod(e.target.checked ? 'channelizer' : 'fft');
            }}
          />
        </label>
      </div>

      {isChannelizer ? (
        <div className="mt-2 mb-2">
          {/* How long the prototype filter is, in taps per branch. More taps is a
              finer design grid, so less complementarity ripple and less leakage
              into the neighbouring channels -- paid for in arithmetic per row and
              in how many rows a transient smears across. */}
          <div className="dropdown dropdown-hover dropdown-right w-full">
            <label tabIndex={0} className={DROPDOWN_BUTTON}>
              Taps per Branch <ChevronRightIcon className="inline-block h-4 w-4" />
            </label>
            <ul className={`${DROPDOWN_MENU} w-52`}>
              {CHANNELIZER_TAPS_CHOICES.map((value) => (
                <li
                  key={value}
                  data-value={String(value)}
                  onClick={(e) => {
                    context.setChannelizerTaps(parseInt(e.currentTarget.dataset.value));
                  }}
                >
                  {context.channelizerTaps === value ? (
                    <a className="bg-selected text-base-content">{value}</a>
                  ) : (
                    <a>{value}</a>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* How fast the bank runs relative to the display. The row grid does
              not change -- the extra frames are averaged into the row they
              belong to -- so this settles the noise floor and catches a
              transient that falls between two critically sampled frames,
              without moving the time axis. */}
          <div className="dropdown dropdown-hover dropdown-right w-full mt-2">
            <label tabIndex={0} className={DROPDOWN_BUTTON}>
              Oversampling <ChevronRightIcon className="inline-block h-4 w-4" />
            </label>
            <ul className={`${DROPDOWN_MENU} w-52`}>
              {CHANNELIZER_OVERSAMPLING_CHOICES.map((value) => (
                <li
                  key={value}
                  data-value={String(value)}
                  onClick={(e) => {
                    context.setChannelizerOversampling(parseInt(e.currentTarget.dataset.value));
                  }}
                >
                  <a
                    className={context.channelizerOversampling === value ? 'bg-selected text-base-content' : undefined}
                  >
                    {value}× {value === 1 ? '(critical)' : `(${100 - 100 / value}% overlap)`}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="mt-2 mb-2">
          <div className="dropdown dropdown-hover dropdown-right w-full">
            <label tabIndex={0} className={DROPDOWN_BUTTON}>
              Window <ChevronRightIcon className="inline-block h-4 w-4" />
            </label>
            <ul className={`${DROPDOWN_MENU} w-70`}>
              {windowFunctions.map((value) => (
                <li key={value} data-value={value} onClick={onChangeWindowFunction}>
                  <a className={'capitalize ' + (context.windowFunction === value && 'bg-selected text-base-content')}>
                    {value}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div id="toggleFreq">
        <label className="label py-0">
          <span className="label-text">Display RF Freq</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={context.includeRfFreq}
            onChange={(e) => {
              context.setIncludeRfFreq(e.target.checked);
            }}
          />
        </label>
      </div>

      <div id="toggleSquaring">
        <label className="label pb-0 pt-2">
          <span className="label-text">Square Signal</span>
          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={context.squareSignal}
            onChange={(e) => {
              context.setSquareSignal(e.target.checked);
            }}
          />
        </label>
      </div>

      <div id="toggleFreqShift">
        <label className="label pb-0 pt-2">
          <span className="label-text">Frequency Shift</span>

          <input
            type="checkbox"
            className="toggle toggle-primary"
            checked={context.freqShift}
            onChange={(e) => {
              context.setFreqShift(e.target.checked);
            }}
          />
        </label>
        {context.freqShift && (
          <>
            <div className="pl-6">
              Baseband: {unitPrefixHz(cursorContext.cursorFreqShift * sampleRate).freq}{' '}
              {unitPrefixHz(cursorContext.cursorFreqShift * sampleRate).unit} <br></br>
              RF: {unitPrefixHz(cursorContext.cursorFreqShift * sampleRate + coreFrequency).freq}{' '}
              {unitPrefixHz(cursorContext.cursorFreqShift * sampleRate + coreFrequency).unit} <br></br>
              <div className="flex">
                Normalized:{' '}
                <input
                  type="text"
                  className="h-5 w-20 rounded-r-none ml-1 pl-2"
                  value={localFreqShift}
                  onChange={(e) => {
                    setLocalFreqShift(e.target.value);
                  }}
                />
                <button
                  className="rounded-l-none border-l-0 h-5"
                  onClick={() => {
                    cursorContext.setCursorFreqShift(parseFloat(localFreqShift));
                  }}
                >
                  <ArrowRightIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {/* Upstream has a Python snippet editor here, run through Pyodide off a
          CDN. It is not part of this port. */}
    </div>
  );
};

export default SettingsPane;
