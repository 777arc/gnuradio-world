import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSpectrogram } from './hooks/use-spectrogram';
import { Layer, Stage, Image } from 'react-konva';
import { useGetImage } from './hooks/use-get-image';
import { KonvaEventObject } from 'konva/lib/Node';
import { RulerTop } from './components/ruler-top';
import { RulerSide } from './components/ruler-side';
import { SpectrogramContextProvider, useSpectrogramContext } from './hooks/use-spectrogram-context';
import { CursorContextProvider, useCursorContext } from './hooks/use-cursor-context';
import { useMeta } from '@/api/metadata/queries';
// Upstream loads these three lazily because they pulled in plotly, ~4.5 MB of
// JavaScript for three tabs. They draw on a plain canvas now (see
// @/features/ui/canvas-plot), so they are a few KB and cost nothing to import.
import { IQPlot } from './components/iq-plot';
import { FrequencyPlot } from './components/frequency-plot';
import { TimePlot } from './components/time-plot';
import { Sidebar } from './components/sidebar';
import MetaViewer from './components/meta-viewer';
import AnnotationList from './components/annotation/annotation-list';
import ScrollBar from './components/scroll-bar';
import {
  MINIMAP_FFT_SIZE, MIN_SPECTROGRAM_HEIGHT, MIN_STACKED_SPECTROGRAM_HEIGHT, NARROW_LAYOUT_WIDTH,
} from '@/utils/constants';
import FreqSelector from './components/freq-selector';
import FreqShiftSelector from './components/freqshift-selector';
import TimeSelector from './components/time-selector';
import { AnnotationViewer } from './components/annotation/annotation-viewer';
import TimeSelectorMinimap from './components/time-selector-minimap';
import { useWindowSize } from 'usehooks-ts';
import { Tab } from './tabs';

