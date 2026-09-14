import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UrlClient } from './UrlClient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IQRowLoader } from './row-loader';
import { useMeta } from '@/api/metadata/queries';
import { applyProcessing } from '@/utils/fetch-more-data-source';
import { groupContiguousIndexes } from '@/utils/group';

// Upstream also runs the visible IQ through a user-supplied FIR filter and a
// Python snippet, the latter via Pyodide loaded off a CDN. Both are gone here (a
// cross-origin-isolated page cannot load Pyodide anyway), so the processing chain
// is squaring only, and the client no longer needs credentials or a picked data
// source to construct.

export function useGetIQData(
  type: string,
  account: string,
  container: string,
  filePath: string,
  fftSize: number, // we grab 2x this many floats/ints
  squareSignal: boolean = false
) {
  const queryClient = useQueryClient();
  // The rows the caller wants and does not have yet, in priority order. Not
  // capped: the loader bounds the work by bytes and requests in flight.
  const [fftsRequired, setFFTsRequired] = useState<number[]>([]);

  const { data: meta } = useMeta(type, account, container, filePath);

  // One loader per recording and FFT size, for as long as the hook is mounted.
  // Each read it completes is merged straight into rawiqdata, which holds every
  // row fetched so far, sparse by row index; the processed query below derives
  // from that, so the view re-renders per read rather than per batch.
  const loaderRef = useRef<IQRowLoader>(null);
  useEffect(() => {
    if (!meta) return;
    const iqDataClient = new UrlClient();
    const rawKey = ['rawiqdata', type, account, container, filePath, fftSize];
    const loader = new IQRowLoader(
      meta.getBytesPerIQSample() * fftSize,
      (read, signal) => iqDataClient.readIQRows(meta, read, fftSize, signal),
      (slices) => {
        const previousData = queryClient.getQueryData<Float32Array[]>(rawKey);
        const sparseIQReturnData = [];
        slices.forEach((data) => {
          sparseIQReturnData[data.index] = data.iqArray;
        });
        queryClient.setQueryData(rawKey, Object.assign([], previousData, sparseIQReturnData));
      }
    );
    loaderRef.current = loader;
    loader.want(fftsRequired);
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [meta, type, account, container, filePath, fftSize]);

  useEffect(() => {
    loaderRef.current?.want(fftsRequired);
  }, [fftsRequired]);

  // fetches rawiqdata
  const { data: processedIQData, dataUpdatedAt: processedDataUpdated } = useQuery<number[][]>({
    queryKey: ['rawiqdata', type, account, container, filePath, fftSize],
    queryFn: async () => {
      return [];
    },
    select: useCallback(
      (data) => {
        if (!data) {
          return [];
        }
        // performance.mark('start');
        let currentProcessedData = queryClient.getQueryData<number[][]>([
          'processedIQData',
          type,
          account,
          container,
          filePath,
          fftSize,
          squareSignal,
        ]);

        if (!currentProcessedData) {
          currentProcessedData = [];
        }
        let currentIndexes = data.map((_, i) => i);
        // remove any data that have already being processed
        const dataRange = currentIndexes.filter((index) => !currentProcessedData[index]);

        groupContiguousIndexes(dataRange).forEach((group) => {
          const iqData = data.slice(group.start, group.start + group.count);
          const iqDataFloatArray = new Float32Array(iqData.length * fftSize * 2);
          iqData.forEach((data, index) => {
            iqDataFloatArray.set(data, index * fftSize * 2);
          });
          const result = applyProcessing(iqDataFloatArray, squareSignal);

          for (let i = 0; i < group.count; i++) {
            currentProcessedData[group.start + i] = result.slice(i * fftSize * 2, (i + 1) * fftSize * 2);
          }
        });
        // performance.mark('end');
        // const performanceMeasure = performance.measure('processing', 'start', 'end');
        queryClient.setQueryData(
          ['processedIQData', type, account, container, filePath, fftSize, squareSignal],
          currentProcessedData
        );

        return currentProcessedData;
      },
      [squareSignal, fftSize] // if any of these things change, it reprocesses the data
    ),
    enabled: !!meta,
  });

  const currentData = processedIQData; // without this line things break

  return {
    fftSize,
    currentData,
    fftsRequired,
    setFFTsRequired,
    processedDataUpdated,
  };
}

export function useRawIQData(type, account, container, filePath, fftSize) {
  const rawIQQuery = useQuery<Float32Array[]>({
    queryKey: ['rawiqdata', type, account, container, filePath, fftSize],
    queryFn: async () => null,
  });
  const downloadedIndexes = useMemo<number[]>(() => {
    if (!rawIQQuery.data) {
      return [];
    }
    // get all the array positions that have any data without use of reduce
    const downloadedIndexes = [];
    rawIQQuery.data.forEach((data, index) => {
      if (data) {
        downloadedIndexes.push(index);
      }
    });
    return downloadedIndexes;
  }, [rawIQQuery.data]);
  return {
    downloadedIndexes,
    rawIQQuery,
  };
}

export function useGetMinimapIQ(type: string, account: string, container: string, filePath: string, enabled = true) {
  const { data: meta } = useMeta(type, account, container, filePath);
  const iqDataClient = new UrlClient();
  const minimapQuery = useQuery<Float32Array[]>({
    queryKey: ['minimapiq', type, account, container, filePath],
    queryFn: async ({ signal }) => {
      const minimapIQ = await iqDataClient.getMinimapIQ(meta, signal);
      return minimapIQ;
    },
    enabled: enabled && !!meta,
  });
  return minimapQuery;
}
