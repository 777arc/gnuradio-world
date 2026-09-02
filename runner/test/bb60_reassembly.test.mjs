// Drives the BB60 worker's block reassembler directly. It sits between two
// independently-read USB endpoints and the shared ring, and when it goes wrong
// the failure is a permanent stall rather than a glitch, so it is worth
// exercising away from hardware. Runs on plain Node.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'bb60_worker.js'), 'utf8');
const cut = source.indexOf('const encoder = new TextEncoder();');
const { createReassembler, BLOCK_WORDS, HEADER_WORDS, REORDER_WINDOW } = new Function(
  `${source.slice(0, cut)}; return { createReassembler, BLOCK_WORDS, HEADER_WORDS,` +
  ` REORDER_WINDOW };`)();

const BLOCKS_PER_TRANSFER = 8;

/** One transfer: 8 blocks whose seq numbers step by 2, as one endpoint sends. */
function transfer(firstSeq) {
  const words = new Int16Array(BLOCK_WORDS * BLOCKS_PER_TRANSFER);
  for (let b = 0; b < BLOCKS_PER_TRANSFER; b++) {
    const base = b * BLOCK_WORDS;
    const seq = (firstSeq + b * 2) & 0xffff;
    words[base] = 0x0201;
    words[base + 8] = seq;
    // Tag every sample with the sequence so ordering can be checked.
    words.fill(seq, base + HEADER_WORDS, base + BLOCK_WORDS);
  }
  return words;
}

function collector() {
  const seen = [];
  const r = createReassembler(block => seen.push(block[0] & 0xffff));
  return { r, seen };
}

// ---- in-order, perfectly alternating endpoints -----------------------------
{
  const { r, seen } = collector();
  for (let t = 0; t < 10; t++) {
    r.push(transfer(t * 16));          // 0x81: even sequences
    r.push(transfer(t * 16 + 1));      // 0x82: odd sequences
  }
  assert.equal(seen.length, 160, 'every block must be delivered');
  for (let i = 0; i < seen.length; i++)
    assert.equal(seen[i], i, `block ${i} out of order (got ${seen[i]})`);
  assert.equal(r.stats.gaps, 0, 'perfect input must report no gaps');
  assert.equal(r.stats.stale, 0);
}

// ---- one endpoint running far ahead of the other ---------------------------
// This is the case that broke on real hardware: with many transfers in flight
// the endpoints drift, and a window that is too small calls ordinary skew a
// loss, resynchronises past good data, and never recovers.
{
  const { r, seen } = collector();
  const AHEAD = 8;                       // 0x81 delivers 8 transfers first
  for (let t = 0; t < AHEAD; t++) r.push(transfer(t * 16));
  assert.equal(r.stats.gaps, 0,
    `skew of ${AHEAD} transfers must not be mistaken for loss`);
  for (let t = 0; t < AHEAD; t++) r.push(transfer(t * 16 + 1));
  assert.equal(seen.length, AHEAD * 16, 'all blocks arrive once skew resolves');
  for (let i = 0; i < seen.length; i++) assert.equal(seen[i], i, `order at ${i}`);
  assert.equal(r.stats.gaps, 0, 'no loss should be reported for pure skew');
}

// ---- a genuine hole, past the window --------------------------------------
{
  const { r, seen } = collector();
  r.push(transfer(0)); r.push(transfer(1));      // blocks 0..15 fine
  // Now skip a long way ahead, further than the window can hold.
  const far = 16 + REORDER_WINDOW * 2;
  for (let t = 0; t < REORDER_WINDOW / 4; t++) {
    r.push(transfer(far + t * 16));
    r.push(transfer(far + t * 16 + 1));
  }
  assert.ok(r.stats.gaps > 0, 'a real hole must eventually be reported');
  assert.ok(r.stats.lost > 0, 'and must account for the missing samples');
  assert.ok(seen.length > 16, 'delivery must resume after the hole');
  const tail = seen.slice(seen.indexOf(far));
  for (let i = 1; i < tail.length; i++)
    assert.equal(tail[i], (tail[i - 1] + 1) & 0xffff, 'still in order after resync');
}

// ---- late blocks from before the cursor are dropped, not hoarded -----------
{
  const { r } = collector();
  r.push(transfer(1000)); r.push(transfer(1001));
  const before = r.pendingSize;
  r.push(transfer(100));                       // long-stale transfer
  assert.equal(r.stats.stale, BLOCKS_PER_TRANSFER, 'stale blocks are counted');
  assert.ok(r.pendingSize <= before,
    'stale blocks must not accumulate in pending -- that is the stall');
}

// ---- the 16-bit sequence counter wraps ------------------------------------
{
  const { r, seen } = collector();
  const start = 0xfff0;
  for (let t = 0; t < 4; t++) {
    r.push(transfer((start + t * 16) & 0xffff));
    r.push(transfer((start + t * 16 + 1) & 0xffff));
  }
  assert.equal(seen.length, 64, 'delivery must continue across the wrap');
  for (let i = 1; i < seen.length; i++)
    assert.equal(seen[i], (seen[i - 1] + 1) & 0xffff, `wrap ordering at ${i}`);
  assert.equal(r.stats.gaps, 0, 'a wrap is not a loss');
}

console.log('bb60 reassembly tests passed');
