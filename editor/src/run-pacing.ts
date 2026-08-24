import type { Inst } from './graph-model';

export const UNPACED_RUN_WARNING_KEY = 'gnuradio-world.unpaced-run-warning-dismissed';

type RunBlock = Pick<Inst, 'id' | 'enabled' | 'bypassed'>;
type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

/** Whether an active block supplies the graph's clock or explicitly throttles it. */
export function hasActiveRateLimiter(
  blocks: readonly RunBlock[], rateLimiterIds: ReadonlySet<string>,
): boolean {
  return blocks.some(block =>
    block.enabled && !block.bypassed && rateLimiterIds.has(block.id));
}

/** A graph without one of GNU Radio's `throttle`-flagged blocks can run flat out. */
export function shouldWarnAboutUnpacedRun(
  blocks: readonly RunBlock[], rateLimiterIds: ReadonlySet<string>,
): boolean {
  return !hasActiveRateLimiter(blocks, rateLimiterIds);
}

export function unpacedRunWarningDismissed(storage?: ReadStorage): boolean {
  try { return (storage ?? localStorage).getItem(UNPACED_RUN_WARNING_KEY) === 'yes'; }
  catch { return false; }
}

export function dismissUnpacedRunWarning(storage?: WriteStorage): void {
  try { (storage ?? localStorage).setItem(UNPACED_RUN_WARNING_KEY, 'yes'); }
  catch { /* Storage can be unavailable in private or embedded contexts. */ }
}
