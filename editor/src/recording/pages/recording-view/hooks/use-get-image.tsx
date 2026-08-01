import { fftToRGB } from '@/utils/selector';
import { colMaps } from '@/utils/colormap';
import { useEffect, useMemo, useState } from 'react';
import { calcFfts } from '@/utils/selector';
import { calcChannelizerFfts } from '@/utils/channelizer';
import { SpectrogramMethod } from '@/utils/constants';

export const useGetImage = (
  fftSize: number,
  spectrogramHeight: number,
  magnitudeMin: number,
  magnitudeMax: number,
  colmap: string,
  windowFunction: string,
  spectrogramMethod: SpectrogramMethod,
  channelizerTaps: number,
  channelizerOversampling: number
) => {
  const [image, setImage] = useState<ImageBitmap>(null);
  const [iqData, setIQData] = useState<Float32Array>(null);

  // call useMemo at the top level of your component to cache a calculation between re-renders
  //   const cachedValue = useMemo(calculateValue, dependencies)
  //   ffts is a 1D array of all of the FFTs (as floats) concatenated together, so the length will be the fftsize times the spectrogram height
  // Both methods return the same thing -- one row of `fftSize` magnitudes in dB
  // per spectrogram line, DC centred -- so only this call differs between them.
  // The window function is an FFT-only setting; the channelizer's shaping comes
  // from its prototype filter instead.
  const ffts = useMemo(() => {
    if (!iqData || !fftSize) return null;
    return spectrogramMethod === 'channelizer'
      ? calcChannelizerFfts(iqData, fftSize, spectrogramHeight, {
          tapsPerChannel: channelizerTaps,
          oversampling: channelizerOversampling,
        })
      : calcFfts(iqData, fftSize, windowFunction, spectrogramHeight);
  }, [
    iqData,
    fftSize,
    windowFunction,
    spectrogramHeight,
    spectrogramMethod,
    channelizerTaps,
    channelizerOversampling,
  ]);

  // Whenever the ffts themselves change, or magnitude scaling, or the colormap, regenerate the image bitmap
  useEffect(() => {
    if (!ffts || !fftSize || isNaN(magnitudeMin) || isNaN(magnitudeMax) || magnitudeMin >= magnitudeMax || !colmap) {
      setImage(null);
    } else {
      const rgbData = fftToRGB(ffts, fftSize, magnitudeMin, magnitudeMax, colMaps[colmap]);
      let num_final_ffts = ffts.length / fftSize;
      const newImageData = new ImageData(rgbData, fftSize, num_final_ffts);

      createImageBitmap(newImageData).then((imageBitmap) => {
        setImage(imageBitmap);
      });
    }
  }, [ffts, magnitudeMin, magnitudeMax, colmap]);

  return { image, setIQData };
};
