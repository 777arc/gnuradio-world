# Flowgraph Copilot

Flowgraph Copilot is the editor's AI assistant — free to use on a key the
project shares, or on one of your own. It can inspect and edit the canvas
through validated structured operations, run the graph in the normal visible QT
GUI tab, and read the runner's diagnostics snapshot. Its code
lives under `editor/src/ai/`; `editor/src/main.ts` supplies the narrow dependency
bundle that is allowed to touch editor state.

The feature is public and discoverable from the toolbar and Tools menu, with its
dock collapsed by default. The header's New chat control clears the transcript
and accumulated spend and creates a fresh agent conversation without changing the
canvas, connection, or selected model; it is disabled while a turn is running.

## Four providers, one request path

The dock talks to the project's own **shared-key proxy** — under either of two
free providers — to **OpenRouter**, or to **OpenAI's own API**, chosen in the
provider select above the model picker and remembered in
`localStorage['gnuradio-world.ai-provider']`; the first shared provider is the
default, and the two shared ones are what need nothing from the user. All four
speak the OpenAI chat-completions wire format, so `editor/src/ai/client.ts`
holds the single streaming request path and model-list call for all of them, and
`editor/src/ai/providers.ts` holds everything that differs — base URL, default
model, key storage keys, dialog copy, and the capability flags below.
`editor/src/ai/openrouter.ts` is now only OpenRouter's OAuth flow, which none
of the others has an equivalent of.

Everything a provider is allowed to differ in is a descriptor field, so a fifth
provider is a new entry in `AI_PROVIDERS` rather than a branch in the panel:

| difference | OpenAI Free Tier | OpenRouter Free Tier | OpenRouter | OpenAI |
|------------|------------------|----------------------|-----------|--------|
| connect | nothing to connect — consent only (`keyless`) | the same | OAuth PKCE, or a pasted key | a pasted key only (`oauth`) |
| model list | one fixed id in the descriptor, never fetched, so the picker locks (`fixedModels`) | the same | public, filtered to `supported_parameters=tools` | authenticated, and unfiltered — the chat families are picked out of every model of every kind the account can see (`modelsNeedKey`) |
| default model | `gpt-5.6-luna`, and no other | `nvidia/nemotron-3-ultra-550b-a55b:free`, and no other | `google/gemini-3.7-flash` | `gpt-5.4-mini` |
| second hop | `api.openai.com`, named in the boundary line (`upstream`) | `openrouter.ai`, likewise | none | none |
| attribution | none | none — the proxy sends OpenRouter's headers itself | `HTTP-Referer` and `X-Title` | none — OpenAI rejects them in preflight (`attribution`) |
| usage | as OpenAI, and priced nowhere | the same, and free anyway | appended to the stream automatically, with a cost | only when asked with `stream_options.include_usage`, and priced nowhere (`requestUsage`, `reportsCost`) |
| reasoning effort | unset — the proxy sets `'none'` upstream | unset — the proxy sets `'low'` upstream | nested under `reasoning`, so nothing is sent | top-level `reasoning_effort`, but unreachable with tools — see below (`reasoningEffort`) |
| cache routing | one shared key, set by the proxy | none; free endpoints cache nothing for us | prefix hashing only | `prompt_cache_key` per page (`promptCacheKey`) |

**A keyless provider must send no `Authorization` header at all.** `client.ts`
emits one only when a key is present; the proxy holds the only key involved, and
a stray header would widen the request's CORS preflight for nothing.

**Which upstream a shared request reaches is decided by the `api` path, and by
nothing else.** `…/v1` is the proxy's OpenAI upstream and `…/openrouter/v1` its
OpenRouter one; the browser sends the same body either way, and no field in it
can move a request from one key to the other.

Because OpenAI prices nothing in its usage event, the header shows accumulated
tokens there and a dollar figure on OpenRouter. Either headline hides the split
that decides the bill, so hovering it breaks the conversation down into input
against cached input and output against reasoning — `client.ts` flattens both
out of the nested `prompt_tokens_details` / `completion_tokens_details` that
each provider reports them in — and closes with the conversation's **request
count against the messages sent**, since rounds per message is the multiplier
behind the input total. That count comes from the agent's `requestStarted`
hook, fired where the request is issued rather than derived from usage events,
so a round that fails or is aborted mid-stream still counts as the round-trip
it was. Model lists are cached per
provider, an authenticated one is dropped on Disconnect, and a list that arrives
after the user has switched providers is discarded rather than shown.

