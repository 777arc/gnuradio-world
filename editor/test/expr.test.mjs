import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// expr.ts is TypeScript; bundle it to an importable mjs (same as grc.test.mjs).
const out = join(tmpdir(), `expr-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/expr.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { evaluate, buildScope, formatValue, serializeForRunner, Complex } = await import(pathToFileURL(out));

let passed = 0;
const scope = buildScope([
  { id: 'variable', name: 'samp_rate', params: { value: '32000' } },
  { id: 'variable', name: 'decimation', params: { value: '4' } },
  { id: 'variable', name: 'frame_size', params: { value: '30' } },
  { id: 'variable', name: 'sps', params: { value: '4' } },
  { id: 'variable', name: 'nfilts', params: { value: '32' } },
  { id: 'variable', name: 'alpha', params: { value: '0.35' } },
  { id: 'variable', name: 'MTU', params: { value: '1500' } },
  { id: 'variable', name: 'snr_db', params: { value: '10' } },
  { id: 'variable', name: 'esno_0', params: { value: '[0, 1, 2, 3]' } },
  // a chained variable that references another
  { id: 'variable', name: 'cutoff', params: { value: 'samp_rate/decimation' } },
]);

// ok(expr, expected[, scope]) — expected is compared against formatValue().
function ok(src, expected, sc = scope) {
  const r = evaluate(src, sc);
  assert.ok(r.ok, `evaluate(${JSON.stringify(src)}) failed: ${r.ok ? '' : r.error}`);
  assert.equal(formatValue(r.value), expected, `for ${JSON.stringify(src)}`);
  passed++;
}
// num(expr, expected) — numeric closeness for float taps etc.
function approx(src, expected, eps = 1e-6, sc = scope) {
  const r = evaluate(src, sc);
  assert.ok(r.ok, `evaluate(${JSON.stringify(src)}) failed: ${r.ok ? '' : r.error}`);
  assert.ok(Math.abs(r.value - expected) < eps, `for ${JSON.stringify(src)}: got ${r.value}, want ${expected}`);
  passed++;
}
function fails(src, sc = scope) {
  const r = evaluate(src, sc);
  assert.ok(!r.ok, `expected ${JSON.stringify(src)} to fail but got ${r.ok ? formatValue(r.value) : ''}`);
  passed++;
}

// ---- scalar arithmetic (the common case) ----
ok('samp_rate/2', '16000');
ok('MTU*8', '12000');
ok('frame_size*8', '240');
ok('(8000000.0 * 8) / 7', '9142857.143'); // ~9142857.142857, 10 sig digits
ok('samp_rate / decimation', '8000');
ok('samp_rate*4', '128000');
ok('cutoff', '8000');                       // chained variable
ok('1/(2**3)', '0.125');

// ---- power / floor-div / modulo ----
ok('alpha**0.5', formatValue(Math.sqrt(0.35)));
ok('2**(4)-1', '15');
approx('10**(-snr_db/10)', 0.1);
ok('frame_size//15', '2');
ok('(frame_size//15)*[0, 0, 1]', '[0, 0, 1, 0, 0, 1]');   // Python list repetition!
ok('7 % 3', '1');

// ---- complex literals ----
ok('0+0j', '0');                            // simplifies to real 0
ok('1j', '0+1j');
ok('(1-alpha)**0.5*1j', formatValue(new Complex(0, Math.sqrt(1 - 0.35))));
ok('1+2j', '1+2j');

// ---- lists / vectors ----
ok('[]', '[]');
ok('[32767]', '[32767]');
ok('[-1, 1]', '[-1, 1]');
ok('[0, 1, 2]', '[0, 1, 2]');
ok('[1.0]', '[1]');

// ---- string concat + str() ----
ok('"send_frame_size=" + str(samp_rate*4)', 'send_frame_size=128000');
ok('"a" * 3', 'aaa');

// ---- builtins ----
ok('len(esno_0)', '4');
ok('int(22*sps*nfilts)', String(Math.trunc(22 * 4 * 32)));
ok('float(sps)', '4');
ok('min(3, 7, 2)', '2');
ok('max([3, 7, 2])', '7');
ok('abs(-5)', '5');

// ---- math / numpy ----
approx('math.sqrt(2)', Math.SQRT2);
approx('math.log(math.e)', 1);
approx('2*pi*1000', 2 * Math.PI * 1000);
ok('numpy.arange(0, 4, 1)', '[0, 1, 2, 3]');
ok('np.ones(3)', '[1, 1, 1]');
approx('numpy.sqrt((10.0**(-6/10.0))/2.0)', Math.sqrt((10.0 ** (-6 / 10.0)) / 2.0));

// ---- enum constants pass through symbolically ----
ok('analog.GR_COS_WAVE', 'analog.GR_COS_WAVE');
ok('window.WIN_HANN', '1');

// ---- firdes returns a taps vector (length + finiteness sanity) ----
{
  const r = evaluate('firdes.low_pass(1, samp_rate, samp_rate/2, samp_rate/8)', scope);
  assert.ok(r.ok, 'firdes.low_pass failed: ' + (r.ok ? '' : r.error));
  assert.ok(Array.isArray(r.value) && r.value.length > 0 && r.value.every(Number.isFinite), 'low_pass taps');
  passed++;
  const rr = evaluate('firdes.root_raised_cosine(nfilts, nfilts, 1.0/sps, 0.35, 44*nfilts)', scope);
  assert.ok(rr.ok, 'rrc failed: ' + (rr.ok ? '' : rr.error));
  assert.ok(Array.isArray(rr.value) && rr.value.length === 44 * 32 && rr.value.every(Number.isFinite), 'rrc taps');
  passed++;
}

// ---- out-of-subset things fail cleanly (caller falls back to raw text) ----
fails('lambda x: x + 1');
fails('digital.psk_2()[1]');                // domain object, no shim
fails('undefined_name + 1');

// ---- buildScope resolves cross-referencing variables regardless of order ----
{
  const s = buildScope([
    { id: 'variable', name: 'b', params: { value: 'a * 2' } },   // defined before a
    { id: 'variable', name: 'a', params: { value: '5' } },
  ]);
  assert.equal(s.a, 5); assert.equal(s.b, 10);
  passed++;
}

// ---- serializeForRunner: full-precision, runner-parseable strings ----
function ser(src, expected, sc = scope) {
  const r = evaluate(src, sc);
  assert.ok(r.ok, `evaluate(${JSON.stringify(src)}) failed: ${r.ok ? '' : r.error}`);
  assert.equal(serializeForRunner(r.value), expected, `serialize ${JSON.stringify(src)}`);
  passed++;
}
ser('samp_rate/2', '16000');
ser('(8000000.0 * 8) / 7', '9142857.142857144'); // full precision, unlike display
ser('[0, 0, 1]*2', '[0, 0, 1, 0, 0, 1]');
ser('1+2j', '1+2j');
ser('numpy.arange(0, 3, 1)', '[0, 1, 2]');

// A resolved firdes call serializes to a concrete taps literal the runner can parse.
{
  const r = evaluate('firdes.low_pass(1, samp_rate, samp_rate/2, samp_rate/8)', scope);
  const s = serializeForRunner(r.value);
  assert.ok(/^\[-?\d/.test(s) && s.endsWith(']'), 'firdes taps serialize to a list literal');
  passed++;
}

console.log(`expr.test: ${passed} assertions passed`);
