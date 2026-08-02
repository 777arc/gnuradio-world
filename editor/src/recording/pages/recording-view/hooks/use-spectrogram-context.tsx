import { useMeta } from '@/api/metadata/queries';
import { SigMFMetadata } from '@/utils/sigmfMetadata';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { COLORMAP_DEFAULT, SPECTROGRAM_METHOD_DEFAULT, SpectrogramMethod } from '@/utils/constants';
import { CHANNELIZER_OVERSAMPLING, CHANNELIZER_TAPS_PER_CHANNEL } from '@/utils/channelizer';

interface SpectrogramContextProperties {
  type: string;
  account: string;
  container: string;
  filePath: string;
  magnitudeMin: number;
  setMagnitudeMin: (magnitudeMin: number) => void;
  magnitudeMax: number;
  setMagnitudeMax: (magnitudeMax: number) => void;
  colmap: string;
  setColmap: (colmap: string) => void;
  windowFunction: string;
  setWindowFunction: (windowFunction: string) => void;
  spectrogramMethod: SpectrogramMethod;
  setSpectrogramMethod: (spectrogramMethod: SpectrogramMethod) => void;
  channelizerTaps: number;
  setChannelizerTaps: (channelizerTaps: number) => void;
  channelizerOversampling: number;
  setChannelizerOversampling: (channelizerOversampling: number) => void;
  fftSize: number;
  setFFTSize: (fftSize: number) => void;
  spectrogramHeight: number;
  setSpectrogramHeight: (spectrogramHeight: number) => void;
  spectrogramWidth: number;
  setSpectrogramWidth: (spectrogramWidth: number) => void;
  fftStepSize: number;
  setFFTStepSize: (fftStepSize: number) => void;
  includeRfFreq: boolean;
  setIncludeRfFreq: (includeRfFreq: boolean) => void;
  squareSignal: boolean;
  setSquareSignal: (squareSignal: boolean) => void;
  freqShift: boolean;
  setFreqShift: (freqShift: boolean) => void;
  meta: SigMFMetadata;
  setMeta: (meta: SigMFMetadata) => void;
  canDownload: boolean;
  setCanDownload: (canDownload: boolean) => void;
  selectedAnnotation?: number;
  setSelectedAnnotation: (selectedAnnotation: number) => void;
}

export const SpectrogramContext = createContext<SpectrogramContextProperties>(null);

// Initial settings
export function SpectrogramContextProvider({
  children,
  type,
  account,
  container,
  filePath,
  seedValues = {
    magnitudeMin: -30,
    magnitudeMax: 5,
    colmap: COLORMAP_DEFAULT,
    windowFunction: 'rectangle',
    spectrogramMethod: SPECTROGRAM_METHOD_DEFAULT,
    channelizerTaps: CHANNELIZER_TAPS_PER_CHANNEL,
    channelizerOversampling: CHANNELIZER_OVERSAMPLING,
    fftSize: 1024,
    spectrogramHeight: 800,
    spectrogramWidth: 1024,
    fftStepSize: 0,
  },
}) {
  const [magnitudeMin, setMagnitudeMin] = useState<number>(seedValues.magnitudeMin);
  const [magnitudeMax, setMagnitudeMax] = useState<number>(seedValues.magnitudeMax);
  const [colmap, setColmap] = useState<string>(seedValues.colmap);
  const [windowFunction, setWindowFunction] = useState<string>(seedValues.windowFunction);
  const [spectrogramMethod, setSpectrogramMethod] = useState<SpectrogramMethod>(
    seedValues.spectrogramMethod ?? SPECTROGRAM_METHOD_DEFAULT
  );
  const [channelizerTaps, setChannelizerTaps] = useState<number>(
    seedValues.channelizerTaps ?? CHANNELIZER_TAPS_PER_CHANNEL
  );
  const [channelizerOversampling, setChannelizerOversampling] = useState<number>(
    seedValues.channelizerOversampling ?? CHANNELIZER_OVERSAMPLING
  );
  const [fftSize, setFFTSize] = useState<number>(seedValues.fftSize);
  const [spectrogramHeight, setSpectrogramHeight] = useState<number>(seedValues.spectrogramHeight);
  const [spectrogramWidth, setSpectrogramWidth] = useState<number>(seedValues.spectrogramWidth);
  const [fftStepSize, setFFTStepSize] = useState<number>(seedValues.fftStepSize);
  const [includeRfFreq, setIncludeRfFreq] = useState<boolean>(false);
  const [squareSignal, setSquareSignal] = useState<boolean>(false);
  const [freqShift, setFreqShift] = useState<boolean>(false);
  const { data: originMeta } = useMeta(type, account, container, filePath);
  const [meta, setMeta] = useState<SigMFMetadata>(originMeta);
  const [canDownload, setCanDownload] = useState<boolean>(false);
  const [selectedAnnotation, setSelectedAnnotation] = useState<number>();

  useEffect(() => {
    setMeta(originMeta);

    // If the recording size is real small, lower FFT size so it fills out vertically better
    if (meta && meta.getTotalSamples() < 100e3) {
      setFFTSize(256);
    }
  }, [originMeta]);

  return (
    <SpectrogramContext.Provider
      value={{
        type,
        account,
        container,
        filePath,
        magnitudeMin,
        setMagnitudeMin,
        magnitudeMax,
        setMagnitudeMax,
        colmap,
        setColmap,
        windowFunction,
        setWindowFunction,
        spectrogramMethod,
        setSpectrogramMethod,
        channelizerTaps,
        setChannelizerTaps,
        channelizerOversampling,
        setChannelizerOversampling,
        fftSize,
        setFFTSize,
        spectrogramHeight,
        setSpectrogramHeight,
        spectrogramWidth,
        setSpectrogramWidth,
        fftStepSize,
        setFFTStepSize,
        includeRfFreq,
        setIncludeRfFreq,
        squareSignal,
        setSquareSignal,
        freqShift,
        setFreqShift,
        meta,
        setMeta,
        canDownload,
        setCanDownload,
        selectedAnnotation,
        setSelectedAnnotation,
      }}
    >
      {children}
    </SpectrogramContext.Provider>
  );
}

export function useSpectrogramContext() {
  const context = useContext(SpectrogramContext);
  if (context === undefined || context === null) {
    throw new Error('useSpectrogramContext must be used within a SpectrogramContextProvider');
  }
  return context;
}
