// Multi-scenario verification of on-demand category loading.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { contentType, launchBrowser, setIsolationHeaders } from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);
const PORT = 8096;
let fetched = [];
const server = http.createServer(async (req, res) => {
  setIsolationHeaders(res);
  try {
    let p = decodeURIComponent(new URL(req.url,'http://x').pathname);
    if (p.endsWith('.wasm')) fetched.push(p.split('/').pop());
    if (p.endsWith('/')) p += 'index.html';
    const fp = normalize(join(ROOT,p));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const b = await readFile(fp);
    res.setHeader('Content-Type', contentType(fp));
    res.writeHead(200); res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, r));

const satellitesTestPacket = [
  1, 2, 3, 10,
  ...Array.from({ length: 219 }, (_, index) => (index + 5) & 0xff),
];

const scenarios = [
  { name: 'core-only (no deferred block)',
    fg: { blocks:[
      { name:'src', id:'analog_sig_source_x', params:{ type:'float', samp_rate:32000, waveform:'cos', frequency:1000, amplitude:1.0 } },
      { name:'thr', id:'blocks_throttle2', params:{ type:'float', samples_per_second:32000, vlen:1, ignoretag:'True', limit:'auto', maximum:0.1 } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'float' } } ],
      connections:[['src',0,'thr',0],['thr',0,'snk',0]] },
    expectFetch: [] },
  { name: 'vocoder (deferred)',
    fg: { blocks:[
      { name:'src', id:'blocks_null_source', params:{ type:'short' } },
      { name:'enc', id:'vocoder_alaw_encode_sb', params:{} },
      { name:'snk', id:'blocks_null_sink', params:{ type:'byte' } } ],
      connections:[['src',0,'enc',0],['enc',0,'snk',0]] },
    expectFetch: ['vocoder.wasm'] },
  { name: 'gr-droneid (OOT deferred)',
    fg: { blocks:[
      { name:'src', id:'analog_sig_source_x',
        params:{ type:'complex', samp_rate:32000, waveform:'cos',
                 frequency:1000, amplitude:1.0 } },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'complex', samples_per_second:32000, vlen:1,
                 ignoretag:'True', limit:'auto', maximum:0.1 } },
      { name:'xcorr', id:'droneid_normalized_xcorr_estimate',
        params:{ taps:'[[1,0],[-1,0]]' } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'complex' } },
      // Construct the remaining native factories too. Their message handlers
      // need a complete DroneID burst, so the lazy-load check leaves them idle.
      { name:'extract', id:'droneid_extractor',
        params:{ sample_rate:30720000, threshold:2.0 } },
      { name:'sync', id:'droneid_time_sync',
        params:{ sample_rate:30720000, debug_path:'' } },
      { name:'demod', id:'droneid_demodulation',
        params:{ sample_rate:30720000, debug_path:'' } },
      { name:'decode', id:'droneid_decode', params:{ debug_path:'' } } ],
      connections:[['src',0,'thr',0],['thr',0,'xcorr',0],['xcorr',0,'snk',0]] },
    expectFetch: ['droneid.wasm'] },
  { name: 'gr-fosphor overlap (OOT deferred)',
    fg: { blocks:[
      { name:'src', id:'blocks_null_source', params:{ type:'complex' } },
      { name:'overlap', id:'overlap_cc', params:{ wlen:1024, overlap:4 } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'complex' } } ],
      connections:[['src',0,'overlap',0],['overlap',0,'snk',0]] },
    expectFetch: ['fosphor.wasm'] },
  { name: 'gr-fosphor Qt sink (browser backend)',
    fg: { blocks:[
      { name:'src', id:'analog_sig_source_x', params:{ type:'complex', samp_rate:32000, waveform:'cos', frequency:1000, amplitude:1.0 } },
      { name:'thr', id:'blocks_throttle2', params:{ type:'complex', samples_per_second:32000, vlen:1, ignoretag:'True', limit:'auto', maximum:0.1 } },
      { name:'snk', id:'fosphor_qt_sink_c', params:{ wintype:'window.WIN_HANN', freq_center:0, freq_span:32000, gui_hint:'' } } ],
      connections:[['src',0,'thr',0],['thr',0,'snk',0]] },
    expectFetch: [], expectBackend: 'cpu' },
  { name: 'gr-satellites (OOT deferred)',
    fg: { blocks:[
      { name:'src', id:'blocks_null_source', params:{ type:'byte' } },
      { name:'enc', id:'satellites_nrzi_encode', params:{} },
      { name:'snk', id:'blocks_null_sink', params:{ type:'byte' } },
      // Construct every runner-owned utility and every native RS alias. Most
      // are message-only blocks, so leaving their ports disconnected is enough
      // to catch missing factories, parameter lowering, and side-module imports.
      { name:'aausat4', id:'satellites_aausat4_check_fsm', params:{} },
      { name:'beesat', id:'satellites_beesat_classifier', params:{} },
      { name:'cc11xx', id:'satellites_cc11xx_packet_crop', params:{} },
      { name:'check_address', id:'satellites_check_address', params:{} },
      { name:'astrocast_crc', id:'satellites_check_astrocast_crc', params:{} },
      { name:'check_hex', id:'satellites_check_hex_string', params:{} },
      { name:'csp_filter', id:'satellites_csp_address_filter', params:{} },
      { name:'decode_ccsds', id:'satellites_decode_rs_ccsds', params:{} },
      { name:'encode_ccsds', id:'satellites_encode_rs_ccsds', params:{} },
      { name:'encode_ccsds_vector', id:'satellites_encode_rs_ccsds_vector', params:{} },
      { name:'encode_rs_vector', id:'satellites_encode_rs_vector', params:{} },
      { name:'eseo_crop', id:'satellites_eseo_packet_crop', params:{} },
      { name:'hdlc_framer', id:'satellites_hdlc_framer', params:{} },
      { name:'ks1q', id:'satellites_ks1q_header_remover', params:{} },
      { name:'ngham_crop', id:'satellites_ngham_packet_crop', params:{} },
      { name:'ngham_padding', id:'satellites_ngham_remove_padding', params:{} },
      { name:'print_header', id:'satellites_print_header', params:{} },
      { name:'print_timestamp', id:'satellites_print_timestamp', params:{} },
      { name:'reflect', id:'satellites_reflect_bytes', params:{} },
      { name:'snet_classifier', id:'satellites_snet_classifier', params:{} },
      { name:'swap_crc', id:'satellites_swap_crc', params:{} },
      { name:'swap_header', id:'satellites_swap_header', params:{} },
      { name:'swiatowid_crop', id:'satellites_swiatowid_packet_crop', params:{} },
      { name:'swiatowid_split', id:'satellites_swiatowid_packet_split', params:{} },
      { name:'sx12xx', id:'satellites_sx12xx_packet_crop', params:{} } ],
      connections:[['src',0,'enc',0],['enc',0,'snk',0]] },
    expectFetch: ['pdu.wasm', 'satellites.wasm'] },
  { name: 'gr-satellites message transforms',
    fg: { blocks:[
      { name:'src', id:'blocks_vector_source_x',
        params:{ type:'byte', vector:JSON.stringify(satellitesTestPacket),
                 repeat:'False', vlen:1 } },
      { name:'tagger', id:'blocks_stream_to_tagged_stream',
        params:{ type:'byte', vlen:1, packet_len:223, len_tag_key:'packet_len' } },
      { name:'to_pdu', id:'satellites_fixedlen_to_pdu',
        params:{ type:'byte', syncword_tag:'packet_len', packet_len:223,
                 pack:'False', packet_len_tag_key:'packet_len' } },
      { name:'reflect_1', id:'satellites_reflect_bytes', params:{} },
      { name:'reflect_2', id:'satellites_reflect_bytes', params:{} },
      { name:'swap_1', id:'satellites_swap_header', params:{} },
      { name:'swap_2', id:'satellites_swap_header', params:{} },
      { name:'rs_encode', id:'satellites_encode_rs_ccsds',
        params:{ basis:'False', interleave:1 } },
      { name:'rs_decode', id:'satellites_decode_rs_ccsds',
        params:{ basis:'False', interleave:1 } },
      { name:'check', id:'satellites_check_hex_string',
        params:{ hexstring:'0102030a', startindex:0 } },
      { name:'debug', id:'blocks_message_debug',
        params:{ en_uvec:'True', log_level:'info' } } ],
      connections:[
        ['src',0,'tagger',0],
        ['tagger',0,'to_pdu',0],
        { src_blk_id:'to_pdu', src_port_id:'pdus',
          snk_blk_id:'reflect_1', snk_port_id:'in' },
        { src_blk_id:'reflect_1', src_port_id:'out',
          snk_blk_id:'reflect_2', snk_port_id:'in' },
        { src_blk_id:'reflect_2', src_port_id:'out',
          snk_blk_id:'swap_1', snk_port_id:'in' },
        { src_blk_id:'swap_1', src_port_id:'out',
          snk_blk_id:'swap_2', snk_port_id:'in' },
        { src_blk_id:'swap_2', src_port_id:'out',
          snk_blk_id:'rs_encode', snk_port_id:'in' },
        { src_blk_id:'rs_encode', src_port_id:'out',
          snk_blk_id:'rs_decode', snk_port_id:'in' },
        { src_blk_id:'rs_decode', src_port_id:'out',
          snk_blk_id:'check', snk_port_id:'in' },
        { src_blk_id:'check', src_port_id:'ok',
          snk_blk_id:'debug', snk_port_id:'print_pdu' },
      ] },
    expectFetch: ['pdu.wasm', 'satellites.wasm'],
    expectLog: '01 02 03 0a 05 06 07 08' },
  // gr-ham (OOT deferred), and the only check anywhere that its varicode codec
  // is right: encode a message, decode it straight back, and require the exact
  // text out of the Text Sink. Max Line Length matches the message so each
  // flushed line is one whole repetition.
  { name: 'gr-ham varicode round trip (OOT deferred)',
    fg: { blocks:[
      { name:'msg', id:'blocks_vector_source_x',
        params:{ type:'byte', repeat:'True', vlen:1,
                 vector:'[67,81,32,84,69,83,84,32,68,69,32,86,69,51,88,89,90]' } },
      { name:'encode', id:'ham_varicode_tx', params:{} },
      { name:'decode', id:'ham_varicode_rx', params:{} },
      { name:'text', id:'wasm_text_sink', params:{ prefix:'', max_line:17 } },
      // Constructed but left unfed: the CHU decoder needs a real 4800 sample/s
      // burst, so this only checks its factory and side-module imports.
      { name:'chu', id:'ham_chu_decode', params:{} } ],
      connections:[['msg',0,'encode',0],['encode',0,'decode',0],['decode',0,'text',0]] },
    expectFetch: ['ham.wasm'],
    expectLog: 'CQ TEST DE VE3XYZ' },
  // gr-ieee802-11 (OOT deferred). Its receive chain is upstream wifi_phy_hier's,
  // expanded inline because that is a GRC hier block and the browser has no
  // Python to build one: Schmidl-Cox autocorrelation into Sync Short, Sync Long,
  // a 64-point inverse FFT, the frame equalizer, and the MAC decode/parse pair.
  // Noise in decodes nothing, which is the point -- the check here is that the
  // side module loads and the whole chain constructs and runs.
  //
  // It is also the one scenario that proves the deferred-to-deferred edge in
  // modules.json works from a *block* rather than a rebuilt hierarchy: this
  // module's constellations derive from gr-digital's, so digital.wasm has to be
  // fetched first for those imports to resolve.
  { name: 'gr-ieee802-11 receive chain (OOT deferred, needs digital)',
    fg: { blocks:[
      { name:'src', id:'analog_noise_source_x',
        params:{ type:'complex', noise_type:'analog.GR_GAUSSIAN', amp:1, seed:42 } },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'complex', samples_per_second:1000000, vlen:1,
                 ignoretag:'True', limit:'time', maximum:0.1 } },
      // Delay-and-correlate over the short training sequence: |sum(x[n]x*[n-16])|
      // normalised by the moving-average power, which is Sync Short's plateau.
      { name:'delay16', id:'blocks_delay', params:{ type:'complex', delay:16, num_ports:1, vlen:1 } },
      { name:'conj', id:'blocks_conjugate_cc', params:{} },
      { name:'mult', id:'blocks_multiply_xx', params:{ type:'complex', num_inputs:2, vlen:1 } },
      { name:'mavg_c', id:'blocks_moving_average_xx',
        params:{ type:'complex', length:48, scale:1, max_iter:4000, vlen:1 } },
      { name:'cmag', id:'blocks_complex_to_mag', params:{ vlen:1 } },
      { name:'cmag2', id:'blocks_complex_to_mag_squared', params:{ vlen:1 } },
      { name:'mavg_f', id:'blocks_moving_average_xx',
        params:{ type:'float', length:64, scale:1, max_iter:4000, vlen:1 } },
      { name:'div', id:'blocks_divide_xx', params:{ type:'float', num_inputs:2, vlen:1 } },
      { name:'sync_short', id:'ieee802_11_sync_short',
        params:{ threshold:0.56, min_plateau:2, log:'False', debug:'False' } },
      { name:'delay320', id:'blocks_delay', params:{ type:'complex', delay:320, num_ports:1, vlen:1 } },
      { name:'sync_long', id:'ieee802_11_sync_long',
        params:{ sync_length:320, log:'False', debug:'False' } },
      { name:'s2v', id:'blocks_stream_to_vector', params:{ type:'complex', num_items:64, vlen:1 } },
      // The *receive* FFT: forward and unwindowed (upstream's
      // `window.rectangular(64)`, pre-computed because a .grc handed straight to
      // runner.html gets no expression pass). The 1/sqrt(52)-scaled inverse FFT
      // in the same hier block is the transmitter's, and swapping the two leaves
      // the chain looking healthy while decoding nothing.
      { name:'fft', id:'fft_vxx',
        params:{ type:'complex', fft_size:64, forward:'True', shift:'True', nthreads:1,
                 window:`[${Array(64).fill('1.0').join(',')}]` } },
      { name:'feq', id:'ieee802_11_frame_equalizer',
        params:{ algo:'ieee802_11.LS', freq:5890000000, bw:10000000,
                 log:'False', debug:'False' } },
      { name:'decode', id:'ieee802_11_decode_mac', params:{ log:'False', debug:'False' } },
      { name:'parse', id:'ieee802_11_parse_mac', params:{ log:'False', debug:'False' } },
      { name:'csi', id:'ieee802_11_extract_csi', params:{} },
      // Extract CSI emits one 52-carrier vector per frame; unpack it to a plain
      // stream rather than giving the null sink a vlen, which its factory ignores.
      { name:'csi_v2s', id:'blocks_vector_to_stream',
        params:{ type:'complex', vlen:1, num_items:52 } },
      { name:'csi_sink', id:'blocks_null_sink', params:{ type:'complex', vlen:1, num_inputs:1 } },
      // The chunk mapper runs on its own: bytes in, BPSK symbols out.
      { name:'bytes', id:'blocks_null_source', params:{ type:'byte', vlen:1, num_outputs:1 } },
      { name:'chunks', id:'ieee802_11_chunks_to_symbols_xx', params:{} },
      { name:'chunk_sink', id:'blocks_null_sink', params:{ type:'complex', vlen:1, num_inputs:1 } },
      // The transmit blocks are constructed but left unconnected: each is driven
      // by a PDU, and this runtime has no message source to hand them one. So
      // this covers their factories and side-module imports only. The rest of the
      // transmitter cannot be assembled here at all -- upstream feeds the mapper
      // into digital_packet_headergenerator_bb and digital_ofdm_carrier_allocator_cvc,
      // both of which need a typed GRC companion object and are permanently in
      // generated_blocks.json's `skipped`.
      // Upstream writes these as [0x23]*6; decimal here because this path gets
      // no expression pass and 0x23 is not JSON.
      { name:'mac', id:'ieee802_11_mac',
        params:{ src_mac:'[35, 35, 35, 35, 35, 35]',
                 dst_mac:'[66, 66, 66, 66, 66, 66]',
                 bss_mac:'[255, 255, 255, 255, 255, 255]' } },
      { name:'mapper', id:'ieee802_11_mapper',
        params:{ encoding:'ieee802_11.QPSK_3_4', debug:'False' } },
      { name:'crc', id:'ieee802_11_append_crc32', params:{ append:'True' } },
      { name:'encap', id:'ieee802_11_ether_encap', params:{ debug:'False' } } ],
      connections:[
        ['src',0,'thr',0],
        ['thr',0,'delay16',0], ['thr',0,'mult',0], ['thr',0,'cmag2',0],
        ['delay16',0,'conj',0], ['delay16',0,'sync_short',0],
        ['conj',0,'mult',1],
        ['mult',0,'mavg_c',0],
        ['mavg_c',0,'cmag',0], ['mavg_c',0,'sync_short',1],
        ['cmag',0,'div',0],
        ['cmag2',0,'mavg_f',0],
        ['mavg_f',0,'div',1],
        ['div',0,'sync_short',2],
        ['sync_short',0,'delay320',0], ['sync_short',0,'sync_long',0],
        ['delay320',0,'sync_long',1],
        ['sync_long',0,'s2v',0],
        ['s2v',0,'fft',0],
        ['fft',0,'feq',0],
        ['feq',0,'decode',0],
        { src_blk_id:'decode', src_port_id:'out',
          snk_blk_id:'parse', snk_port_id:'in' },
        { src_blk_id:'parse', src_port_id:'out',
          snk_blk_id:'csi', snk_port_id:'pdu in' },
        ['csi',0,'csi_v2s',0], ['csi_v2s',0,'csi_sink',0],
        ['bytes',0,'chunks',0], ['chunks',0,'chunk_sink',0],
      ] },
    expectFetch: ['digital.wasm', 'ieee802_11.wasm'] },
  // gr-ieee802-15-4 (OOT deferred). The QPSK mapper/demapper round trip moves
  // samples through the side module, while the codeword round trip exercises
  // the browser-side nested-vector parser used by the CSS primitives. The
  // message-only blocks cover byte-vector and narrowed RIME parameters too.
  { name: 'gr-ieee802-15-4 QPSK and codeword chains (OOT deferred)',
    fg: { blocks:[
      { name:'i_src', id:'blocks_vector_source_x',
        params:{ type:'int', vector:'[1, -1, 1, -1]', repeat:'True', vlen:1 } },
      { name:'q_src', id:'blocks_vector_source_x',
        params:{ type:'int', vector:'[1, 1, -1, -1]', repeat:'True', vlen:1 } },
      { name:'qpsk_map', id:'ieee802_15_4_qpsk_mapper_if', params:{} },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'float', samples_per_second:32000, vlen:1,
                 ignoretag:'True', limit:'time', maximum:0.1 } },
      { name:'qpsk_demap', id:'ieee802_15_4_qpsk_demapper_fi', params:{} },
      { name:'i_sink', id:'blocks_null_sink', params:{ type:'int' } },
      { name:'q_sink', id:'blocks_null_sink', params:{ type:'int' } },
      { name:'bits', id:'blocks_vector_source_x',
        params:{ type:'byte', vector:'[0, 1]', repeat:'True', vlen:1 } },
      { name:'cw_map', id:'ieee802_15_4_codeword_mapper_bi',
        params:{ bits_per_cw:1, codewords:'[[1, -1], [-1, 1]]' } },
      { name:'cw_demap', id:'ieee802_15_4_codeword_demapper_ib',
        params:{ bits_per_cw:1, codewords:'[[1, -1], [-1, 1]]' } },
      { name:'bit_sink', id:'blocks_null_sink', params:{ type:'byte' } },
      { name:'access_prefix', id:'ieee802_15_4_access_code_prefixer',
        params:{ pad:0, preamble:167 } },
      { name:'phr_prefix', id:'ieee802_15_4_phr_prefixer',
        params:{ phr:'[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]' } },
      { name:'phr_remove', id:'ieee802_15_4_phr_removal',
        params:{ phr:'[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]' } },
      { name:'mac', id:'ieee802_15_4_mac',
        params:{ debug:'False', fcf:34881, seq_nr:0, dst_pan:6826,
                 dst:65535, src:13124 } },
      // An empty reliable-unicast channel list avoids starting its background
      // retransmission thread in a factory-only lazy-load scenario.
      { name:'rime', id:'ieee802_15_4_rime_stack',
        params:{ bc_channels:'[129]', uc_channels:'[130]', ruc_channels:'[]',
                 rime_add:'[23, 42]' } } ],
      connections:[
        ['i_src',0,'qpsk_map',0], ['q_src',0,'qpsk_map',1],
        ['qpsk_map',0,'thr',0], ['thr',0,'qpsk_demap',0],
        ['qpsk_demap',0,'i_sink',0], ['qpsk_demap',1,'q_sink',0],
        ['bits',0,'cw_map',0], ['cw_map',0,'cw_demap',0],
        ['cw_demap',0,'bit_sink',0],
      ] },
    expectFetch: ['ieee802_15_4.wasm'] },
  { name: 'gr-hrpt NOAA chain + image sink (OOT deferred)',
    fg: { blocks:[
      { name:'src', id:'analog_noise_source_x',
        params:{ type:'complex', noise_type:'analog.GR_GAUSSIAN', amp:1, seed:42 } },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'complex', samples_per_second:665400, vlen:1,
                 ignoretag:'True', limit:'time', maximum:0.1 } },
      { name:'pll', id:'noaa_hrpt_pll_cf',
        params:{ alpha:0.01, beta:0.0001, max_offset:0.03 } },
      { name:'slice', id:'digital_binary_slicer_fb', params:{} },
      { name:'deframe', id:'noaa_hrpt_deframer', params:{} },
      { name:'decode', id:'noaa_hrpt_decoder', params:{ verbose:'False', output:'False' } },
      { name:'image', id:'hrpt_image_sink',
        params:{ name:'HRPT Image', channel:2, image_width:2048,
                 words_per_line:11090, video_start:751, invert:'False',
                 max_lines:200 } },
      // Construct the MetOp/FengYun-3 factories too -- unconnected, since they
      // expect a Viterbi-coded QPSK chain this fixture does not build, but this
      // still covers their factories and confirms they share hrpt.wasm.
      { name:'metop_viterbi', id:'viterbi_metop_decoder',
        params:{ sync_check:'True', ber_threshold:0.1, insync_after:5,
                 outsync_after:20, reset_after:50 } },
      { name:'metop_deframe', id:'metop_cadu_deframer',
        params:{ sync_check:'True', frame_length:1024, insync_after:5,
                 outsync_after:20 } },
      { name:'fengyun_viterbi', id:'viterbi_fengyun_decoder',
        params:{ sync_check:'True', ber_threshold:0.1, insync_after:5,
                 outsync_after:20, reset_after:50 } },
      { name:'fengyun_diff', id:'hrpt_fengyun_diff_decoder', params:{} } ],
      connections:[
        ['src',0,'thr',0],
        ['thr',0,'pll',0],
        ['pll',0,'slice',0],
        ['slice',0,'deframe',0],
        ['deframe',0,'decode',0], ['deframe',0,'image',0],
      ] },
    expectFetch: ['digital.wasm', 'hrpt.wasm'] },
  { name: 'gr-lora_sdr TX/RX hierarchies (OOT deferred)',
    fg: { blocks:[
      { name:'payload', id:'blocks_message_strobe',
        params:{ msg:'pmt.intern("lora")', period:500 } },
      { name:'tx', id:'lora_tx',
        params:{ samp_rate:500000, bw:125000, sf:7, impl_head:'False', cr:1,
                 has_crc:'True', ldro:2, sync_word:'[18]', frame_zero_padd:1280 } },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'complex', samples_per_second:500000, vlen:1,
                 ignoretag:'True', limit:'auto', maximum:0.1 } },
      { name:'rx', id:'lora_rx',
        params:{ samp_rate:500000, bw:125000, sf:7, impl_head:'False', cr:1,
                 has_crc:'True', pay_len:255, soft_decoding:'False', ldro:2,
                 sync_word:'[18]', print_rx:'[True,True]' } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'byte' } },
      // The hierarchies cover every stream block in the module between them;
      // these three are message-only, so construct them unconnected to reach
      // their factories too.
      { name:'radiohead', id:'lora_sdr_RH_RF95_header',
        params:{ _to:255, _from:255, _id:0, _flags:0 } },
      { name:'random', id:'lora_sdr_data_source', params:{ pay_len:16, n_frames:10 } },
      { name:'increment', id:'lora_sdr_payload_id_inc', params:{ separator:':' } } ],
      connections:[
        ['tx',0,'thr',0], ['thr',0,'rx',0], ['rx',0,'snk',0],
        { src_blk_id:'payload', src_port_id:'strobe',
          snk_blk_id:'tx', snk_port_id:'in' },
      ] },
    expectFetch: ['lora_sdr.wasm'] },

  { name: 'gr-radar FSK measurement chain (OOT deferred)',
    fg: { blocks:[
      { name:'gen', id:'radar_signal_generator_fsk_c',
        params:{ samp_rate:32000, samp_per_freq:1, blocks_per_tag:256,
                 freq_low:-4000, freq_high:4000, amplitude:1,
                 len_key:'"packet_len"' } },
      { name:'thr', id:'blocks_throttle2',
        params:{ type:'complex', samples_per_second:32000, vlen:1,
                 ignoretag:'True', limit:'auto', maximum:0.1 } },
      { name:'target', id:'radar_static_target_simulator_cc',
        params:{ range:'[10]', velocity:'[5]', rcs:'[1e16]', azimuth:'[0]',
                 position_rx:'[0]', samp_rate:32000, center_freq:2.4e9,
                 self_coupling_db:-10, rndm_phaseshift:'True',
                 self_coupling:'False', len_key:'"packet_len"' } },
      { name:'split', id:'radar_split_fsk_cc',
        params:{ samp_per_freq:1, samp_discard:0, len_key:'"packet_len"' } },
      { name:'fft_low', id:'radar_ts_fft_cc',
        params:{ packet_len:256, len_key:'"packet_len"' } },
      { name:'fft_high', id:'radar_ts_fft_cc',
        params:{ packet_len:256, len_key:'"packet_len"' } },
      { name:'cross', id:'blocks_multiply_conjugate_cc', params:{ vlen:1 } },
      { name:'cfar', id:'radar_os_cfar_c',
        params:{ samp_rate:16000, samp_compare:5, samp_protect:0,
                 rel_threshold:0.78, mult_threshold:10,
                 merge_consecutive:'True', len_key:'"packet_len"' } },
      { name:'est', id:'radar_estimator_fsk',
        params:{ center_freq:2.4e9, delta_freq:8000, push_power:'False' } },
      { name:'results', id:'radar_print_results',
        params:{ store_msg:'False', filename:'""' } },
      // The rest of the module's message-only blocks, constructed unconnected
      // so their factories are reached too -- the same trick the gr-lora_sdr
      // scenario above uses. msg_gate and msg_manipulator are also the only
      // coverage of the `string_vector` parameter dtype.
      { name:'est_cw', id:'radar_estimator_cw', params:{ center_freq:2.4e9 } },
      { name:'est_fmcw', id:'radar_estimator_fmcw',
        params:{ samp_rate:32000, center_freq:2.4e9, sweep_freq:8000,
                 samp_up:128, samp_down:128, push_power:'False' } },
      { name:'est_ofdm', id:'radar_estimator_ofdm',
        params:{ symbol_x:'range', len_x:8, axis_x:'[0,100]',
                 symbol_y:'velocity', len_y:8, axis_y:'[-10,10]',
                 merge_consecutive:'True' } },
      { name:'est_rcs', id:'radar_estimator_rcs',
        params:{ num_mean:5, center_freq:2.4e9, antenna_gain_tx:10,
                 antenna_gain_rx:10, usrp_gain_rx:10, power_tx:1,
                 corr_factor:1, exponent:1 } },
      { name:'gate', id:'radar_msg_gate',
        params:{ msg_keys:"('velocity',)", val_min:'[-40]', val_max:'[40]' } },
      { name:'manip', id:'radar_msg_manipulator',
        params:{ symbols:"('range',)", const_add:'[0]', const_mult:'[1]' } },
      { name:'tracker', id:'radar_tracking_singletarget',
        params:{ num_particle:100, std_range_meas:1, std_velocity_meas:1,
                 std_accel_sys:1, threshold_track:0.5, threshold_lost:5,
                 filter:'kalman' } } ],
      connections:[
        ['gen',0,'thr',0], ['thr',0,'target',0], ['target',0,'split',0],
        ['split',0,'fft_low',0], ['split',1,'fft_high',0],
        ['fft_high',0,'cross',0], ['fft_low',0,'cross',1], ['cross',0,'cfar',0],
        { src_blk_id:'cfar', src_port_id:'Msg out',
          snk_blk_id:'est', snk_port_id:'Msg in' },
        { src_blk_id:'est', src_port_id:'Msg out',
          snk_blk_id:'results', snk_port_id:'Msg in' },
      ] },
    expectFetch: ['radar.wasm'] },

  { name: 'gr-gsm hierarchy and native blocks (OOT deferred)',
    fg: { blocks:[
      { name:'src', id:'blocks_null_source', params:{ type:'complex' } },
      { name:'clock', id:'gsm_clock_offset_corrector_tagged',
        params:{ fc:936600000, osr:4, ppm:0, samp_rate_in:1083333.3333333333 } },
      { name:'rotator', id:'gsm_controlled_rotator_cc',
        params:{ phase_inc:0.01 } },
      { name:'snk', id:'blocks_null_sink', params:{ type:'complex' } },
      // Construct representative message-only factories as well. They remain
      // disconnected because useful output requires complete GSMTAP bursts.
      { name:'decode', id:'gsm_control_channels_decoder', params:{} },
      { name:'tch_f', id:'gsm_tch_f_decoder',
        params:{ mode:'gsm.TCH_FS', boundary_check:'False' } },
      { name:'assignment', id:'gsm_extract_assignment_cmd', params:{} },
      { name:'system_info', id:'gsm_extract_system_info', params:{} },
      { name:'tag', id:'gsm_msg_to_tag', params:{} },
      { name:'burst_sink', id:'gsm_burst_sink', params:{} },
      { name:'message_sink', id:'gsm_message_sink', params:{} },
      { name:'bcch_ccch', id:'gsm_bcch_ccch_demapper', params:{ timeslot_nr:0 } },
      { name:'bcch_sdcch4', id:'gsm_bcch_ccch_sdcch4_demapper',
        params:{ timeslot_nr:0 } },
      { name:'sdcch8', id:'gsm_sdcch8_demapper', params:{ timeslot_nr:1 } } ],
      connections:[
        ['src',0,'clock',0], ['clock',0,'rotator',0], ['rotator',0,'snk',0],
      ] },
    expectFetch: ['gsm.wasm'] },
];

