// GRWire: the editor half, and the wire-format drift check.
//
// The frame header and the shared-memory control block exist in four realms
// that cannot import from one another -- Rust (grwire/src/proto.rs), the worker
// (runner/src/grwire_worker.js), C++ (blocks/src/grwire_source.hpp) and the
// mock (test/support/grwire_mock.mjs). grwire/proto/wire.json is the one place
// the layout is stated, and this asserts the other four against it. Drift here
// shows up at run time as samples that decode to noise, which is the kind of
// bug that costs a day.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const ROOT = join(new URL('../..', import.meta.url).pathname);
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const spec = JSON.parse(read('grwire/proto/wire.json'));
const grwire = await bundleModule('../src/grwire.ts');

const tests = {
  'the magic number really is the ASCII tag': () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(spec.frame_header.magic, 0);
    assert.equal(bytes.toString('ascii'), spec.frame_header.magic_ascii);
  },

  'the frame header fields do not overlap and fill the header': () => {
    const width = { u8: 1, u16: 2, u32: 4, u64: 8 };
    let cursor = 0;
    for (const field of spec.frame_header.fields) {
      assert.equal(field.offset, cursor, `${field.name} is not at ${cursor}`);
      cursor += width[field.type];
    }
    assert.equal(cursor, spec.frame_header.bytes,
      'the fields do not add up to the declared header size');
  },

  'the Rust header agrees with the spec': () => {
    const source = read('grwire/src/proto.rs');
    assert.match(source, new RegExp(`HEADER_BYTES: usize = ${spec.frame_header.bytes}\\b`));
    // Each field is written at its declared offset.
    for (const field of spec.frame_header.fields) {
      if (field.name === 'magic') continue;
      const width = { u8: 1, u16: 2, u32: 4, u64: 8 }[field.type];
      const pattern = width === 1
        ? new RegExp(`out\\[${field.offset}\\]`)
        : new RegExp(`out\\[${field.offset}\\.\\.${field.offset + width}\\]`);
      assert.match(source, pattern, `Rust does not write ${field.name} at ${field.offset}`);
    }
  },

  'the worker header agrees with the spec': () => {
    const source = read('runner/src/grwire_worker.js');
    assert.match(source, new RegExp(`HEADER_BYTES = ${spec.frame_header.bytes}\\b`));
    assert.match(source, new RegExp(`MAGIC = 0x${spec.frame_header.magic.toString(16)}`, 'i'));
    for (const [name, format] of Object.entries(spec.formats)) {
      assert.match(source, new RegExp(`${format.code}: ${format.bytes_per_sample}`),
        `the worker does not size ${name} as ${format.bytes_per_sample} bytes`);
    }
  },

  'the control block indices match in the worker and in C++': () => {
    const worker = read('runner/src/grwire_worker.js');
    const cpp = read('blocks/src/grwire_source.hpp');

    // The worker states each index explicitly.
    for (const [name, index] of Object.entries(spec.control.indices)) {
      assert.match(worker, new RegExp(`\\b${name}:\\s*${index}\\b`),
        `the worker has ${name} at the wrong index`);
    }
    assert.match(worker, new RegExp(`CTRL_WORDS = ${spec.control.words}\\b`));

    // C++ states the same thing as field *order*, which is what actually
    // decides the layout, plus a static_assert on the total.
    assert.match(cpp, new RegExp(
      `sizeof\\(Control\\) == ${spec.control.words} \\* sizeof\\(std::int32_t\\)`),
      'the C++ static_assert does not match the declared word count');

    const struct = cpp.slice(cpp.indexOf('struct alignas(4) Control'));
    const fields = [...struct.matchAll(/std::int32_t (\w+)\s*=/g)].map((m) => m[1]);
    const expected = Object.entries(spec.control.indices)
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name.toLowerCase());
    assert.deepEqual(fields.slice(0, expected.length), expected,
      'the C++ struct field order does not match the spec index order');
  },

  'the sample formats agree across Rust, the worker and C++': () => {
    const rust = read('grwire/src/proto.rs');
    const cpp = read('blocks/src/grwire_source.hpp');
    for (const [name, format] of Object.entries(spec.formats)) {
      const variant = name.replace(/^ci/, 'Ci').replace(/^cf/, 'Cf');
      assert.match(rust, new RegExp(`Format::${variant} => ${format.code}`),
        `Rust gives ${name} the wrong code`);
      assert.match(cpp, new RegExp(`${name.toUpperCase()} = ${format.code}`),
        `C++ gives ${name} the wrong code`);
    }
  },

  'a server URL is checked for what can be known without a socket': async () => {
    const { serverProblem } = grwire;
    assert.equal(serverProblem('wss://pi.local:8073/ws?token=abc'), null);
    assert.match(serverProblem(''), /grwire printed/);
    assert.match(serverProblem('not a url'), /not a URL/);
    assert.match(serverProblem('http://pi.local:8073/ws?token=a'), /must start with wss/);
    // A bare URL is now the *correct* thing to store; what is missing is a
    // token saved in this browser for that host.
    assert.match(serverProblem('wss://pi.local:8073/ws'), /no access token saved/);
  },

  'a pasted URL is split into a shareable part and a secret part': () => {
    const { splitToken } = grwire;
    const paste = 'wss://pi.local:8073/ws?token=s3cr3t';
    const { url, token } = splitToken(paste);
    // What lands in the .grc, which people share.
    assert.equal(url, 'wss://pi.local:8073/ws');
    assert.equal(token, 's3cr3t');
    // A URL with no token is left exactly alone, including its other params.
    assert.deepEqual(splitToken('wss://pi.local:8073/ws'),
      { url: 'wss://pi.local:8073/ws', token: '' });
    assert.equal(splitToken('wss://pi.local:8073/ws?a=1&token=x').url,
      'wss://pi.local:8073/ws?a=1');
  },

  'the token is spliced back on only for connecting': () => {
    const { withToken, splitToken } = grwire;
    // An embedded token is honoured without any storage involved, which is what
    // makes an older flowgraph keep working.
    assert.equal(
      withToken('wss://pi.local:8073/ws?token=abc'),
      'wss://pi.local:8073/ws?token=abc');
    // And the round trip is stable: splitting what withToken produced gives
    // back the same two halves.
    const spliced = withToken('wss://pi.local:8073/ws?token=abc');
    assert.deepEqual(splitToken(spliced), { url: 'wss://pi.local:8073/ws', token: 'abc' });
  },

  'a server URL keeps its host so a token can be filed against it': () => {
    const { serverHost } = grwire;
    assert.equal(serverHost('wss://pi.local:8073/ws?token=x'), 'pi.local:8073');
    assert.equal(serverHost('not a url'), '');
  },

  'GRWire sits at the end of Supported SDRs, not in alphabetical order': async () => {
    const { comparePaletteBlocks } = await bundleModule('../src/palette-tree.ts');
    const palette = JSON.parse(read('editor/public/blocks.json'));
    const all = Array.isArray(palette) ? palette : palette.blocks;
    const sdrs = all
      .filter((b) => Array.isArray(b.category) && b.category[0] === 'Supported SDRs')
      .map((b) => ({ id: b.id, label: b.label }));
    assert.ok(sdrs.length >= 5, `expected a populated SDR category, saw ${sdrs.length}`);

    const order = [...sdrs].sort(comparePaletteBlocks).map((b) => b.label);
    assert.equal(order[order.length - 1], 'GRWire Source',
      `GRWire should be last, got: ${order.join(', ')}`);
    // Alphabetical order would have put it near the front, which is the whole
    // reason the pin exists.
    const plain = [...sdrs].sort((a, b) => a.label.localeCompare(b.label)).map((b) => b.label);
    assert.notEqual(plain[plain.length - 1], 'GRWire Source');
    // And everything else stays alphabetical among itself.
    const others = order.slice(0, -1);
    assert.deepEqual(others, [...others].sort((a, b) => a.localeCompare(b)));
  },

  'a token is never shown back to the user': async () => {
    const { redactToken } = grwire;
    assert.equal(
      redactToken('wss://pi.local:8073/ws?token=s3cr3t'),
      'wss://pi.local:8073/ws?token=***');
    assert.equal(
      redactToken('wss://pi.local:8073/ws?a=1&token=s3cr3t'),
      'wss://pi.local:8073/ws?a=1&token=***');
  },

  'the trust URL points at the daemon own page on the same host': async () => {
    const { trustUrlFor } = grwire;
    assert.equal(trustUrlFor('wss://pi.local:8073/ws?token=x'), 'https://pi.local:8073/');
  },
};

for (const [name, run] of Object.entries(tests)) {
  await run();
  void name;
}

console.log('grwire.test.mjs: ok — wire spec matches Rust, the worker, C++ and the mock');
