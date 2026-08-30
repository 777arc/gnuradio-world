import { useEffect, useState } from 'react';
import { CanvasPlot } from '@/features/ui/canvas-plot/CanvasPlot';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';

interface IQPlotProps {
  displayedIQ: Float32Array;
  fftStepSize: Number;
}

export const IQPlot = ({ displayedIQ, fftStepSize }: IQPlotProps) => {
  const { spectrogramHeight, freqShift, meta } = useSpectrogramContext();
  const { cursorFreqShift } = useCursorContext(); // cursorFreqShift is in normalized freq (-0.5 to +0.5) regardless of if display RF is on
  const [I, setI] = useState<Float32Array>();
  const [Q, setQ] = useState<Float32Array>();

  useEffect(() => {
    if (displayedIQ && displayedIQ.length > 0) {
      // For now just show the first 10k IQ samples, else it's too busy and it crashes the plot
      const displayedIQ_subset = displayedIQ.slice(0, 20000);

      const temp_I = new Float32Array(displayedIQ_subset.length / 2);
      const temp_Q = new Float32Array(displayedIQ_subset.length / 2);
      for (let i = 0; i < displayedIQ_subset.length / 2; i++) {
        if (freqShift) {
          // Multiplying two complex numbers: (a + ib)(c + id) = (ac - bd) + i(ad + bc).
          temp_I[i] =
            displayedIQ_subset[i * 2] * Math.cos(-2 * Math.PI * cursorFreqShift * i) -
            displayedIQ_subset[i * 2 + 1] * Math.sin(-2 * Math.PI * cursorFreqShift * i);
          temp_Q[i] =
            displayedIQ_subset[i * 2] * Math.sin(-2 * Math.PI * cursorFreqShift * i) +
            displayedIQ_subset[i * 2 + 1] * Math.cos(-2 * Math.PI * cursorFreqShift * i);
        } else {
          temp_I[i] = displayedIQ_subset[i * 2];
          temp_Q[i] = displayedIQ_subset[i * 2 + 1];
        }
      }
      setI(temp_I);
      setQ(temp_Q);
    }
  }, [displayedIQ, freqShift, cursorFreqShift]);

  // A real recording has no imaginary part, so every point sits on the I axis.
  // Say so rather than leaving the reader with an unexplained flat line; a
  // frequency shift mixes it down to a genuinely complex signal, which does
  // spread out here.
  const realValued = meta?.isComplex() === false && !freqShift;

  return (
    <div className="px-3">
      <p className="text-muted text-center">Below shows the first 10k IQ samples displayed on the spectrogram tab</p>
      {realValued && (
        <p className="text-muted text-center">
          This recording is real-valued, so Q is zero for every sample. Enable the frequency shift to see the complex
          signal it mixes down to.
        </p>
      )}
      {fftStepSize === 0 ? (
        <CanvasPlot
          traces={[{ x: I ?? new Float32Array(), y: Q ?? new Float32Array(), mode: 'markers', markerSize: 3 }]}
          width={spectrogramHeight}
          height={spectrogramHeight} // so it's square
          xTitle="I"
          yTitle="Q"
          xPad={0.05}
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