// The runner consumes native .grc; wrap these {blocks,connections} fixtures in
// a minimal .grc document (the runner's parser/registry tolerate the vocab).
function toGrc(fg) {
  const scalar = v => {
    const s = String(v);
    return /^[A-Za-z_][\w.]*$/.test(s) && !/^(True|False|null)$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
  };
  let out = 'options:\n    parameters:\n        id: t\n    states:\n        coordinate: [0, 0]\n        rotation: 0\n        state: enabled\nblocks:\n';
  for (const b of fg.blocks) {
    out += `-   name: ${b.name}\n    id: ${b.id}\n    parameters:\n`;
    for (const [k, v] of Object.entries(b.params || {})) out += `        ${k}: ${scalar(v)}\n`;
    out += '    states:\n        coordinate: [0, 0]\n        rotation: 0\n        state: enabled\n';
  }
  out += 'connections:\n';
  for (const c of fg.connections) {
    if (Array.isArray(c)) {
      out += `- [${c[0]}, '${c[1]}', ${c[2]}, '${c[3]}']\n`;
    } else {
      out += `-   src_blk_id: ${c.src_blk_id}\n`;
      out += `    src_port_id: ${c.src_port_id}\n`;
      out += `    snk_blk_id: ${c.snk_blk_id}\n`;
      out += `    snk_port_id: ${c.snk_port_id}\n`;
    }
  }
  return out;
}

