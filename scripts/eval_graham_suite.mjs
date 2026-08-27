#!/usr/bin/env node
// Run the Graham prompt suite and report how each case did.
//
// **This never runs by itself.** It is not in CI, not in `npm test`, and not in
// either smoke suite; it calls a real model on a real key and costs tokens, so
// it runs when somebody asks for it and at no other time. The cases live in
// scripts/graham-prompts.mjs.
//
//   OPENAI_API_KEY=... node scripts/eval_graham_suite.mjs              # all cases
//   OPENAI_API_KEY=... node scripts/eval_graham_suite.mjs qpsk-sync    # some cases
//   node scripts/eval_graham_suite.mjs --list
//
// Each case runs in its own browser through scripts/eval_graham_prompt.mjs, so
// one case cannot leave state behind for the next. Needs `node server.mjs 8090
// "$PWD"` running and the editor built.
//
//   --model=<id>   pin the model for every case. Default: the dock's own
//                  default, which is the configuration users actually get.
//   --keep         keep the per-case JSON and say where it is.
//   --port=<n>     repository server port (default 8090).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES } from './graham-prompts.mjs';

const argv = process.argv.slice(2);
const flag = name => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit ? (hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true) : undefined;
};
if (flag('list')) {
  for (const item of CASES) console.log(`${item.name.padEnd(20)} ${item.prompt}`);
  process.exit(0);
}
const wanted = argv.filter(a => !a.startsWith('--'));
const unknown = wanted.filter(name => !CASES.some(item => item.name === name));
if (unknown.length) {
  console.error(`no such case: ${unknown.join(', ')}\n` +
                `known cases: ${CASES.map(item => item.name).join(', ')}`);
  process.exit(2);
}
const cases = wanted.length ? CASES.filter(item => wanted.includes(item.name)) : CASES;
if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY to run the Graham prompt suite.');
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'graham-suite-'));
const driver = new URL('eval_graham_prompt.mjs', import.meta.url).pathname;
const toolNames = result => result.transcript
  .filter(item => item.kind === 'tool')
  .map(item => item.summary.replace(/^Tool · /, '').replace(/ · .*$/, ''));

// What the case said it wanted, checked against what the run actually shows.
function judge(item, result) {
  const notes = [];
  const expect = item.expect || {};
  const names = toolNames(result);
  const labels = result.blocks.join('\n');

  if (expect.clears === true && !names.includes('new_flowgraph'))
    notes.push('did not call new_flowgraph for a from-scratch request');
  if (expect.clears === false && names.includes('new_flowgraph'))
    notes.push('called new_flowgraph on a request to modify the existing graph');
  for (const tool of expect.tools || [])
    if (!names.includes(tool)) notes.push(`never called ${tool}`);
  if (expect.notBefore) {
    const [after, first] = expect.notBefore;
    const afterAt = names.indexOf(after), firstAt = names.indexOf(first);
    if (afterAt >= 0 && (firstAt < 0 || afterAt < firstAt))
      notes.push(`called ${after} before ${first}`);
  }
  for (const text of expect.blocks || [])
    if (!labels.includes(text)) notes.push(`no block matching "${text}" on the canvas`);
  for (const text of expect.absentBlocks || [])
    if (labels.includes(text)) notes.push(`left a block matching "${text}" on the canvas`);

  const verdict = String(result.runner?.verdict || '');
  if (expect.run === 'pass' && !verdict.includes('RUNNER_PASS'))
    notes.push(result.unauthorized ? 'the run needed hardware authorization'
      : `the run did not pass (${verdict || 'never ran'})`);
  if (expect.run === 'authorized' && !verdict.includes('RUNNER_PASS') && !result.unauthorized)
    notes.push(`the run neither passed nor asked for authorization (${verdict || 'never ran'})`);
  if (result.toolErrors) notes.push(`${result.toolErrors} tool call(s) errored`);
  for (const refusal of result.refusals || []) notes.push(`editor refused: ${refusal.trim()}`);

  return notes;
}

const runOne = item => new Promise(resolve => {
  const jsonPath = join(outDir, `${item.name}.json`);
  const args = [driver, item.prompt, `--json=${jsonPath}`];
  if (item.fresh) args.push('--fresh');
  if (flag('model')) args.push(`--model=${flag('model')}`);
  if (flag('port')) args.push(`--port=${flag('port')}`);
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; process.stdout.write(chunk); });
  child.on('close', () => {
    let result = null;
    try { result = JSON.parse(readFileSync(jsonPath, 'utf8')); }
    catch { /* the driver failed before it could write one */ }
    resolve({ item, result, jsonPath, out });
  });
});

const outcomes = [];
for (const item of cases) {
  console.log(`\n${'='.repeat(72)}\nCASE ${item.name}\n${'='.repeat(72)}`);
  const outcome = await runOne(item);
  outcome.notes = outcome.result ? judge(item, outcome.result)
    : ['the harness produced no result'];
  outcomes.push(outcome);
}

console.log(`\n${'='.repeat(72)}\nSUITE SUMMARY\n${'='.repeat(72)}`);
const width = Math.max(...outcomes.map(o => o.item.name.length));
for (const { item, result, notes } of outcomes) {
  const mark = notes.length ? 'FAIL' : ' OK ';
  const stats = result
    ? `${String(result.seconds).padStart(5)}s  ${String(result.tools).padStart(2)} tools  ${result.usage || ''}`
    : '(no result)';
  console.log(`[${mark}] ${item.name.padEnd(width)}  ${stats}`);
  for (const note of notes) console.log(`         - ${note}`);
}
const failed = outcomes.filter(o => o.notes.length);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} cases met their expectations`);
if (flag('keep')) console.log(`per-case JSON kept in ${outDir}`);
else rmSync(outDir, { recursive: true, force: true });
console.log(failed.length ? 'RESULT: GRAHAM_SUITE_FAIL' : 'RESULT: GRAHAM_SUITE_PASS');
process.exit(failed.length ? 1 : 0);
