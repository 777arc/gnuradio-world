// Graham's conversations between visits: the record shape, what a stored
// transcript is trimmed to before it can be resumed, how the panel rebuilds its
// transcript from the wire messages alone, and the store's bounds. IndexedDB
// needs a browser; the store's eviction and size rules are pure functions here.
import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { aiPanelSource as panel } from './editor-contract-source.mjs';

const {
  CURRENT_SESSION_STORAGE, MAX_SESSIONS, MAX_SESSION_BYTES, TITLE_LENGTH,
  emptyUsage, isAttachment, orderSessions, relativeTime, resumeTranscript,
  sessionTitle, summarize, transcriptEvents, userText,
} = await bundleModule('../src/ai/sessions.ts');
const { STORES, DB_VERSION } = await bundleModule('../src/local-db.ts');

assert.equal(STORES.grahamSessions, 'graham-sessions');
assert.equal(DB_VERSION, 2, 'the sessions store joined the JS block library\'s database');
assert.equal(CURRENT_SESSION_STORAGE, 'gnuradio-world.graham-session');

// ---- what the user typed, out of a seeded message ----------------------------

const seeded = '[canvas provenance] user\n{"blocks":[]}\n\n[message]\nbuild an FM receiver';
assert.equal(userText(seeded), 'build an FM receiver');
assert.equal(userText('plain'), 'plain', 'a message without a seed is itself');
assert.equal(userText([{ type: 'text', text: seeded }]), 'build an FM receiver');

assert.equal(sessionTitle('  build an FM receiver\nwith a waterfall '), 'build an FM receiver');
assert.equal(sessionTitle(''), 'New conversation');
{
  const long = 'please ' + 'explain the symbol sync block '.repeat(6);
  const title = sessionTitle(long);
  assert.ok(title.length <= TITLE_LENGTH + 1 && title.endsWith('…'), title);
  assert.ok(!title.includes('  '), 'whitespace is collapsed');
}

// ---- resuming a stored transcript ---------------------------------------------