export function DisplaySpectrogram({ currentFFT, setCurrentFFT, currentTab }) {
  const {
    spectrogramWidth,
    magnitudeMin,
    magnitudeMax,
    autoScaleMagnitude,
    colmap,
    windowFunction,
    spectrogramMethod,
    channelizerTaps,
    channelizerOversampling,
    fftSize,
    fftStepSize,
    meta,
    setSpectrogramWidth,
    setSpectrogramHeight,
  } = useSpectrogramContext();

  const { displayedIQ, spectrogramHeight } = useSpectrogram(currentFFT);
  const { width, height } = useWindowSize();
  const spectrogramRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Two layouts, matching the `md:` breakpoint the page's flex direction uses:
    // settings beside the plot, or stacked under it on a phone. Stacked, the
    // 288px settings column is no longer taking width from the plot, and only
    // the side ruler (64) and minimap (69) still are — subtracting the wide
    // layout's 476 there would leave a *negative* width on a 390px screen.
    const stacked = width < NARROW_LAYOUT_WIDTH;
    setSpectrogramWidth(width - (stacked ? 147 : 476));   // hand-tuned for now
    // The height, unlike the width, is whatever the page has left over: the
    // Konva stages need it in pixels, so it cannot simply be `flex-1`. Measuring
    // the rendered page instead of subtracting a hand-tuned constant means the
    // rulers, the tab bar, the metadata summary and the annotations section can
    // all change size without this needing to be re-tuned. `slack` is what the
    // viewport has spare once everything (including the plot at its *current*
    // height) is laid out, so adding it to that height fills the page exactly,
    // in one pass — negative slack shrinks the plot the same way.
    const el = spectrogramRef.current;
    if (!el) return;
    const slack = window.innerHeight - document.body.getBoundingClientRect().height;
    const filled = el.getBoundingClientRect().height + slack;
    setSpectrogramHeight(Math.max(
      stacked ? MIN_STACKED_SPECTROGRAM_HEIGHT : MIN_SPECTROGRAM_HEIGHT, Math.round(filled)));
  }, [width, height, currentTab]);

  const { image, setIQData } = useGetImage(
    fftSize,
    spectrogramHeight,
    magnitudeMin,
    magnitudeMax,
    colmap,
    windowFunction,
    spectrogramMethod,
    channelizerTaps,
    channelizerOversampling,
    autoScaleMagnitude
  );

  function handleWheel(evt: KonvaEventObject<WheelEvent>): void {
    evt.evt.preventDefault();
    const scrollAmount = Math.floor(evt.evt.deltaY);
    const nextPosition = currentFFT + scrollAmount + spectrogramHeight * (fftStepSize + 1);
    const maxPosition = meta.getTotalSamples() / fftSize;

    if (nextPosition < maxPosition) {
      setCurrentFFT(Math.max(0, currentFFT + scrollAmount));
    }
  }

  // Sort of messy but this is how the IQ gets passed into useGetImage which internally has its own state for iqData
  useEffect(() => {
    if (displayedIQ && displayedIQ.length > 0) {
      setIQData(displayedIQ);
    }
  }, [displayedIQ]);

  return (
    <>
      {currentTab === Tab.Spectrogram && (
        <>
          <Stage width={spectrogramWidth + 110} height={34}>
            <RulerTop />
          </Stage>
          <div className="flex flex-row" id="spectrogram" ref={spectrogramRef}>
            <Stage width={spectrogramWidth} height={spectrogramHeight}>
              <Layer onWheel={handleWheel} imageSmoothingEnabled={false}>
                <Image image={image} x={0} y={0} width={spectrogramWidth} height={spectrogramHeight} />
              </Layer>
              <AnnotationViewer currentFFT={currentFFT} />
              <FreqSelector />
              <FreqShiftSelector />
              <TimeSelector currentFFT={currentFFT} />
            </Stage>
            {/* Wide enough for a time tick label at 16px, which is what the
                subtracted 476/147 below account for. */}
            <Stage width={64} height={spectrogramHeight} className="mr-1">
              <RulerSide currentRowAtTop={currentFFT} />
            </Stage>
            <Stage width={MINIMAP_FFT_SIZE + 5} height={spectrogramHeight}>
              <ScrollBar currentFFT={currentFFT} setCurrentFFT={setCurrentFFT} />
              <TimeSelectorMinimap />
            </Stage>
          </div>
        </>
      )}
      {currentTab === Tab.Time && <TimePlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
      {currentTab === Tab.Frequency && <FrequencyPlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
      {currentTab === Tab.IQ && <IQPlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
    </>
  );
}

export function DisplayMetaSummary() {
  const { meta } = useSpectrogramContext();
  return <MetaViewer meta={meta} />;
}

function FileSourceSelectionSync({ setCurrentFFT }) {
  const { fftSize, meta, setCanDownload } = useSpectrogramContext();
  const { setCursorTimeFromFileSource, setCursorTimeEnabled } = useCursorContext();
  const fftSizeRef = useRef(fftSize);
  const totalSamplesRef = useRef(meta.getTotalSamples());

  useEffect(() => { fftSizeRef.current = fftSize; }, [fftSize]);
  useEffect(() => { totalSamplesRef.current = meta.getTotalSamples(); }, [meta]);

  useEffect(() => {
    if (window.parent === window) return;
    const receiveSelection = (event: MessageEvent) => {
      const data = event.data;
      if (event.origin !== window.location.origin || event.source !== window.parent ||
          data?.type !== 'gr-file-source-selection') return;
      const offset = Number(data.offset);
      const length = Number(data.length);
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(length) || length < 0) return;
      const enabled = offset !== 0 || length !== 0;
      const openEnded = offset !== 0 && length === 0;
      const end = openEnded ? totalSamplesRef.current : offset + length;
      setCursorTimeFromFileSource({ start: offset, end }, openEnded);
      setCursorTimeEnabled(enabled);
      setCanDownload(enabled);
      if (enabled) setCurrentFFT(Math.floor(offset / fftSizeRef.current));
    };
    window.addEventListener('message', receiveSelection);
    window.parent.postMessage({ type: 'gr-recording-ready' }, window.location.origin);
    return () => window.removeEventListener('message', receiveSelection);
  }, [setCanDownload, setCursorTimeFromFileSource, setCursorTimeEnabled, setCurrentFFT]);

  return null;
}

export function RecordingViewPage() {
  const { type, account, container, filePath } = useParams();
  const { data: meta } = useMeta(type, account, container, filePath);
  const [currentTab, setCurrentTab] = useState<Tab>(Tab.Spectrogram);
  const [currentFFT, setCurrentFFT] = useState<number>(0);

  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="font-bold">Loading...</div>
      </div>
    );
  }
  return (
    <SpectrogramContextProvider type={type} account={account} container={container} filePath={filePath}>
      <CursorContextProvider>
        <FileSourceSelectionSync setCurrentFFT={setCurrentFFT} />
        <div className="mb-0 ml-0 mr-0 p-0 pt-3">
          {/* Narrow: the plot comes first and the settings stack under it —
              col-reverse, so the source order (settings first) is unchanged and
              the plot chooser at the top of the settings pane still reads as
              belonging to the plot above it. The width the spectrogram is drawn
              at follows the same breakpoint, in JS. */}
          <div className="flex flex-col-reverse md:flex-row w-full">
            <Sidebar currentFFT={currentFFT} currentTab={currentTab} setCurrentTab={setCurrentTab} />
            <div className="flex flex-col min-w-0 md:pl-3">
              {/* The plot chooser lives at the top of the settings pane; this displays whichever it selected */}
              <DisplaySpectrogram currentFFT={currentFFT} setCurrentFFT={setCurrentFFT} currentTab={currentTab} />
              <DisplayMetaSummary />
            </div>
          </div>
          <div className="mt-3 mb-0 px-2 py-0" style={{ margin: '5px' }}>
            <details>
              {/* Styled like the editor's own section headers: a recessed bar
                  over a panel-colored body, both boxed in the divider color. */}
              <summary
                className="cursor-pointer select-none rounded-t-md border border-base-300 bg-base-200 px-3 py-1.5
                  text-base-content hover:bg-raised"
              >
                Annotations
              </summary>
              <div className="rounded-b-md border border-t-0 border-base-300 p-2">
                <AnnotationList setCurrentFFT={setCurrentFFT} currentFFT={currentFFT} />
              </div>
            </details>
          </div>
        </div>
      </CursorContextProvider>
    </SpectrogramContextProvider>
  );
}