const browser = await launchBrowser(ROOT);
let allOk = true;
for (const sc of scenarios) {
  fetched = [];
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  const url = `http://localhost:${PORT}/runner/build/runner.html#` + encodeURIComponent(toGrc(sc.fg));
  await page.goto(url, { waitUntil:'load', timeout:30000 });
  try { await page.waitForFunction(() => { const d=document.getElementById('result'); return d && d.dataset.status!=='pending'; }, { timeout:40000, polling:200 }); } catch {}
  if (sc.expectLog) {
    const deadline = Date.now() + 5000;
    while (!logs.some(line => line.includes(sc.expectLog)) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
  }
  const { status, text } = await page.evaluate(() => { const d=document.getElementById('result'); return { status:d?d.dataset.status:'missing', text:d?d.textContent:'' }; });
  const backend = await page.evaluate(() => globalThis.__grFosphorBackend || 'unset');
  const sideFetched = [...new Set(fetched)].filter(f => f !== 'runner.wasm');
  const pass = text.includes('RUNNER_PASS');
  const fetchOk = JSON.stringify(sideFetched.sort()) === JSON.stringify([...sc.expectFetch].sort());
  const logOk = !sc.expectLog || logs.some(line => line.includes(sc.expectLog));
  const backendOk = !sc.expectBackend || backend === sc.expectBackend;
  const backendMessageOk = !sc.expectBackend || logs.some(line => line.includes(
    sc.expectBackend === 'webgpu'
      ? 'gr-fosphor: using WebGPU renderer'
      : 'gr-fosphor: using CPU renderer',
  ));
  const ok = pass && fetchOk && logOk && backendOk && backendMessageOk;
  allOk = allOk && ok;
  console.log(`\n[${ok?'OK':'FAIL'}] ${sc.name}`);
  console.log(`   status=${status} run=${pass} sideFetched=${JSON.stringify(sideFetched)} expected=${JSON.stringify(sc.expectFetch)} log=${logOk} backend=${backend} backendOk=${backendOk} backendMessage=${backendMessageOk}`);
  if (!ok) console.log('   text:', text, '\n  ', logs.slice(-8).join('\n   '));
  await page.close();
}
await browser.close();

console.log(`\n=== ${allOk ? 'ALL SCENARIOS PASS' : 'SOME FAILED'} ===`);
process.exit(allOk ? 0 : 1);
