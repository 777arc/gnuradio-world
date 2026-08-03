// Capacity probe for the built WASM runner's thread-per-block scheduler.
//
// This intentionally has no pass/fail threshold. It builds increasingly long
// source -> Copy -> sink chains, then narrows the first failure to report the
// largest total block count that both starts and moves samples through every
// block. Keep it out of the normal smoke suite: it is a measurement tool, and
// a capacity regression should only become a gate once a minimum is chosen.
//
//   node test/test_block_capacity.mjs [--port=8102] [--max-blocks=1024]
//
// A result at --max-blocks is only a lower bound. Raise that ceiling to locate
// the actual boundary on a machine/browser combination that supports more.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import {
  contentType,
  launchBrowser,
  setIsolationHeaders,
} from '../scripts/browser-test-support.mjs';

const ROOT = normalize(new URL('..', import.meta.url).pathname);

function integerOption(name, fallback, minimum) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find(value => value.startsWith(prefix));
  if (!argument) return fallback;
  const parsed = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  return parsed;
}

const PORT = integerOption('port', 8102, 1);
const MAX_BLOCKS = integerOption('max-blocks', 1024, 3);
const START_BLOCKS = Math.min(integerOption('start-blocks', 32, 3), MAX_BLOCKS);
const TRIAL_TIMEOUT_MS = integerOption('trial-timeout-ms', 30000, 1000);

function scalar(value) {
  const text = String(value);
  return /^[A-Za-z_][\w.]*$/.test(text) && !/^(True|False|null)$/.test(text)
    ? text
    : `'${text.replace(/'/g, "''")}'`;
}

function capacityFlowgraph(blockCount) {
  if (!Number.isSafeInteger(blockCount) || blockCount < 3)
    throw new Error('a capacity flowgraph needs at least three blocks');

  const blocks = [
    { name: 'source', id: 'blocks_null_source', params: { type: 'float', vlen: 1 } },
  ];
  for (let index = 0; index < blockCount - 2; index++) {
    blocks.push({
      name: `copy_${index}`,
      id: 'blocks_copy',
      params: { type: 'float', enabled: 'True', vlen: 1 },
    });
  }
  blocks.push({ name: 'sink', id: 'blocks_null_sink', params: { type: 'float', vlen: 1 } });

  const connections = [];
  for (let index = 0; index < blocks.length - 1; index++)
    connections.push([blocks[index].name, 0, blocks[index + 1].name, 0]);

  let grc = 'options:\n    parameters:\n        id: block_capacity\n' +
    '    states:\n        coordinate: [0, 0]\n        rotation: 0\n        state: enabled\n' +
    'blocks:\n';
  for (const block of blocks) {
    grc += `-   name: ${block.name}\n    id: ${block.id}\n    parameters:\n`;
    for (const [name, value] of Object.entries(block.params))
      grc += `        ${name}: ${scalar(value)}\n`;
    grc += '    states:\n        coordinate: [0, 0]\n' +
      '        rotation: 0\n        state: enabled\n';
  }
  grc += 'connections:\n';
  for (const [source, sourcePort, sink, sinkPort] of connections)
    grc += `- [${source}, '${sourcePort}', ${sink}, '${sinkPort}']\n`;
  return grc;
}

const server = http.createServer(async (request, response) => {
  setIsolationHeaders(response);
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      response.writeHead(403);
      return response.end();
    }
    const body = await readFile(file);
    response.setHeader('Content-Type', contentType(file));
    response.writeHead(200);
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise(resolve => server.listen(PORT, resolve));

async function runTrialInBrowser(browser, blockCount) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => logs.push(`PAGEERROR ${error.message}`));

  const startedAt = performance.now();
  let snapshot = null;
  let verdict = '(no #result)';
  let workerStats = null;
  let reason = 'timed out before every block moved samples';
  try {
    const grc = capacityFlowgraph(blockCount);
    const url = `http://localhost:${PORT}/runner/build/runner.html#${encodeURIComponent(grc)}`;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(expected => {
      const result = document.getElementById('result');
      if (result?.dataset.status === 'fail') return true;
      if (!result?.textContent.includes('RUNNER_PASS') || !window.__grstats) return false;
      const stats = JSON.parse(window.__grstats);
      return stats.blocks.length === expected &&
        stats.blocks.every(block => block.msg_only || block.items > 0);
    }, { timeout: TRIAL_TIMEOUT_MS, polling: 200 }, blockCount);

    ({ snapshot, verdict, workerStats } = await page.evaluate(() => {
      const result = document.getElementById('result');
      return {
        snapshot: window.__grstats ? JSON.parse(window.__grstats) : null,
        verdict: result?.textContent || '(no #result)',
        workerStats: window.__grWorkerStats ? { ...window.__grWorkerStats } : null,
      };
    }));
    const allMoving = snapshot?.blocks.length === blockCount &&
      snapshot.blocks.every(block => block.msg_only || block.items > 0);
    if (verdict.includes('RUNNER_PASS') && allMoving) reason = '';
    else if (verdict.includes('RUNNER_FAIL')) reason = verdict.trim();
  } catch (error) {
    reason = error?.message || String(error);
    try {
      ({ snapshot, verdict, workerStats } = await Promise.race([
        page.evaluate(() => {
          const result = document.getElementById('result');
          return {
            snapshot: window.__grstats ? JSON.parse(window.__grstats) : null,
            verdict: result?.textContent || '(no #result)',
            workerStats: window.__grWorkerStats ? { ...window.__grWorkerStats } : null,
          };
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('diagnostics read timed out')),
          2000,
        )),
      ]));
      if (verdict.includes('RUNNER_FAIL')) reason = verdict.trim();
    } catch {
      reason = `page stopped responding: ${reason}`;
    }
  }

  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const observed = snapshot?.blocks.length || 0;
  const idle = snapshot?.blocks.filter(block => !block.msg_only && !(block.items > 0)) || [];
  const passed = verdict.includes('RUNNER_PASS') && observed === blockCount && idle.length === 0;
  const heapMiB = snapshot ? snapshot.wasm_heap / 1048576 : 0;
  const result = {
    blockCount,
    elapsedSeconds,
    hasSnapshot: snapshot !== null,
    heapMiB,
    idleCount: idle.length,
    idleNames: idle.slice(0, 5).map(block => block.name),
    logs: logs.slice(-6),
    observed,
    passed,
    reason,
    verdict,
    workerStats,
  };

  return result;
}

