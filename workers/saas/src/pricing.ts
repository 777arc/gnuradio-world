export interface ModelRate {
  id: string;
  model: string;
  provider: string;
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  cacheWriteMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  markupBps: number;
  minimumChargeMicros: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface Charge {
  wholesaleMicros: number;
  retailMicros: number;
}

const MILLION = 1_000_000n;
const BPS = 10_000n;

const integer = (value: number, name: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return BigInt(value);
};

export const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;

const safeNumber = (value: bigint, name: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} exceeds the safe integer range`);
  return Number(value);
};

/** Money is integer micro-dollars throughout; each token component rounds up. */
export function priceUsage(rate: ModelRate, usage: TokenUsage): Charge {
  const input = integer(usage.inputTokens, 'inputTokens');
  const cached = integer(usage.cachedInputTokens, 'cachedInputTokens');
  const cacheWrite = integer(usage.cacheWriteTokens, 'cacheWriteTokens');
  const output = integer(usage.outputTokens, 'outputTokens');
  if (cached + cacheWrite > input) {
    throw new Error('cachedInputTokens plus cacheWriteTokens cannot exceed inputTokens');
  }

  const freshCost = ceilDiv(
    (input - cached - cacheWrite) * integer(rate.inputMicrosPerMillion, 'input rate'), MILLION);
  const cachedCost = ceilDiv(
    cached * integer(rate.cachedInputMicrosPerMillion, 'cached input rate'), MILLION);
  const cacheWriteCost = ceilDiv(
    cacheWrite * integer(rate.cacheWriteMicrosPerMillion, 'cache write rate'), MILLION);
  const outputCost = ceilDiv(
    output * integer(rate.outputMicrosPerMillion, 'output rate'), MILLION);
  const wholesale = freshCost + cachedCost + cacheWriteCost + outputCost;
  const markedUp = ceilDiv(
    wholesale * (BPS + integer(rate.markupBps, 'markupBps')), BPS);
  const retail = markedUp > integer(rate.minimumChargeMicros, 'minimum charge')
    ? markedUp : integer(rate.minimumChargeMicros, 'minimum charge');
  return {
    wholesaleMicros: safeNumber(wholesale, 'wholesale price'),
    retailMicros: safeNumber(retail, 'retail price'),
  };
}

/** Reserve input at its most expensive possible class plus the full output ceiling, then add 20%. */
export function estimateHold(rate: ModelRate, inputTokens: number, maxOutputTokens: number): number {
  const allCacheWrites = rate.cacheWriteMicrosPerMillion > rate.inputMicrosPerMillion;
  const priced = priceUsage(rate, {
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: allCacheWrites ? inputTokens : 0,
    outputTokens: maxOutputTokens,
  });
  return safeNumber(ceilDiv(BigInt(priced.retailMicros) * 12_000n, BPS), 'hold estimate');
}

export function rateFromRow(row: Record<string, unknown>): ModelRate {
  return {
    id: String(row.id),
    model: String(row.model),
    provider: String(row.provider),
    inputMicrosPerMillion: Number(row.input_micros_per_million),
    cachedInputMicrosPerMillion: Number(row.cached_input_micros_per_million),
    cacheWriteMicrosPerMillion: Number(row.cache_write_micros_per_million),
    outputMicrosPerMillion: Number(row.output_micros_per_million),
    markupBps: Number(row.markup_bps),
    minimumChargeMicros: Number(row.minimum_charge_micros),
  };
}
