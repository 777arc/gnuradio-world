import { useEffect, useState } from 'react';
import { CanvasPlot } from '@/features/ui/canvas-plot/CanvasPlot';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';

interface TimePlotProps {
  displayedIQ: Float32Array;
  fftStepSize: Number;
}

export const TimePlot = ({ displayedIQ, fftStepSize }: TimePlotProps) => {
  const { spectrogramWidth, spectrogramHeight, freqShift, meta } = useSpectrogramContext();
  const { cursorFreqShift } = useCursorContext(); // cursorFreqShift is in normalized freq (-0.5 to +0.5) regardless of if display RF is on
  const [I, setI] = useState<Float32Array>();
  const [Q, setQ] = useState<Float32Array>();

  useEffect(() => {
    if (displayedIQ && displayedIQ.length > 0) {
      const temp_I = new Float32Array(displayedIQ.length / 2);
      const temp_Q = new Float32Array(displayedIQ.length / 2);
      for (let i = 0; i < displayedIQ.length / 2; i++) {
        if (freqShift) {
          // Multiplying two complex numbers: (a + ib)(c + id) = (ac - bd) + i(ad + bc).
          temp_I[i] =
            displayedIQ[i * 2] * Math.cos(-2 * Math.PI * cursorFreqShift * i) -
            displayedIQ[i * 2 + 1] * Math.sin(-2 * Math.PI * cursorFreqShift * i);
          temp_Q[i] =
            displayedIQ[i * 2] * Math.sin(-2 * Math.PI * cursorFreqShift * i) +
            displayedIQ[i * 2 + 1] * Math.cos(-2 * Math.PI * cursorFreqShift * i);
        } else {
          temp_I[i] = displayedIQ[i * 2];
          temp_Q[i] = displayedIQ[i * 2 + 1];
        }
      }
      setI(temp_I);
      setQ(temp_Q);
    }
  }, [displayedIQ, freqShift, cursorFreqShift]);

  // A real recording is carried as I/Q with Q = 0, so its Q trace is a flat line
  // that says nothing -- unless a frequency shift is applied, which mixes the
  // real signal down and does produce a genuine imaginary part.
  const showQ = meta?.isComplex() !== false || freqShift;
  const traces = [{ y: I ?? new Float32Array(), name: showQ ? 'I' : 'Real' }];
  if (showQ) traces.push({ y: Q ?? new Float32Array(), name: 'Q' });

  return (
    <div className="px-3">
      <p className="text-muted text-center">
        Below shows the time domain of the sample range displayed on the spectrogram tab
      </p>
      {fftStepSize === 0 ? (
        <CanvasPlot
          traces={traces}
          width={spectrogramWidth}
          height={spectrogramHeight}
          xTitle="Time"
          yTitle="Samples"
          showLegend
          yFixedRange
          rangeSlider
        />
      ) : (
        <>
          <h1 className="text-center">Plot only visible when Zoom Out Level is minimum (0)</h1>
          <p className="text-muted text-center mb-6">(Otherwise the IQ samples are not contiguous)</p>
        </>
      )}
    </div>
  );
};