Each provider's saved model selection always takes precedence over the default.
If the wanted model is absent from the live catalog, the picker requires an
explicit replacement instead of submitting an invalid model.

## The shared models

Two providers cost the user nothing and store nothing. Both send their requests
to one Cloudflare Worker in [`workers/ai-proxy/`](../workers/ai-proxy/README.md)
at `ai.gnuradioworld.com`, which forwards them to **OpenAI** on one shared
OpenAI key, or to **OpenRouter's free tier** on one shared OpenRouter key,
according to the path. Read that README before changing anything about the
proxy; the parts that constrain the editor are:

- **One model per upstream, and the pickers say which.** The OpenAI path
  accepts `gpt-5.6-luna`; the OpenRouter path accepts
  `nvidia/nemotron-3-ultra-550b-a55b:free`. Either way anything else is refused
  by name — so `fixedModels` populates the picker from the descriptor rather
  than fetching a catalog or offering a request that would be refused, and
  locks it, since a one-entry list is no choice. Both are still *lists*:
  `HOSTED_MODELS` / `HOSTED_OPENROUTER_MODELS` in `providers.ts` and `MODELS` /
  `OPENROUTER_MODELS` in the Worker are the same lists in two places, they
  change together, and adding an entry unlocks the picker on its own.
  **The `:free` suffix is load-bearing**: the same id without it is a paid
  model, and the shared key must never reach one.
- **Each provider is named for the model that answers**, not for the site —
  `OpenAI Free Tier (gpt-5.6-luna)` and
  `OpenRouter Free Tier (nemotron-3-ultra)`. Both are GNU Radio World's own
  proxy on the same host, so the API behind them is the only thing that tells
  them apart, and both the dock's select and the connection dialog's show
  `menuLabel` so they read identically.
- **Two windows each, and the two upstreams share nothing.** OpenAI is metered
  in tokens — 1,000,000 per minute per visitor IP, under a site-wide cap of
  2,500,000 per **UTC calendar day**. OpenRouter's free tier costs nothing per
  token, so what actually runs out there is a *request* allowance on the
  account, and its windows count requests instead: 15 a minute per visitor IP,
  under a site-wide 900 a day — both under OpenRouter's own free-tier ceilings,
  which are 20 a minute and 1000 a day for an account holding credit. Both reset at 00:00 UTC on the same boundary the
  usage records are keyed by, each upstream keeps its own limiter objects and
  its own usage history, and one running out leaves the other working. The
  per-IP window is the abuse ceiling; the daily cap is what bounds the bill, or
  rations the free tier.
- **A spent budget arrives as a 429** whose message already names the wait and
  the way forward. `AiRequestError` carries the status so the panel can add the
  things a user can act on — switching the provider select to the *other* free
  provider, whose budget is separate, or to a key of their own — and say it only
  where it applies.
- **Usage is counted in the proxy, not the editor.** The global Durable Object
  keeps one record per UTC day — requests, turns, tokens and distinct visitors,
  the last as a hash under a salt thrown away daily — readable over an
  authenticated `/stats`. Nothing is reported from the browser, and no analytics
  script is involved.
- **The proxy sets `prompt_cache_key` itself** on the OpenAI upstream, to one
  value for every visitor. All of them share the same system prefix, so a single
  key keeps one warm prefix upstream instead of establishing one per page. The
  editor's own `CACHE_KEY` is dropped there, which is why `promptCacheKey` is
  false on both shared providers and true on OpenAI. The OpenRouter upstream
  sends no cache key at all, and takes its output ceiling in `max_tokens` rather
  than `max_completion_tokens` — a field an API does not know bounds nothing.
- **The proxy is where a shared request's reasoning effort is decided.** The
  OpenAI upstream must send `'none'` or its models refuse function tools
  outright; the free model lists `reasoning_effort` among its supported
  parameters, so that upstream sends `'low'` — reasoning tokens are output
  tokens, and this loop mostly threads one tool result into the next.

**Consent, not a key, is what the first Send waits on.** The dock is fully
usable before it — there is nothing to connect — but `form.onsubmit` opens the
connection dialog until `hasConsent(providerId)`, because a prompt and a
flowgraph leaving the browser deserve a sentence about where they go first.
Opening the dock does not prompt; only sending does. For the two key-based
providers the check is a no-op, since a key is only read back when consent was
already recorded.

