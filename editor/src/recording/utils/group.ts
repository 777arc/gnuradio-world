import { IQ_MAX_READ_BYTES, IQ_READ_MERGE_GAP_BYTES } from './constants';

export function groupContiguousIndexes(indexes: number[]) {
  const contigousIndexes: { start: number; count: number }[] = [];
  if (indexes.length === 0) {
    return contigousIndexes;
  }
  indexes.sort((a, b) => a - b);
  for (let i = 0; i < indexes.length; i++) {
    const index = indexes[i];
    if (i === 0) {
      contigousIndexes.push({ start: index, count: 1 });
    } else {
      const lastContigousIndex = contigousIndexes[contigousIndexes.length - 1];
      if (lastContigousIndex.start + lastContigousIndex.count === index) {
        lastContigousIndex.count++;
      } else {
        contigousIndexes.push({ start: index, count: 1 });
      }
    }
  }

  return contigousIndexes;
}

// One range request: rows [start, start + count) of the file, of which only
// `rows` (ascending) are wanted -- the rest are read through because that is
// cheaper than a request each, see IQ_READ_MERGE_GAP_BYTES.
export interface IQRead {
  start: number;
  count: number;
  rows: number[];
}

// Turns the rows a view wants into the requests that fetch them. Rows are
// merged into one read while the gap between neighbours is at most
// mergeGapBytes and the read stays under maxReadBytes; contiguous rows, the 1x
// case, are therefore always one read per maxReadBytes. The result keeps the
// caller's priority: reads come back ordered by the earliest position any of
// their rows had in `rows`, so listing the visible rows before the padding
// fills the screen first. Duplicates are dropped; `rows` is not modified.
export function planIQReads(
  rows: number[],
  rowBytes: number,
  { mergeGapBytes = IQ_READ_MERGE_GAP_BYTES, maxReadBytes = IQ_MAX_READ_BYTES } = {}
): IQRead[] {
  const rank = new Map<number, number>();
  rows.forEach((row, position) => {
    if (!rank.has(row)) rank.set(row, position);
  });
  const sorted = [...rank.keys()].sort((a, b) => a - b);
  const maxGapRows = Math.floor(mergeGapBytes / rowBytes);
  const maxRows = Math.max(1, Math.floor(maxReadBytes / rowBytes));

  const reads: (IQRead & { priority: number })[] = [];
  let current: (IQRead & { priority: number }) | null = null;
  for (const row of sorted) {
    const gap = current ? row - (current.start + current.count) : Infinity;
    if (current && gap <= maxGapRows && row + 1 - current.start <= maxRows) {
      current.count = row + 1 - current.start;
      current.rows.push(row);
      current.priority = Math.min(current.priority, rank.get(row));
    } else {
      current = { start: row, count: 1, rows: [row], priority: rank.get(row) };
      reads.push(current);
    }
  }
  return reads
    .sort((a, b) => a.priority - b.priority)
    .map(({ start, count, rows }) => ({ start, count, rows }));
}
