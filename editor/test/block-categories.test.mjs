import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const blocks = library.blocks || [];
const byId = new Map(blocks.map(block => [block.id, block]));

assert.ok(blocks.length > 0, 'generated block library is empty');
assert.ok(blocks.every(block => Array.isArray(block.category)),
  'block categories must be path-segment arrays');
assert.deepEqual(byId.get('iio_device_source')?.category,
  ['Core', 'Industrial I/O', 'Generic']);
assert.deepEqual(byId.get('iio_fmcomms2_source')?.category,
  ['Core', 'Industrial I/O', 'FMComms']);
assert.deepEqual(byId.get('iio_pluto_source')?.category,
  ['Core', 'Industrial I/O', 'PlutoSDR']);

console.log('checked structured block-category paths');
