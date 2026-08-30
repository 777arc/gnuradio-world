// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import { useState, useEffect, useMemo } from 'react';
import { Layer, Rect, Image } from 'react-konva';
import {
  MINIMUM_SCROLL_HANDLE_HEIGHT_PIXELS,
  MINIMAP_FFT_SIZE,
  APP_MARK_COLOR,
  APP_WELL_COLOR,
} from '@/utils/constants';
import { useGetMinimapIQ, useRawIQData } from '@/api/iqdata/Queries';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { colMaps } from '@/utils/colormap';
import { calcFfts, fftMagnitudeRange, fftToRGB } from '@/utils/selector';

interface ScrollBarProps {
  currentFFT: number;
  setCurrentFFT: (currentFFT: number) => void;
}

const ScrollBar = ({ currentFFT, setCurrentFFT }: ScrollBarProps) => {
  const {
    type,
    account,
    container,
    filePath,
    meta,
    spectrogramHeight,
    fftSize,
    fftStepSize,
    colmap,
    magnitudeMin,
    magnitudeMax,
    autoScaleMagnitude,
    windowFunction,
  } = useSpectrogramContext();

  const { data: minimapData } = useGetMinimapIQ(type, account, container, filePath);
  const { downloadedIndexes } = useRawIQData(type, account, container, filePath, fftSize);

  const [minimapImg, setMinimapImg] = useState(null);
  const [ticks, setTicks] = useState([]);
  const [handleHeightPixels, setHandleHeightPixels] = useState(1);
  const [scalingFactor, setScalingFactor] = useState(1);

  const ffts = useMemo(() => {
    // A recording shorter than one FFT yields no rows at all, so there is
    // nothing to draw and minimapData[0] below would not exist.
    if (!minimapData || minimapData.length === 0) return null;
    // transform the minimap data (array of float32 arrays) into an one big FLOAT32ARRAY. i.e., concatenation
    const iqData = new Float32Array(minimapData.length * minimapData[0].length);
    for (let i = 0; i < minimapData.length; i++) {
      iqData.set(minimapData[i], i * minimapData[i].length);
    }
    if (minimapData[0].length != 2 * MINIMAP_FFT_SIZE) {
      throw new Error(
        `Minimap rows must be ${2 * MINIMAP_FFT_SIZE} floats (${MINIMAP_FFT_SIZE} IQ samples), ` +
          `got ${minimapData[0].length} across ${minimapData.length} rows`
      );
    }
    // Always an FFT, whatever the spectrogram's own method is: each minimap row
    // is its own ranged read from a different point in the recording, so
    // consecutive rows here are not consecutive samples. A channelizer row
    // reaches into its neighbours, which would mean filtering across those
    // seams. It is a 64-bin thumbnail either way.
    const ffts_calc = calcFfts(iqData, MINIMAP_FFT_SIZE, windowFunction, minimapData.length);
    const range = fftMagnitudeRange(ffts_calc, MINIMAP_FFT_SIZE);
    if (range) autoScaleMagnitude(range.min, range.max, true);
    return ffts_calc;
  }, [minimapData]);

  // Calc scroll handle height and new scaling factor
  useEffect(() => {
    if (!meta) return;
    const totalFfts = Math.max(1, meta.getTotalSamples() / fftSize);
    const visibleFfts = spectrogramHeight * (fftStepSize + 1);
    const newHandleHeight = (visibleFfts / totalFfts) * spectrogramHeight;
    setHandleHeightPixels(Math.min(
      spectrogramHeight,
      Math.max(MINIMUM_SCROLL_HANDLE_HEIGHT_PIXELS, newHandleHeight),
    ));

    // get the length ot any of the iqData arrays
    const newScalingFactor = totalFfts / spectrogramHeight;
    setScalingFactor(newScalingFactor);
  }, [spectrogramHeight, fftSize, fftStepSize, meta]);

  const downloadedIndexesMemo = useMemo(() => {
    if (!downloadedIndexes || !meta) return [];
    // we will have a maximum of 100 tiles to show data that has been downloaded
    const tiles = [];
    const downloadScaling = meta.getTotalSamples() / fftSize / 100;
    for (let i = 0; i < 100; i++) {
      const foundIndex = downloadedIndexes.find((x) => x >= i * downloadScaling && x < (i + 1) * downloadScaling);
      if (foundIndex != null && foundIndex != undefined) {
        tiles.push(i);
      }
    }
    return tiles;
  }, [meta, fftSize, downloadedIndexes]);

  // Calc the minimap image from ffts to rgb
  useEffect(() => {
    if (!ffts) return;
    const rgbData = fftToRGB(ffts, MINIMAP_FFT_SIZE, magnitudeMin, magnitudeMax, colMaps[colmap]);
    let num_final_ffts = ffts.length / MINIMAP_FFT_SIZE;
    const newImageData = new ImageData(rgbData, MINIMAP_FFT_SIZE, num_final_ffts);

    createImageBitmap(newImageData).then((imageBitmap) => {
      setMinimapImg(imageBitmap);
    });
  }, [ffts, magnitudeMin, magnitudeMax, colmap]);

  // Calc the annotation ticks
  useEffect(() => {
    if (!meta) {
      return;
    }
    // Add a tick wherever there are annotations
    let t = [];
    const sampleRate = meta.getSampleRate();
    const centerFrequency = meta.getCenterFrequency();
    meta.annotations.forEach((annotation) => {
      const lowerEdge = Number(annotation['core:freq_lower_edge'] ?? centerFrequency - sampleRate / 2);
      const upperEdge = Number(annotation['core:freq_upper_edge'] ?? centerFrequency + sampleRate / 2);
      t.push({
        y: Number(annotation['core:sample_start'] ?? 0) / fftSize,
        height: Math.max(1, Number(annotation['core:sample_count'] ?? 0) / fftSize),
        x: ((lowerEdge - centerFrequency + sampleRate / 2) / sampleRate) * MINIMAP_FFT_SIZE,
        width: ((upperEdge - lowerEdge) / sampleRate) * MINIMAP_FFT_SIZE,
      });
    });
    setTicks(t);
  }, [meta, scalingFactor]); // dont add anymore here, so that this triggers ONLY at the start

  const handleClick = (e) => {
    let currentY = e.evt.offsetY;
    let newY = currentY - handleHeightPixels / 2; // assume we want the handle centered where we click but we have to send fetchAndRender the top of the handle
    const maxY = Math.max(0, spectrogramHeight - handleHeightPixels);
    newY = Math.min(maxY, Math.max(0, newY));
    const visibleFfts = spectrogramHeight * (fftStepSize + 1);
    const maxFFT = Math.max(0, meta.getTotalSamples() / fftSize - visibleFfts);
    setCurrentFFT(Math.floor(maxY > 0 ? (newY / maxY) * maxFFT : 0));
  };

  const handleWheel = (e) => {
    e.evt.preventDefault();
    const scrollAmount = Math.floor(e.evt.wheelDeltaY);

    const nextPosition = currentFFT - scrollAmount + spectrogramHeight * (fftStepSize + 1);
    const maxPosition = meta.getTotalSamples() / fftSize;

    if (nextPosition <= maxPosition) {
      setCurrentFFT(Math.max(0, currentFFT - scrollAmount));
    }
  };

  const handleDragMove = (e) => {
    let newY = e.target.y();
    const maxY = Math.max(0, spectrogramHeight - handleHeightPixels);
    newY = Math.min(maxY, Math.max(0, newY));
    e.target.y(newY);
    e.target.x(0);
    const visibleFfts = spectrogramHeight * (fftStepSize + 1);
    const maxFFT = Math.max(0, meta.getTotalSamples() / fftSize - visibleFfts);
    setCurrentFFT(Math.floor(maxY > 0 ? (newY / maxY) * maxFFT : 0));
  };

  const maxHandleY = Math.max(0, spectrogramHeight - handleHeightPixels);
  const visibleFfts = spectrogramHeight * (fftStepSize + 1);
  const maxCurrentFFT = Math.max(0, meta.getTotalSamples() / fftSize - visibleFfts);
  const handleY = maxCurrentFFT > 0
    ? Math.min(maxHandleY, Math.max(0, currentFFT / maxCurrentFFT * maxHandleY))
    : 0;

  return (
    <>
      <Layer onWheel={handleWheel} imageSmoothingEnabled={false}>
        {minimapImg ? (
          <Image
            onClick={handleClick}
            image={minimapImg}
            x={0}
            y={0}
            width={MINIMAP_FFT_SIZE}
            height={spectrogramHeight}
          />
        ) : (
          <Rect
            x={0}
            y={0}
            fill={APP_WELL_COLOR}
            width={MINIMAP_FFT_SIZE}
            height={spectrogramHeight}
            strokeWidth={4}
            onClick={handleClick}
          ></Rect>
        )}
      </Layer>
      <Layer onWheel={handleWheel}>
        <Rect
          x={0}
          y={handleY}
          fill="black"
          opacity={minimapImg ? 0.6 : 1}
          width={MINIMAP_FFT_SIZE}
          height={handleHeightPixels}
          draggable={true}
          onDragMove={handleDragMove}
        ></Rect>

        {/* box for each annotation */}
        {ticks.map((tick, index) => (
          <Rect
            x={tick.x}
            y={tick.y / scalingFactor}
            width={tick.width}
            height={tick.height / scalingFactor}
            fillEnabled={false}
            //fill="white"
            stroke="white"
            strokeWidth={1}
            key={'annotation' + index.toString()}
          />
        ))}

        {/* white boxes showing what has been downloaded */}
        {downloadedIndexesMemo?.map((fftIndx) => (
          <Rect
            x={MINIMAP_FFT_SIZE}
            y={(fftIndx * spectrogramHeight) / 100}
            width={5}
            height={spectrogramHeight / 100}
            fillEnabled={true}
            fill={APP_MARK_COLOR}
            strokeWidth={0}
            key={Math.random() * 1000000 + Math.random()}
          />
        ))}
      </Layer>
    </>
  );
};

export default ScrollBar;
