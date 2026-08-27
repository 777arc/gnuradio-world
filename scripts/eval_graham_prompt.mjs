#!/usr/bin/env node
// Run one prompt through Graham in the *real* editor and report what it did.
//
// This exists because there is no other way to see Graham work end to end.
// scripts/eval_graham_js_blocks.mjs drives FlowgraphAgent directly against a
// stub `AiToolDeps` whose catalog holds exactly one block, so it measures the
// model's JS-Block reasoning and nothing else: no real block catalog, no real
// validation, no canvas, and a `run_flowgraph` that returns a note instead of
// running. Everything a user actually hits -- the block metadata the model
// reads, the editor refusing an invalid graph, the runner's verdict -- lives in
// the gap that stub leaves.
//
// So this drives the dock itself: it seeds the provider slots the panel reads,
// opens Graham, submits the prompt, waits out the turn, and reports the
// transcript, the resulting canvas, the console pane and the runner's verdict.
//
//   OPENAI_API_KEY=... node scripts/eval_graham_prompt.mjs "build an FM receiver"
//
// Like eval_graham_js_blocks.mjs this is deliberately not a CI test: it calls a
// real model and costs tokens. Needs `node server.mjs 8090 "$PWD"` running and
// the editor built (cd editor && npm run build).
//
// Usage: node scripts/eval_graham_prompt.mjs "<prompt>" [options]
//   --fresh          start from an empty canvas (File > New) instead of the
//                    welcome example. The editor opens on
//                    digital/welcome_example.grc, "PSK Tx with Constellation",
//                    so a prompt about PSK or constellation plots is otherwise
//                    scored against a canvas that already half-answers it.
//   --model=<id>     pin the model. Default: whatever the dock defaults to,
//                    which is the point -- an unpinned run tests the shipping
//                    default (DEFAULT_OPENAI_MODEL in editor/src/ai/providers.ts).
//   --port=<n>       repository server port (default 8090)
//   --timeout=<s>    seconds to wait for the turn (default 420)
//   --shot=<path>    save a screenshot of the finished dock and canvas
//   --json=<path>    write the structured result, for diffing two models
//
// Exits non-zero if the harness failed, a tool call errored, the graph still
// has blocking validation errors, or a run was attempted and did not pass.
import { writeFileSync } from 'node:fs';
import { launchBrowser, suppressEditorWelcome } from './browser-test-support.mjs';

const argv = process.argv.slice(2);
const flag = name => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const prompt = argv.find(a => !a.startsWith('--'));
if (!prompt) {
  console.error('usage: node scripts/eval_graham_prompt.mjs "<prompt>" ' +
                '[--fresh] [--model=<id>] [--port=<n>] [--timeout=<s>] ' +
                '[--shot=<path>] [--json=<path>]');
  process.exit(2);
}
const key = process.env.OPENAI_API_KEY || '';
if (!key) {
  console.error('Set OPENAI_API_KEY to run a Graham prompt evaluation.');
  process.exit(2);
}
const model = flag('model') || process.env.GRAHAM_EVAL_MODEL || '';
const port = flag('port') || '8090';
const timeoutMs = Number(flag('timeout') || 420) * 1000;
const fresh = !!flag('fresh');

// Everything the dock reads on startup. Seeding these skips onboarding and the
// key dialog, which need clicks a headless run should not have to guess at.
// The key goes to the same sessionStorage slot the panel itself writes, so it
// never reaches a URL, a log line, or this script's output.
const seed = (k, chosen) => {
  try {
    localStorage.setItem('gnuradio-world.graham-onboarded', 'yes');
    localStorage.setItem('gnuradio-world.ai-provider', 'openai');
    localStorage.setItem('gnuradio-world.openai-consent', 'yes');
    // An unpinned run must exercise the shipping default, so the slot is
    // cleared rather than left to whatever a previous run stored.
    if (chosen) localStorage.setItem('gnuradio-world.openai-model', chosen);
    else localStorage.removeItem('gnuradio-world.openai-model');
    sessionStorage.setItem('gnuradio-world.openai-session-key', k);
  } catch { /* storage unavailable */ }
};

const short = (text, n) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + ` …[+${flat.length - n} chars]` : flat;
};