async function closeTrialBrowser(browser) {
  // A flowgraph at the capacity boundary can wedge its renderer deeply enough
  // that the DevTools close command never answers. Give normal cleanup a short
  // chance, then terminate only the browser process this trial launched.
  let closed = false;
  await Promise.race([
    browser.close().then(() => { closed = true; }).catch(() => { closed = true; }),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (!closed) browser.process()?.kill('SIGKILL');
}

async function runTrial(blockCount) {
  const browser = await launchBrowser(ROOT);
  let timeout;
  const hardTimeoutMs = TRIAL_TIMEOUT_MS + 35000;
  try {
    return await Promise.race([
      runTrialInBrowser(browser, blockCount),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve({
          blockCount,
          elapsedSeconds: hardTimeoutMs / 1000,
          hasSnapshot: false,
          heapMiB: 0,
          idleCount: 0,
          idleNames: [],
          logs: [],
          observed: 0,
          passed: false,
          reason: `trial exceeded the ${hardTimeoutMs / 1000}s hard timeout`,
          verdict: '(trial timeout)',
          workerStats: null,
        }), hardTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await closeTrialBrowser(browser);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function printTrial(result) {
  const status = result.passed ? 'MOVING' : 'STOPPED';
  const details = result.hasSnapshot
    ? ''
    : ` observed=${result.observed} idle=${result.idleCount}`;
  const workers = result.workerStats
    ? ` workers=${result.workerStats.prewarmed}+${result.workerStats.additionalCreated}` +
      ` (${result.workerStats.active} active)`
    : '';
  console.log(
    `[${status}] blocks=${result.blockCount} time=${result.elapsedSeconds.toFixed(1)}s` +
    ` wasm=${result.heapMiB.toFixed(0)}MiB${workers}${details}`,
  );
  if (!result.passed) {
    console.log(`   ${result.reason}`);
    if (result.idleNames.length)
      console.log(`   first idle blocks: ${result.idleNames.join(', ')}`);
    if (result.logs.length) console.log(`   logs: ${result.logs.join('\n         ')}`);
  }
}

let largestPassing = 0;
let smallestFailing = null;
try {
  let candidate = START_BLOCKS;
  while (true) {
    const result = await runTrial(candidate);
    printTrial(result);
    if (result.passed) {
      largestPassing = candidate;
      if (candidate === MAX_BLOCKS) break;
      candidate = Math.min(candidate * 2, MAX_BLOCKS);
    } else {
      smallestFailing = candidate;
      break;
    }
  }

  if (largestPassing === 0 && smallestFailing !== 3) {
    const baseline = await runTrial(3);
    printTrial(baseline);
    if (baseline.passed) largestPassing = 3;
    else smallestFailing = 3;
  }

  // A stopped renderer consumes the entire timeout, while a moving graph tends
  // to answer quickly. Bias the search toward cheap successful trials: gallop
  // upward from the known-good count before doing the final binary narrowing.
  let upwardStep = 1;
  while (largestPassing > 0 && smallestFailing !== null &&
         largestPassing + upwardStep < smallestFailing) {
    const candidate = largestPassing + upwardStep;
    const result = await runTrial(candidate);
    printTrial(result);
    if (result.passed) {
      largestPassing = candidate;
      upwardStep *= 2;
    } else {
      smallestFailing = candidate;
      break;
    }
  }

  while (largestPassing > 0 && smallestFailing !== null &&
         smallestFailing - largestPassing > 1) {
    const candidate = Math.floor((largestPassing + smallestFailing) / 2);
    const result = await runTrial(candidate);
    printTrial(result);
    if (result.passed) largestPassing = candidate;
    else smallestFailing = candidate;
  }

  console.log('\n=== BLOCK CAPACITY PROBE ===');
  if (largestPassing === MAX_BLOCKS && smallestFailing === null) {
    console.log(`At least ${largestPassing} total blocks moved samples through the entire chain.`);
    console.log(`No boundary found; rerun with --max-blocks greater than ${MAX_BLOCKS}.`);
  } else if (largestPassing > 0) {
    console.log(`Largest confirmed moving flowgraph: ${largestPassing} total blocks.`);
    console.log(`Smallest observed non-moving flowgraph: ${smallestFailing} total blocks.`);
  } else {
    console.log('The three-block baseline did not move samples; the runner/build is not probeable.');
    process.exitCode = 1;
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