const complete = [
  { role: 'user', content: seeded },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function',
    function: { name: 'validate', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  { role: 'assistant', content: 'Valid.' },
];
{
  const { messages, interrupted } = resumeTranscript(complete, true);
  assert.deepEqual(messages, complete, 'a completed turn is resumed as it is');
  assert.equal(interrupted, null);
  assert.notEqual(messages, complete, 'and the stored record is never handed out by reference');
}
{
  // A refresh between a tool call and its result: the API refuses an assistant
  // message whose calls have no results, so the round is dropped back to the
  // last completed turn -- and the prompt that opened the unfinished turn is
  // handed back rather than lost.
  const cut = [...complete,
    { role: 'user', content: '[canvas]\n\n[message]\nnow add a waterfall' },
    { role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'c2', type: 'function',
      function: { name: 'apply_edits', arguments: '{}' } }] }];
  const { messages, interrupted } = resumeTranscript(cut, true);
  assert.deepEqual(messages, complete);
  assert.equal(interrupted, 'now add a waterfall');
}
{
  // A refresh while the first request was in flight.
  const { messages, interrupted } = resumeTranscript([{ role: 'user', content: 'x\n\n[message]\nhello' }], true);
  assert.deepEqual(messages, []);
  assert.equal(interrupted, 'hello');
}
{
  // A screenshot attachment trailing a dropped round is not "what the user asked".
  const cut = [...complete,
    { role: 'user', content: 'q\n\n[message]\nlook' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function',
      function: { name: 'capture_plots', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: '{}' },
    { role: 'user', content: [{ type: 'text', text: 'Screenshot of the plots.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
  const { messages, interrupted } = resumeTranscript(cut, true);
  assert.deepEqual(messages, complete);
  assert.equal(interrupted, 'look');
}
{
  // Resumed on a model that cannot see: every picture becomes the line the
  // agent's own pruning leaves, since a request carrying one would be refused.
  const withImage = [...complete,
    { role: 'user', content: 'q\n\n[message]\nlook' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function',
      function: { name: 'capture_plots', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: '{}' },
    { role: 'user', content: [{ type: 'text', text: 'Screenshot of the plots.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: 'Looks fine.' }];
  assert.ok(isAttachment(withImage[7]));
  const seeing = resumeTranscript(withImage, true);
  assert.ok(Array.isArray(seeing.messages[7].content), 'a model that sees keeps the picture');
  const blind = resumeTranscript(withImage, false);
  assert.equal(typeof blind.messages[7].content, 'string');
  assert.match(blind.messages[7].content, /^Screenshot of the plots\. \[the image itself is no longer/);
  assert.equal(blind.interrupted, null);

  // ---- the transcript the panel draws, from the wire messages alone ----------
  const session = {
    id: 's1', title: 'build', created: 1, updated: 2, provider: 'openai', model: 'm',
    messages: withImage, usage: emptyUsage(), imagesThisConversation: 1,
    turns: [
      { messageIndex: 0, before: { insts: [], conns: [], counter: 0 },
        after: { insts: [{ uid: 1, name: 'a' }], conns: [], counter: 1 } },
      { messageIndex: 4 },
    ],
  };
  const events = transcriptEvents(session);
  assert.deepEqual(events.map(event => event.kind),
    ['user', 'tool', 'assistant', 'diff', 'user', 'tool', 'image', 'assistant'],
    'a round\'s prose precedes its tool rows; the turn\'s diff hangs on its last bubble');
  assert.equal(events[0].text, 'build an FM receiver', 'the bubble shows what was typed, not the seed');
  assert.deepEqual(events[1], { kind: 'tool', name: 'validate', args: {}, result: { ok: true }, error: false });
  assert.equal(events[3].after.counter, 1);
  assert.deepEqual(events[6], { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', alt: 'the plots' });

  const summary = summarize(session);
  assert.equal(summary.messageCount, 2, 'an attachment is not a message the user sent');
  assert.ok(summary.bytes > 0);
}
{
  // A tool that failed is drawn as one.
  const failed = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function',
      function: { name: 'set_params', arguments: '{"name":"nope"}' } }] },
    { role: 'tool', tool_call_id: 'c', content: '{"error":"no block named nope"}' },
    { role: 'assistant', content: 'Sorry.' },
  ];
  const [, tool] = transcriptEvents({ messages: failed, turns: [] });
  assert.equal(tool.error, true);
  assert.deepEqual(tool.args, { name: 'nope' });
}

// ---- the store's bounds ------------------------------------------------------

{
  const many = Array.from({ length: MAX_SESSIONS + 3 }, (_, i) =>
    ({ id: `s${i}`, updated: i, title: '', created: 0, model: '', messageCount: 0, bytes: 0 }));
  const { kept, evict } = orderSessions(many);
  assert.equal(kept.length, MAX_SESSIONS);
  assert.equal(kept[0].id, `s${MAX_SESSIONS + 2}`, 'newest first');
  assert.deepEqual(evict, ['s2', 's1', 's0'], 'the oldest beyond the cap are evicted');
}
assert.equal(MAX_SESSION_BYTES, 4 * 1024 * 1024);

assert.equal(relativeTime(1000, 1000 + 30_000), 'just now');
assert.equal(relativeTime(0, 5 * 60_000), '5 minutes ago');
assert.equal(relativeTime(0, 60 * 60_000), '1 hour ago');
assert.equal(relativeTime(0, 24 * 60 * 60_000), 'yesterday');
assert.equal(relativeTime(0, 3 * 24 * 60 * 60_000), '3 days ago');

// ---- the panel wiring ----------------------------------------------------------

assert.ok(panel.includes('roundFinished:'), 'the panel persists after every completed round');
assert.ok(panel.includes('resumeTranscript('), 'a resumed transcript is trimmed to a completed turn');
assert.ok(panel.includes('setCurrentSessionId(null)'), 'New chat forgets which conversation a refresh follows');
assert.ok(panel.includes("'ai-history'"), 'the History view exists');

console.log('ai-sessions.test.mjs: ok');
