import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useSpectrogramContext } from './use-spectrogram-context';
import { useGetIQData } from '@/api/iqdata/Queries';
import { useDebounce } from 'usehooks-ts';
import { sampleSelection } from '@/utils/selection-export';

interface CursorContextProperties {
  cursorTime: Cursor;
  setCursorTime: (cursorTime: Cursor) => void;
  setCursorTimeFromFileSource: (cursorTime: Cursor, openEnded: boolean) => void;
  cursorTimeOpenEnded: boolean;
  cursorFreq: Cursor;
  setCursorFreq: (cursorFreq: Cursor) => void;
  cursorFreqShift: number;
  setCursorFreqShift: (cursorFreqShift: number) => void;
  cursorData: Float32Array;
  setCursorData: (cursorData: Float32Array) => void;
  cursorTimeEnabled: boolean;
  setCursorTimeEnabled: (cursorTimeEnabled: boolean) => void;
  cursorFreqEnabled: boolean;
  setCursorFreqEnabled: (cursorFreqEnabled: boolean) => void;
}

export const CursorContext = createContext<CursorContextProperties>(null);

interface Cursor {
  start: number;
  end: number;
}

export function CursorContextProvider({ children }) {
  const [cursorData, setCursorData] = useState<Float32Array>(new Float32Array(0));
  const [cursorTime, setCursorTimeState] = useState<Cursor>({
    start: 0,
    end: 0,
  });
  const [cursorTimeOpenEnded, setCursorTimeOpenEnded] = useState<boolean>(false);
  const setCursorTime = useCallback((next: Cursor) => {
    setCursorData(new Float32Array(0));
    setCursorTimeState(next);
    setCursorTimeOpenEnded(false);
  }, []);
  const setCursorTimeFromFileSource = useCallback((next: Cursor, openEnded: boolean) => {
    setCursorData(new Float32Array(0));
    setCursorTimeState(next);
    setCursorTimeOpenEnded(openEnded);
  }, []);
  const [cursorFreq, setCursorFreq] = useState<Cursor>({
    start: 0,
    end: 0,
  });
  const [cursorFreqShift, setCursorFreqShift] = useState<number>(0);

  const [cursorFreqEnabled, setCursorFreqEnabled] = useState<boolean>(false);
  const [cursorTimeEnabled, setCursorTimeEnabled] = useState<boolean>(false);

  const { type, account, container, filePath, fftSize, meta } = useSpectrogramContext();
  const { currentData, setFFTsRequired } = useGetIQData(type, account, container, filePath, fftSize);

  const debounceCursorTime = useDebounce(cursorTime, 500);

  useEffect(() => {
    if (!currentData || !debounceCursorTime || !cursorTimeEnabled || !meta) {
      return;
    }
    const selection = sampleSelection(
      debounceCursorTime.start,
      debounceCursorTime.end,
      meta.getTotalSamples(),
    );
    if (selection.count === 0) {
      setCursorData(new Float32Array(0));
      return;
    }
    const startingFFT = Math.floor(selection.start / fftSize);
    const endingFFT = Math.ceil(selection.end / fftSize);
    const iqData = new Float32Array(selection.count * 2);
    let offset = 0;
    let requiredBlocks: number[] = [];
    for (let i = startingFFT; i < endingFFT; i++) {
      const block = currentData[i];
      if (!block) {
        requiredBlocks.push(i);
        continue;
      }
      const blockStart = i * fftSize;
      const first = Math.max(selection.start, blockStart) - blockStart;
      const last = Math.min(selection.end, blockStart + fftSize) - blockStart;
      const slice = block.slice(first * 2, last * 2);
      iqData.set(slice, offset);
      offset += slice.length;
    }
    setFFTsRequired(requiredBlocks);
    if (requiredBlocks.length === 0) setCursorData(iqData);
  }, [debounceCursorTime, currentData, cursorTimeEnabled, fftSize, meta, setFFTsRequired]);

  return (
    <CursorContext.Provider
      value={{
        cursorTime,
        setCursorTime,
        setCursorTimeFromFileSource,
        cursorTimeOpenEnded,
        cursorFreq,
        setCursorFreq,
        cursorFreqShift,
        setCursorFreqShift,
        cursorData,
        setCursorData,
        cursorFreqEnabled,
        setCursorFreqEnabled,
        cursorTimeEnabled,
        setCursorTimeEnabled,
      }}
    >
      {children}
    </CursorContext.Provider>
  );
}

export function useCursorContext() {
  const context = useContext(CursorContext);
  if (context === undefined || context === null) {
    throw new Error('useSpectrogramContext must be used within a SpectrogramContextProvider');
  }
  return context;
}
