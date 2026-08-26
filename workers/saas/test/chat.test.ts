import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chat } from '../src/chat';
import { cfg, env, seedRate, seedUser, sse, testDatabase, type TestDatabase } from './helpers';

const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(item => item.mf.dispose())); });

const request = (maxTokens = 100) => new Request('https://credits.gnuradioworld.com/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'test/model', messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'noop', description: 'No operation',
      parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    max_tokens: maxTokens }),
});

test('zero balance returns 402 without making an upstream call', async () => {
  assert.equal(cfg().maxCompletionTokens, 50_000, 'the prepaid completion ceiling is 50k');
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'empty', 0); await seedRate(t.db);
  let calls = 0;
  const response = await chat(request(), env(t.db), cfg(), 'empty', () => undefined,
    (async () => { calls++; return sse('[DONE]'); }) as typeof fetch);
  assert.equal(response.status, 402);
  assert.equal(calls, 0);
});

test('a completed stream settles once from the real final usage object', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'complete', 10_000); await seedRate(t.db);
  const pending: Promise<unknown>[] = [];
  const upstream = sse(
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } } }, '[DONE]');
  const response = await chat(request(), env(t.db), cfg(), 'complete', promise => pending.push(promise),
    (async (input, init) => {
      assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer openai-secret-key');
      assert.equal(headers.has('http-referer'), false);
      assert.equal(headers.has('x-title'), false);
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.max_completion_tokens, 100);
      assert.equal(sent.max_tokens, undefined);
      assert.equal(sent.reasoning_effort, 'none');
      assert.deepEqual(sent.stream_options, { include_usage: true });
      return upstream;
    }) as typeof fetch);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer/);
  await Promise.all(pending);
  const entries = await t.db.prepare("SELECT * FROM ledger_entries WHERE kind = 'usage'").all();
  assert.equal(entries.results.length, 1);
  assert.equal((entries.results[0] as any).input_tokens, 90);
  assert.equal((entries.results[0] as any).cached_input_tokens, 10);
  assert.equal((entries.results[0] as any).cache_write_tokens, 5);
  assert.equal((entries.results[0] as any).output_tokens, 50);
  assert.equal((entries.results[0] as any).exact, 1);
});

test('client disconnect is billed from an estimate and never recorded as absorption', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'abort', 10_000); await seedRate(t.db);
  const encoder = new TextEncoder();
  const upstream = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"second"}}]}\n\n'));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const pending: Promise<unknown>[] = [];
  const response = await chat(request(), env(t.db), cfg(), 'abort', promise => pending.push(promise),
    (async () => upstream) as typeof fetch);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.all(pending);
  const usage = await t.db.prepare("SELECT exact FROM ledger_entries WHERE kind = 'usage'").all();
  const absorbed = await t.db.prepare('SELECT * FROM absorbed_costs').all();
  assert.equal(usage.results.length, 1);
  assert.equal((usage.results[0] as any).exact, 0);
  assert.equal(absorbed.results.length, 0);
});

test('mid-stream upstream error is absorbed, sanitized, and releases the hold', async () => {
  const t = await testDatabase(); databases.push(t);
  await seedUser(t.db, 'upstream', 10_000); await seedRate(t.db);
  const pending: Promise<unknown>[] = [];
  const upstream = sse(
    { choices: [{ delta: { content: 'partial' } }] },
    { error: { message: 'secret provider account detail' } });
  const response = await chat(request(), env(t.db), cfg(), 'upstream', promise => pending.push(promise),
    (async () => upstream) as typeof fetch);
  const clientBody = await response.text().catch(() => '');
  assert.doesNotMatch(clientBody, /secret provider account detail|openai-secret-key|polar-secret-token/);
  await Promise.all(pending);
  const wallet = await t.db.prepare('SELECT balance_micros, held_micros FROM wallets WHERE user_id = ?')
    .bind('upstream').first<{ balance_micros: number; held_micros: number }>();
  assert.deepEqual(wallet, { balance_micros: 10_000, held_micros: 0 });
  const absorbed = await t.db.prepare('SELECT * FROM absorbed_costs').all();
  assert.equal(absorbed.results.length, 1);
  assert.equal((absorbed.results[0] as any).exact, 0);
});