## Data and key boundary

GNU Radio World is static, so the browser calls `https://ai.gnuradioworld.com`,
`https://openrouter.ai` or `https://api.openai.com` directly — never more than
one, and the dock's boundary line names the one connected. The two shared
providers are the two-hop paths, and their line says so, naming the second hop
from the descriptor's `upstream` rather than assuming it: `ai.gnuradioworld.com
→ api.openai.com (shared key)`, or `→ openrouter.ai (shared key)`.

The connection dialog says exactly what crosses that boundary, rewriting its
copy, links, and buttons for the provider chosen in it — including which
upstream it names, and how that provider's shared budget runs out
(`upstream`, `limitsNote`). OpenRouter receives the API key plus the request,
and the selected model provider receives the prompt, flowgraph, runnable block
metadata, tool results, and console output captured during an observed run, but
not the OpenRouter key; on OpenAI the one host receives both; on either shared
provider the request reaches OpenAI or OpenRouter with no key of the user's
involved at all. The dialog links to the exact client source, that
provider's privacy or data controls, and its key page — replaced on the shared
provider, which has no key page, by the proxy's own README (`keysLabel`).

The primary Connect with OpenRouter path uses OAuth PKCE with an S256 challenge,
so a user authorizes on OpenRouter instead of pasting a key into the editor. The
one-time verifier and a canvas snapshot live in `sessionStorage`; after the
redirect the authorization code is exchanged directly with OpenRouter, removed
from the URL, and the canvas is restored — switching the dock back to OpenRouter
if it had since moved to OpenAI. Manual key entry remains available, and is the
whole of the OpenAI path.

**Each provider stores its own key, consent, and model, and never sees the
others'.** A shared provider has no key storage at all — `storage.key` and
`storage.sessionKey` are absent from its descriptor, and `storeKey`/`forgetKey`
are no-ops there rather than inventing a slot a key could land in. The two of
them still keep separate consent and model slots, so choosing a free model under
one is not a choice made for the other.

Keys are session-only by default in
`sessionStorage['gnuradio-world.<provider>-session-key']`. The explicit Remember
checkbox instead uses `localStorage['gnuradio-world.<provider>-key']`; all storage
access is behind try/catch so disabled storage degrades to the in-memory session.
The always-visible Disconnect control clears both locations for the connected
provider. A key must never enter a URL, flowgraph, console message, runner
`postMessage`, or recording binding. Transcript nodes are built with
`createElement`, `textContent`, and text nodes; model output and tool payloads are
untrusted.

All three API origins are declared in `providers.ts` with a
`pr-security-scan: allow new-outbound-host` line, which is what keeps the PR
security gate's new-host rule from blocking on them; a provider reaching a new
host needs the same. A shared provider adds none of its own — it reaches the
proxy's origin, and the second hop is the Worker's outbound call. Streaming tool-call fragments are joined by their index, and aborting the
dock's Stop control aborts the fetch.

## Graph editing and history

`tools.ts` exposes granular edits, and `apply_edits` carries an ordered batch of
them in one call. The edit operations live in one `EDITS` table: a single-edit
tool is one entry reported on its own, a batch is the same entries with one
validation pass at the end, so the two can never drift apart. `EDIT_OPS` is that
table's key set, which is also the `op` enum in the batch tool's schema — adding
an operation to the table adds it to both paths and to the schema at once.

A batch **stops at the first failing entry** and reports `{index, op, error,
not_applied}`; everything before it stays applied. Rolling back would be the
wrong instinct: a turn is snapshotted once in the panel and Ctrl+Z reverses the
whole of it, so a half-applied batch is already undoable, and unwinding it would
throw away edits the model should be told to build on. Its report is
deliberately not one entry per edit — `applied` as a count, `added` mapping only
the names the editor assigned back to their block ids, and the one failure. An
edit that did exactly what it was told tells the model nothing it does not
already know, and a per-edit echo would be resent on every later round.

Parameter names are checked against the instance's `defFor(inst)` definition
before a mutation; an unknown id is a tool error that lists valid ids. Port labels and message ports resolve through the
same expanded port metadata the canvas uses. Each mutation returns the fresh
validation state, slimmed: `validation.blocking` in full, `non_blocking` as a
count. Only `validate` returns every issue — see "Token discipline" below.

The editor's ordinary actions record history immediately, but Copilot operations
use non-recording variants. The panel snapshots before a user turn, allows all
tool calls to auto-apply and redraw, then calls `recordHistory()` exactly once if
the snapshot changed. Ctrl+Z therefore reverses the entire turn. The message's
diff is derived from the two snapshots, and Revert restores the pre-turn snapshot
as another undoable history entry. It hangs on the round's assistant bubble,
which is created by that round's first streamed token rather than when the round
opens — so a round's prose lands below the tool calls it followed instead of
above every one of them, and a round that only calls tools leaves no empty
bubble.

`replace_flowgraph` is the escape hatch for a new graph. It still goes through
`parseGrc()` and `loadFlowgraph()` and returns the same editor validation result.
Prefer granular operations for changes to an existing graph because the editor's
schema — especially hand-written block definitions — is authoritative.

## Visible runs and evidence

`run_flowgraph` calls `main.ts`'s `run()` and never constructs a second iframe.
`run()` returns the unique `recordingToken` embedded in the runner query string.
Every cross-frame read verifies that query string first and is wrapped for the
mid-navigation case, so stats from an older run cannot be attributed to a newer
canvas.

When the agent has changed the flowgraph, its next `run_flowgraph` waits one
second before switching to the visible runner. This delay is enforced by the
agent loop, including when edit and run calls arrive in one tool batch, so the
human has time to see the canvas change. The Stop control can abort the wait.

The harness subscribes temporarily to `logLines()`, waits for
`window.__grstats`, differences two snapshots, and reports per-block item rates,
buffer fullness, realtime factor, Probe values, console errors, and the
`__grUsbStats` / `__grFileStats` / `__grAudioStats` side channels. Message-only
blocks are never called stalled merely because their item counter is zero. The
graph is left running after observation. A later canvas edit marks the run bar
as stale.

Hardware that lacks an existing WebUSB grant adds an Allow & Run row. Its click
calls `run()` directly so `requestDevice()` retains transient activation. A
PlutoSDR or HackRF sink always adds a Transmit & Run row, even with persistent
permission, and names its center frequency and sample rate. Transmit approval is
per run.

## Token discipline

Everything in the transcript is resent on every one of a turn's up-to-50 tool
rounds, so a payload's size is multiplied by how early in the turn it appears.
Three places account for most of it, and each is trimmed without hiding
anything from the model:

- **The runnable block index** in the system prompt is grouped under category
  headers rather than restating a category on each of its blocks — same 539
  ids, labels and categories, 35 KB down to 26 KB, and it is in the prefix of
  every request.
- **`describe_block`'s `api_documentation`** is truncated at `API_DOC_LIMIT`
  (`catalog.ts`) to a line boundary, ending in a note naming
  `full_docs: true` as the way to read the rest. Doxygen prose runs to 8.7 KB
  for a single block.
- **Mutation results** report blocking issues in full and non-blocking ones as
  a count, because a mid-build graph carries many of the latter and every edit
  would otherwise restate them all.

Prefer this shape for anything new: full detail on demand through an explicit
argument or a dedicated tool, a truncation the model can see and act on, and
never a payload whose size grows with the graph when a count would do.

**Every user message is seeded with the canvas**, by `canvasContext()` in
`tools.ts`, called from the panel's submit handler — the `get_flowgraph` result
plus the `describe_block` results, minus documentation, for the block types
placed on it. Nearly every turn used to open by asking for exactly those two
things, which is two round-trips spent on what the editor already had in hand.
It is seeded into the *message*, never the system prompt: the canvas changes
between turns and the cached prefix must not. The transcript bubble still shows
only what the user typed.

That payload rides along on every round of the turn, so it is capped and the
caps are load-bearing. `qtgui_time_sink_x` alone describes ten traces in six
styling parameters each and runs to 7.7 KB; two GUI sinks would have put 13 KB
into every message. `SEED_TYPE_BYTES` keeps a head of each type's parameters —
GRC orders what a block *does* before per-trace styling, so the head is the
useful part — and names the remainder for `describe_block`. `SEED_GRAPH_LIMIT`
turns an oversized canvas into a one-line summary, `SEED_DEFINITION_LIMIT` and
`SEED_DEFINITION_BYTES` bound the definitions, and each degradation names the
tool that reads what it left out. An ordinary eight-block canvas with two GUI
sinks seeds about 10 KB against roughly 18 KB uncapped, and saves two rounds
that would each have resent the whole prefix.

`canvasContext()` is also the one payload built on the *submit* path rather than
inside the agent loop, where a throw would swallow the user's message instead of
becoming a tool error — so it catches, falls back to a line naming
`get_flowgraph`, and lets the turn proceed.

**Round count is the other multiplier, and it is the model's to spend.** One
HTTP request per round, the whole transcript resent in each, so a turn that
takes twenty rounds pays for its own history twenty times — the same work in
five rounds is a quarter of the input tokens and a quarter of the requests
against the proxy's per-IP window. `agent.turn()` has always executed every
tool call in a round together, so nothing but the model decides how many arrive
at once. Four things ask it for more: the seeded canvas above removes the
opening read entirely, `apply_edits` raises the ceiling on what one call can be
— a graph built from scratch is one call rather than one per block, parameter
and wire — `parallel_tool_calls` is stated in
`client.ts` rather than left to the provider's default (OpenAI's is on,
OpenRouter's is the routed model's, and the proxy sets it upstream itself since
its whitelist would otherwise drop the caller's), and the system prompt names
batching as a rule with the case that is easy to get wrong — a batch dispatches
in order, so an `add_block` that names its block explicitly can be followed by
the `set_params` and `connect` entries using that name in the same batch. Only a
call whose arguments are not knowable until an earlier result arrives has to
wait for the next round. The prompt also names the pairing that costs a round
every debugging iteration: `run_flowgraph` placed after the `apply_edits` it
tests, in the same batch, which the graph-preview delay was already written to
handle. The request field is sent alongside tools only, which
is the only shape OpenAI accepts it in.

Those three are all input-side, which is where OpenRouter's cost sits. **On
OpenAI the input side is largely already discounted** — it caches prompt
prefixes above about 1024 tokens by itself, with no `cache_control` to send, and
the prefix here is stable by construction: `rebuildAgent()` fixes the system
prompt once and history only ever appends. What is left is the output side, so
the two OpenAI-only request fields are:

- **`prompt_cache_key`** (`CACHE_KEY` in `agent.ts`), one per page rather than
  one per conversation, because every conversation shares the same system
  prefix and a New chat should start against a warm cache.
- **`reasoning_effort` — currently unset, and not by choice.** Reasoning tokens
  bill at the output rate and are never served from cache, and a turn spends
  most of its up-to-50 rounds mechanically threading one tool result into the
  next tool call, so a low effort is exactly what this loop wants. But
  `gpt-5.4-mini` refuses the field alongside function tools on
  `/v1/chat/completions`:

  > Function tools with reasoning_effort are not supported for gpt-5.4-mini in
  > /v1/chat/completions. To use function tools, use /v1/responses or set
  > reasoning_effort to 'none'.

  Every request this dock makes carries the graph tools, so on this request
  path the only reachable values are unset and `'none'` — all-or-nothing, with
  no way to ask for *less* reasoning rather than none. `AI_PROVIDERS.openai`
  therefore sends nothing, and `reasoningEffort` stays in the descriptor as the
  one-word switch if `'none'` is measured to be worth its quality cost.

  Graduated effort needs `/v1/responses`, which would also let reasoning items
  survive between tool rounds instead of being re-derived on each of them. That
  is a second request path against the one `client.ts` deliberately shares, so
  it wants the usage split below first — otherwise there is no way to tell
  whether it paid.

Judge all of it against the header's hover breakdown rather than the headline
number: the cached share of input says whether the prefix cache is being hit at
all, and the reasoning share of output is the part no cache ever discounts.
Neither is visible in a token total, which is why one existed before the split
did.

## Tests

Keep the pure edit dispatcher covered through a stub `AiToolDeps`, and the loop
covered with an SSE-producing fetch stub; neither needs a key or network. The
same stub covers the provider split — that an OpenAI turn reaches
`api.openai.com` with no attribution headers and an explicit usage request, that
a shared-proxy turn reaches `ai.gnuradioworld.com` with **no** `Authorization`
header and stores no key, that the second shared provider reaches the
`/openrouter/v1` path on that same host under the same rules, that each
provider's stored key is independent, and that the model lists are parsed the
way each provider actually returns them. Radio
gesture checks belong in the existing radio suites. The normal editor check must
pass with no stored key:

```bash
(cd editor && npm run check)
node test/test_smoke.mjs
```

The proxy has a suite of its own, on plain Node with no Wrangler and no network:

```bash
(cd workers/ai-proxy && npm test)
```
