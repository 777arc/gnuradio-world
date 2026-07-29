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

const addedWasmBlocks = [
  'blocks_correctiq',
  'blocks_correctiq_auto',
  'blocks_correctiq_man',
  'blocks_freqshift_cc',
  'blocks_phase_shift',
  'blocks_swapiq',
  'filter_delay_fc',
  'filterbank_vcvcf',
  'ival_decimator',
  'fec_ber_bf',
  'fec_encode_ccsds_27_bb',
  'fec_decode_ccsds_27_fb',
  'fec_depuncture_bb',
  'fec_puncture_xx',
  'digital_constellation_decoder_cb',
  'digital_constellation_encoder_bc',
  'digital_constellation_receiver_cb',
  'digital_constellation_soft_decoder_cf',
  'digital_meas_evm_cc',
  'digital_symbol_sync_xx',
  'variable_qtgui_check_box',
  'variable_qtgui_entry',
];
for (const id of addedWasmBlocks)
  assert.equal(byId.get(id)?.runnable, true, `${id} must stay runnable in WASM`);

console.log('checked structured block-category paths and added WASM blocks');
