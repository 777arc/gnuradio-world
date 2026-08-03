import { useEffect, useState } from 'react';
import { fftshift } from 'fftshift';
import { CanvasPlot } from '@/features/ui/canvas-plot/CanvasPlot';
import { FFT } from '@/utils/fft';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';

interface FreqPlotProps {
  displayedIQ: Float32Array;
  fftStepSize: Number;
}

export const FrequencyPlot = ({ displayedIQ, fftStepSize }: FreqPlotProps) => {
  const { spectrogramWidth, spectrogramHeight, meta, includeRfFreq } = useSpectrogramContext();
  const [frequencies, setFrequencies] = useState([]);
  const [magnitudes, setMagnitudes] = useState([]);
  const sampleRate = meta.getSampleRate();
  const centerFrequency = meta.getCenterFrequency();

  useEffect(() => {
    if (displayedIQ && displayedIQ.length > 0) {
      // Calc PSD
      const fftSize = Math.pow(2, Math.floor(Math.log2(displayedIQ.length / 2))); // closest power of 2, rounded down
      const f = new FFT(fftSize);
      let out = f.createComplexArray(); // creates an empty array the length of fft.size*2
      f.transform(out, displayedIQ.slice(0, fftSize * 2)); // assumes input (2nd arg) is in form IQIQIQIQ and twice the length of fft.size
      out = out.map((x) => x / fftSize);
      let mags = new Array(out.length / 2);
      for (let j = 0; j < out.length / 2; j++) {
        mags[j] = Math.sqrt(Math.pow(out[j * 2], 2) + Math.pow(out[j * 2 + 1], 2)); // take magnitude
      }
      fftshift(mags); // in-place
      mags = mags.map((x) => 10.0 * Math.log10(x));
      setMagnitudes(mags);

      // calc x-axis
      const step = sampleRate / fftSize;
      if (!includeRfFreq) {
        setFrequencies(Array.from({ length: fftSize }, (_, i) => sampleRate / -2.0 + step * i));
      } else {
        setFrequencies(Array.from({ length: fftSize }, (_, i) => sampleRate / -2.0 + step * i + centerFrequency));
      }
    }
  }, [displayedIQ, includeRfFreq, sampleRate, centerFrequency]); // TODO make sure this isnt going to be sluggish when currentSamples is huge

  return (
    <div className="px-3">
      <p className="text-muted text-center">
        Below shows the power spectral density of the sample range displayed on the spectrogram tab
      </p>
      {fftStepSize === 0 ? (
        <CanvasPlot
          traces={[{ x: frequencies, y: magnitudes }]}
          width={spectrogramWidth}
          height={spectrogramHeight}
          xTitle="Frequency"
          yTitle="Magnitude"
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
