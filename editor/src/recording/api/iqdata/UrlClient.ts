import { IQDataClient } from './IQDataClient';
import { convertToFloat32 } from '@/utils/fetch-more-data-source';
import { SigMFMetadata } from '@/utils/sigmfMetadata';
import { IQDataSlice } from '@/api/Models';
import { groupContiguousIndexes } from '@/utils/group';
import { MINIMAP_FFT_SIZE, MINIMAP_NUM_FFTS, MINIMAP_MAX_CONCURRENT_FETCHES } from '@/utils/constants';
import { fetchIQRange, urlRecordingLocation } from '@/utils/url-datasource';

// Runs task(0..count-1) with at most `limit` of them outstanding. The minimap's
// reads are independent and tiny, so they are worth overlapping, but not worth
// firing all at once: a blob: source has no per-host connection cap to hold
// them back, and a remote one would spend a hundred of the browser's connection
// slots on a few hundred bytes each. The first failure stops the workers from
// picking up new work, which is what makes an aborted query (the reader
// navigating away mid-load) wind down instead of running to completion.
async function forEachWithConcurrency(count: number, limit: number, task: (index: number) => Promise<void>) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= count) return;
      try {
        await task(index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}

// Reads IQ out of a .sigmf-data served over plain HTTP, using range requests
// for the same reason the blob client uses ranged downloads: only the visible
// part of a recording is ever fetched.
export class UrlClient implements IQDataClient {
  private dataUrl(meta: SigMFMetadata): string {
    const { account, container } = meta.getOrigin();
    return urlRecordingLocation(account, container).dataUrl;
  }

  async getMinimapIQ(meta: SigMFMetadata, signal: AbortSignal): Promise<Float32Array[]> {
    const dataUrl = this.dataUrl(meta);
    const bytesPerIQSample = meta.getBytesPerIQSample();
    const totalSamples = meta.getTotalSamples();
    // MINIMAP_NUM_FFTS rows, evenly spaced over the whole recording, each one an
    // FFT's worth of consecutive samples read on its own. A recording too short
    // to fill that many rows gets as many as it has samples for; the stride is
    // then at least MINIMAP_FFT_SIZE, so no read runs off the end of the file
    // and every row comes back a whole FFT long.
    const numFfts = Math.min(MINIMAP_NUM_FFTS, Math.floor(totalSamples / MINIMAP_FFT_SIZE));
    if (numFfts < 1) {
      return [];
    }
    const strideSamples = Math.floor(totalSamples / numFfts);
    const countBytes = MINIMAP_FFT_SIZE * bytesPerIQSample;
    const iqBlocks = new Array<Float32Array>(numFfts);
    await forEachWithConcurrency(numFfts, MINIMAP_MAX_CONCURRENT_FETCHES, async (i) => {
      const offsetBytes = i * strideSamples * bytesPerIQSample;
      const buffer = await fetchIQRange(dataUrl, offsetBytes, countBytes, bytesPerIQSample, signal);
      iqBlocks[i] = convertToFloat32(buffer, meta.getDataType());
    });
    return iqBlocks;
  }

  async getIQDataBlocks(
    meta: SigMFMetadata,
    indexes: number[],
    blockSize: number,
    signal: AbortSignal
  ): Promise<IQDataSlice[]> {
    const dataUrl = this.dataUrl(meta);
    const contiguousIndexes = groupContiguousIndexes(indexes);
    const content = await Promise.all(
      contiguousIndexes.map((indexGroup) =>
        this.getIQDataBlockFromUrl(dataUrl, meta, indexGroup.start, indexGroup.count, blockSize, signal)
      )
    );
    return content.flat();
  }

  async getIQDataBlockFromUrl(
    dataUrl: string,
    meta: SigMFMetadata,
    index: number,
    count: number,
    blockSize: number,
    signal: AbortSignal
  ): Promise<IQDataSlice[]> {
    const bytesPerIQSample = meta.getBytesPerIQSample();
    const offsetBytes = index * blockSize * bytesPerIQSample;
    const countBytes = blockSize * count * bytesPerIQSample;
    const buffer = await fetchIQRange(dataUrl, offsetBytes, countBytes, bytesPerIQSample, signal);
    const iqArray = convertToFloat32(buffer, meta.getDataType());
    const iqBlocks: IQDataSlice[] = [];
    for (let i = 0; i < count; i++) {
      const offset = i * blockSize * 2;
      iqBlocks.push({ index: index + i, iqArray: iqArray.slice(offset, offset + blockSize * 2) });
    }
    return iqBlocks;
  }
}
