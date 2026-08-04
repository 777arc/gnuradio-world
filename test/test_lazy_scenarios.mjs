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
