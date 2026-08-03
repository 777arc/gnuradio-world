import { useEffect, useState } from 'react';
import { Layer, Rect, Text } from 'react-konva';
import { APP_FONT_FAMILY, APP_FONT_SIZE } from '@/utils/constants';
import { unitPrefixHz } from '@/utils/rf-functions';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';

const FreqShiftSelector = () => {
  const { spectrogramWidth, spectrogramHeight, meta, includeRfFreq, freqShift } = useSpectrogramContext();
  const { cursorFreqShift, setCursorFreqShift } = useCursorContext();
  const [text, setText] = useState('');
  const sampleRate = meta?.getSampleRate() || 0;
  const coreFrequency = includeRfFreq ? meta.getCenterFrequency() : 0;

  const position = (cursorFreqShift + 0.5) * spectrogramWidth; // in pixels. this auto-updates

  useEffect(() => {
    const formatted = unitPrefixHz((position / spectrogramWidth - 0.5) * sampleRate + coreFrequency);
    setText(formatted.freq + ' ' + formatted.unit);
  }, [position, includeRfFreq]);

  const handleDragMove = (e) => {
    let newX = e.target.x();
    if (newX <= 2) newX = 2;
    if (newX > spectrogramWidth - 2) newX = spectrogramWidth - 2;
    e.target.x(newX);
    e.target.y(0); // keep line in the same y location
    setCursorFreqShift(newX / spectrogramWidth - 0.5);
  };

  // add cursor styling
  function onMouseOver() {
    document.body.style.cursor = 'move';
  }
  function onMouseOut() {
    document.body.style.cursor = 'default';
  }

  if (!freqShift) return null;

  return (
    <>
      <Layer>
        <>
          <Rect
            x={position}
            y={0}
            width={0}
            height={spectrogramHeight}
            draggable={true}
            onDragMove={handleDragMove}
            onMouseOver={onMouseOver}
            onMouseOut={onMouseOut}
            strokeEnabled={true}
            strokeWidth={5}
            stroke="#3AF003"
            opacity={0.75}
            dash={[3, 6]} // X pixels long and Y pixels apart
          ></Rect>

          <Text text={text} fontFamily={APP_FONT_FAMILY} fontSize={APP_FONT_SIZE} x={position + 5} y={0} fill={'white'} />
        </>
      </Layer>
    </>
  );
};

export default FreqShiftSelector;