const browser = await launchBrowser(new URL('..', import.meta.url).pathname);
let ok = false, result = null;
try {
  const page = await browser.newPage();
  await suppressEditorWelcome(page);
  await page.evaluateOnNewDocument(seed, key, model);
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2000));

  if (fresh) {
    // buildToolbar stamps data-tool with the label; the button itself renders
    // only the icon, so there is no text to match on.
    const cleared = await page.evaluate(() => {
      const button = document.querySelector('button[data-tool="New"]');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!cleared) throw new Error('New button not found (needed for --fresh)');
    await new Promise(r => setTimeout(r, 800));
  }

  if (!await page.evaluate(() => {
    const toggle = document.querySelector('.ai-toggle');
    if (!toggle) return false;
    if (!document.getElementById('aiDock')?.classList.contains('open')) toggle.click();
    return true;
  })) throw new Error('Graham toggle not found — is the editor built?');
  await new Promise(r => setTimeout(r, 1200));

  // The model list is fetched with the key, so Send stays disabled until it lands.
  await page.waitForFunction(() => {
    const send = [...document.querySelectorAll('#aiDock button')].find(
      b => b.textContent.trim() === 'Send');
    return send && !send.disabled;
  }, { timeout: 60000, polling: 300 }).catch(() => {});

  const dock = await page.evaluate(() => ({
    provider: document.querySelector('.ai-provider')?.value,
    model: document.querySelector('.ai-model')?.value,
    boundary: document.querySelector('.ai-boundary')?.textContent,
    ready: !([...document.querySelectorAll('#aiDock button')]
      .find(b => b.textContent.trim() === 'Send')?.disabled ?? true),
  }));
  if (!dock.ready) throw new Error('Send never enabled — the provider never connected');
  const before = await page.evaluate(() => document.querySelectorAll('#nodes > *').length);
  console.log(`provider ${dock.provider} · model ${dock.model} · ${dock.boundary}`);
  console.log(`canvas before: ${before} blocks${fresh ? ' (--fresh)' : ' (welcome example)'}`);
  console.log(`prompt: ${JSON.stringify(prompt)}\n--- running ---`);

  const started = Date.now();
  await page.evaluate(text => {
    const box = document.querySelector('.ai-prompt');
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.ai-compose').requestSubmit();
  }, prompt);

  // Stop is visible for exactly the length of the turn.
  await page.waitForFunction(() => {
    const stop = [...document.querySelectorAll('#aiDock button')].find(
      b => b.textContent.trim() === 'Stop');
    return stop && !stop.hidden;
  }, { timeout: 30000, polling: 200 }).catch(() => console.log('(the turn never started)'));
  await page.waitForFunction(() => {
    const stop = [...document.querySelectorAll('#aiDock button')].find(
      b => b.textContent.trim() === 'Stop');
    return !stop || stop.hidden;
  }, { timeout: timeoutMs, polling: 500 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const scraped = await page.evaluate(() => {
    const items = [];
    for (const el of document.querySelector('.ai-transcript').children) {
      if (el.classList.contains('ai-message'))
        items.push({ kind: 'message', role: el.querySelector('.ai-role')?.textContent,
          text: el.querySelector('.ai-message-body')?.textContent || '' });
      else if (el.classList.contains('ai-tool'))
        items.push({ kind: 'tool', summary: el.querySelector('summary')?.textContent || '',
          args: el.querySelector('.ai-tool-payload')?.textContent || '',
          result: el.querySelector('.ai-tool-result')?.textContent || '',
          error: !!el.querySelector('.ai-tool-result.error') });
      else if (el.classList.contains('ai-gesture'))
        items.push({ kind: 'gesture', text: el.textContent || '' });
    }
    return { items, cost: document.querySelector('.ai-cost')?.textContent,
      blocks: [...document.querySelectorAll('#nodes > *')]
        .map(n => (n.textContent || '').trim()),
      log: (document.getElementById('log')?.textContent || '')
        .split('\n').filter(l => l.trim()) };
  });

  // The runner's own verdict, from inside the iframe, if run_flowgraph got there.
  let runner = { verdict: null, moved: 0, idle: [] };
  for (const frame of page.frames()) {
    if (!/runner\.html/.test(frame.url())) continue;
    try {
      runner = await frame.evaluate(() => {
        const el = document.getElementById('result');
        const stats = globalThis.__grstats ? JSON.parse(globalThis.__grstats) : null;
        return { verdict: el ? el.textContent.trim() : '(no #result)',
          moved: stats ? stats.blocks.filter(b => b.items > 0).length : 0,
          idle: stats ? stats.blocks.filter(b => !b.msg_only && !(b.items > 0))
            .map(b => b.name) : [] };
      });
    } catch (error) { runner = { verdict: `(frame gone: ${error.message})`, moved: 0, idle: [] }; }
  }

  const tools = scraped.items.filter(i => i.kind === 'tool');
  const failed = tools.filter(i => i.error);
  // A refusal is reported through the console pane whoever asked for the run.
  const refusals = scraped.log.filter(l => /^cannot run|run failed/.test(l.trim()));
  const attemptedRun = tools.some(i => /run_flowgraph/.test(i.summary));
  // A flowgraph reaching hardware needs a human click that a headless run has
  // no way to give, so the run is refused before it starts. That is the rule
  // working, not the model failing -- score it separately or every prompt that
  // lands on an SDR source looks like a defect.
  const unauthorized = tools.some(i => /run_flowgraph/.test(i.summary) &&
    /not authorized/.test(i.result));
  // A refusal the model then *fixed* is the mechanism working, not a defect:
  // the editor declines a run, says why in the same line the tool result
  // carries, and the model corrects the graph and runs it. Judging every
  // `cannot run:` line as a failure marks that as broken -- and it is the only
  // way an unattended run can ever be told that something needs a human, so
  // scoring it that way pushes back towards the alternative, which was waiting
  // on a dialog forever. What still fails is a refusal that *stands*: the turn
  // ended with no passing run behind it.
  const ranSuccessfully = String(runner.verdict).includes('RUNNER_PASS');
  const unresolvedRefusals = ranSuccessfully || unauthorized ? [] : refusals;

  console.log(`\n=== TURN: ${seconds}s · ${tools.length} tool calls · usage ${scraped.cost} ===\n`);
  for (const item of scraped.items) {
    if (item.kind === 'message') console.log(`[${item.role}] ${item.text}\n`);
    else if (item.kind === 'gesture') console.log(`  {asked} ${short(item.text, 200)}`);
    else {
      console.log(`  <${item.summary}>${item.error ? '  ** ERROR **' : ''}`);
      console.log(`      args: ${short(item.args, 300)}`);
      if (item.result) console.log(`      ret:  ${short(item.result, 300)}`);
    }
  }

  console.log(`\n=== CANVAS: ${before} → ${scraped.blocks.length} blocks ===`);
  for (const block of scraped.blocks) console.log('  -', short(block, 70));

  console.log(`\n=== EDITOR CONSOLE ===`);
  for (const line of scraped.log.slice(-20)) console.log('  |', line);

  console.log(`\n=== RUNNER ===`);
  console.log(unauthorized
    ? '  the run needed hardware authorization and was refused (headless: no human click)'
    : attemptedRun
    ? `  verdict: ${runner.verdict ?? '(run_flowgraph called but no runner iframe)'}\n` +
      `  blocks moving items: ${runner.moved}` + (runner.idle.length ? `\n  idle: ${runner.idle.join(', ')}` : '')
    : '  run_flowgraph was never called');

  console.log(`\n=== SUMMARY ===`);
  console.log(`  model:             ${dock.model}`);
  console.log(`  duration:          ${seconds}s`);
  console.log(`  tool calls:        ${tools.length} (${failed.length} errored)`);
  if (failed.length) for (const f of failed) console.log(`     ! ${f.summary}: ${short(f.result, 160)}`);
  console.log(`  run attempted:     ${attemptedRun}` +
              (unauthorized ? ' (refused: needs hardware authorization, which a headless run cannot give)' : ''));
  console.log(`  editor refusals:   ${refusals.length}` +
              (refusals.length && !unresolvedRefusals.length
                ? ' (overcome: a later run passed)' : ''));
  for (const line of refusals) console.log(`     ! ${line.trim()}`);

  ok = failed.length === 0 && unresolvedRefusals.length === 0 &&
       (!attemptedRun || unauthorized ||
        (String(runner.verdict).includes('RUNNER_PASS') && runner.idle.length === 0));

  result = { prompt, model: dock.model, fresh, seconds: Number(seconds), usage: scraped.cost,
    tools: tools.length, toolErrors: failed.length, attemptedRun, unauthorized, refusals,
    unresolvedRefusals,
    runner, blocksBefore: before, transcript: scraped.items,
    blocks: scraped.blocks, log: scraped.log, ok };

  if (flag('shot')) await page.screenshot({ path: String(flag('shot')), fullPage: false });
} catch (error) {
  console.error('HARNESS FAILED:', error.message);
} finally {
  await browser.close();
}
if (flag('json') && result) writeFileSync(String(flag('json')), JSON.stringify(result, null, 2));
console.log(ok ? '\nRESULT: GRAHAM_OK' : '\nRESULT: GRAHAM_FAIL');
process.exit(ok ? 0 : 1);
