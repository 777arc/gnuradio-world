import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';

const { comparePaletteCategoryNames } =
  await bundleModule('../src/palette-tree.ts');

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const modules = JSON.parse(await readFile(
  new URL('../../runner/modules.json', import.meta.url), 'utf8'));
const blocks = library.blocks || [];
const byId = new Map(blocks.map(block => [block.id, block]));

assert.ok(blocks.length > 0, 'generated block library is empty');
assert.ok(blocks.every(block => Array.isArray(block.category)),
  'block categories must be path-segment arrays');

// Source provenance is not the same thing as the runner chunk: unsupported OOT
// blocks and hand-written factories can both report `module: core`. Every
// top-level vendored gr-* checkout still gets one stable palette root.
const ootBlocks = blocks.filter(block => block.oot_module);
const expectedOots = modules.deferred
  .filter(module => !modules.in_tree_deferred.includes(module))
  .map(module => `gr-${module}`)
  .sort();
assert.deepEqual([...new Set(ootBlocks.map(block => block.oot_module))].sort(), expectedOots,
  'every configured OOT must contribute source provenance to the block catalog');
for (const block of ootBlocks) {
  assert.equal(block.category[0], block.oot_module,
    `${block.id} must live under its source OOT at the palette root`);
}
assert.deepEqual(byId.get('ham_chu_decode')?.category, ['gr-ham']);
assert.deepEqual(byId.get('satellites_aalto1_deframer')?.category,
  ['gr-satellites', 'Deframers'], 'an OOT must retain useful nested categories');
assert.deepEqual(byId.get('dvbs2rx_ldpc_decoder_cb')?.category,
  ['gr-dvbs2rx', 'DVB-S2 RX'], 'an overlay may still supply the category tail');
assert.equal(byId.get('ham_dstar_rx')?.runnable, false);
assert.equal(byId.get('ham_dstar_rx')?.module, 'core');
assert.equal(byId.get('ham_dstar_rx')?.oot_module, 'gr-ham',
  'an unavailable block must not lose the OOT it came from');
assert.deepEqual(byId.get('iio_device_source')?.category,
  ['Core', 'Industrial I/O', 'Generic']);
assert.deepEqual(byId.get('iio_fmcomms2_source')?.category,
  ['Core', 'Industrial I/O', 'FMComms']);
assert.deepEqual(byId.get('iio_pluto_source')?.category,
  ['Core', 'Industrial I/O', 'PlutoSDR']);
assert.equal(byId.has('fosphor_glfw_sink_c'), false,
  'the standalone GLFW sink has no browser equivalent and must stay hidden');
assert.equal(byId.get('fosphor_qt_sink_c')?.runnable, true,
  'the embedded Qt fosphor sink must stay runnable');
assert.equal(byId.get('fosphor_qt_sink_c')?.label, 'Fosphor Sink',
  'the browser exposes the remaining fosphor implementation as Fosphor Sink');
assert.deepEqual(byId.get('fosphor_qt_sink_c')?.category,
  ['gr-fosphor', 'Instrumentation', 'QT'],
  'an OOT formerly filed under Core must keep its useful category tail');

const supportedSdrBlocks = new Map([
  ['wasm_rtlsdr_source', '👂 RTL-SDR Source'],
  ['wasm_hackrf_source', '👂 HackRF Source'],
  ['wasm_hackrf_sink', '🛜 HackRF Sink'],
  ['wasm_plutosdr_source', '👂 PlutoSDR Source'],
  ['wasm_plutosdr_sink', '🛜 PlutoSDR Sink'],
]);
for (const [id, label] of supportedSdrBlocks) {
  assert.equal(byId.get(id)?.runnable, true, `${id} must stay runnable in WASM`);
  assert.deepEqual(byId.get(id)?.category, ['Supported SDRs'],
    `${id} must appear in the root-level Supported SDRs category`);
  assert.equal(byId.get(id)?.label, label,
    `${id} must show whether it receives or transmits`);
}

const worldBlocks = new Map([
  ['epy_block', ['GNU Radio World']],
  ['hrpt_image_sink', ['GNU Radio World']],
  ['js_clip_cc', ['GNU Radio World']],
  ['js_peak_hold_ff', ['GNU Radio World']],
  ['js_phase_unwrap_ff', ['GNU Radio World']],
  ['wasm_gr_world_recording', ['GNU Radio World']],
  ['wasm_gui_layout', ['GNU Radio World']],
  ['wasm_js_block', ['GNU Radio World']],
  ['wasm_musical_keyboard_source', ['GNU Radio World']],
  ['wasm_packet_rate_sink', ['GNU Radio World']],
  ['wasm_public_http_recording', ['GNU Radio World']],
  ['wasm_sigmf_sink', ['GNU Radio World']],
  ['wasm_sigmf_source', ['GNU Radio World']],
  ['wasm_text_sink', ['GNU Radio World']],
]);
for (const [id, category] of worldBlocks)
  assert.deepEqual(byId.get(id)?.category, category,
    `${id} must appear beneath the GNU Radio World palette root`);
for (const id of supportedSdrBlocks.keys())
  assert.notEqual(byId.get(id)?.category?.[0], 'GNU Radio World',
    `${id} is hardware and must remain outside GNU Radio World`);

const paletteRoots = [...new Set(blocks.map(block => block.category[0]))]
  .sort((a, b) => comparePaletteCategoryNames(a, b, 0));
assert.equal(paletteRoots[0], 'Supported SDRs',
  'Supported SDRs must remain the first palette category');
assert.equal(paletteRoots[paletteRoots.indexOf('Core') + 1], 'GNU Radio World',
  'GNU Radio World must immediately follow Core in the palette');

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
