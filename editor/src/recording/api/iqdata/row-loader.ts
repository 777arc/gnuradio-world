import { IQ_MAX_CONCURRENT_READS } from '@/utils/constants';
import { IQRead, planIQReads } from '@/utils/group';
import { IQDataSlice } from './UrlClient';

// Fetches the rows a view asks for, a bounded number of reads at a time, and
// hands each read's rows over the moment it lands. Upstream IQEngine put the
// wanted rows in a react-query key instead, which aborted every request in
// flight -- and dropped the rows already received with them -- each time the
// list changed, i.e. on every wheel tick. Zoomed out, where a screen is
// hundreds of separate requests, that never converged. Here `want()` merely
// replaces the list: reads under way finish and land, and the next reads are
// planned from whatever is still wanted, not yet landed and not in flight.
//
// The loader does not know what is already cached; the caller filters that out
// before calling want(). `landed` only covers the moment between a read
// landing and the caller asking again with that row gone.
export class IQRowLoader {
  private wanted: number[] = [];
  private inFlight = new Set<number>();
  private landed = new Set<number>();
  private active = 0;
  private controller = new AbortController();

  constructor(
    private rowBytes: number,
    private read: (read: IQRead, signal: AbortSignal) => Promise<IQDataSlice[]>,
    private onRows: (slices: IQDataSlice[]) => void,
    private limit = IQ_MAX_CONCURRENT_READS
  ) {}

  want(rows: number[]): void {
    this.wanted = rows;
    this.pump();
  }

  // Aborts the reads in flight; nothing lands after this.
  dispose(): void {
    this.controller.abort();
    this.wanted = [];
  }

  private pump(): void {
    if (this.controller.signal.aborted || this.active >= this.limit) return;
    const todo = this.wanted.filter((row) => !this.landed.has(row) && !this.inFlight.has(row));
    if (todo.length === 0) return;
    for (const read of planIQReads(todo, this.rowBytes)) {
      if (this.active >= this.limit) break;
      this.start(read);
    }
  }

  private start(read: IQRead): void {
    this.active++;
    read.rows.forEach((row) => this.inFlight.add(row));
    this.read(read, this.controller.signal)
      .then((slices) => {
        if (this.controller.signal.aborted) return;
        slices.forEach((slice) => this.landed.add(slice.index));
        this.onRows(slices);
      })
      .catch((error) => {
        if (this.controller.signal.aborted) return;
        // Not retried here: the rows stay wanted only until the caller asks
        // again (it does on every scroll and every other read landing), which
        // keeps a dead host from being hammered in a loop.
        const failed = new Set(read.rows);
        this.wanted = this.wanted.filter((row) => !failed.has(row));
        console.error('reading IQ rows failed:', error);
      })
      .finally(() => {
        read.rows.forEach((row) => this.inFlight.delete(row));
        this.active--;
        this.pump();
      });
  }
}
