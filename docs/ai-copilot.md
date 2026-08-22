# Flowgraph Copilot

Flowgraph Copilot is the editor's bring-your-own-key AI assistant. It can inspect
and edit the canvas through validated structured operations, run the graph in the
normal visible QT GUI tab, and read the runner's diagnostics snapshot. Its code
lives under `editor/src/ai/`; `editor/src/main.ts` supplies the narrow dependency
bundle that is allowed to touch editor state.

The feature is public and discoverable from the toolbar and Tools menu, with its
dock collapsed by default. The header's New chat control clears the transcript
and accumulated spend and creates a fresh agent conversation without changing the
canvas, connection, or selected model; it is disabled while a turn is running.

## Two providers, one request path

The dock talks to **OpenRouter** or to **OpenAI's own API**, chosen in the
provider select above the model picker and remembered in
`localStorage['gnuradio-world.ai-provider']`; OpenRouter is the default. Both
speak the OpenAI chat-completions wire format, so `editor/src/ai/client.ts` holds
the single streaming request path and model-list call for both, and
`editor/src/ai/providers.ts` holds everything that differs — base URL, default
model, key storage keys, dialog copy, and the capability flags below.
`editor/src/ai/openrouter.ts` is now only OpenRouter's OAuth flow, which OpenAI
has no equivalent of.

Everything a provider is allowed to differ in is a descriptor field, so a third
provider is a new entry in `AI_PROVIDERS` rather than a branch in the panel:

| difference | OpenRouter | OpenAI |
|------------|-----------|--------|
| connect | OAuth PKCE, or a pasted key | a pasted key only (`oauth`) |
| model list | public, filtered to `supported_parameters=tools` | authenticated, and unfiltered — the chat families are picked out of every model of every kind the account can see (`modelsNeedKey`) |
| default model | `google/gemini-3.7-flash` | `gpt-5.4-mini` |
| attribution | `HTTP-Referer` and `X-Title` | none — OpenAI rejects them in preflight (`attribution`) |
| usage | appended to the stream automatically, with a cost | only when asked with `stream_options.include_usage`, and priced nowhere (`requestUsage`, `reportsCost`) |

Because OpenAI prices nothing in its usage event, the header shows accumulated
tokens there and a dollar figure on OpenRouter. Model lists are cached per
provider, an authenticated one is dropped on Disconnect, and a list that arrives
after the user has switched providers is discarded rather than shown.

Each provider's saved model selection always takes precedence over the default.
If the wanted model is absent from the live catalog, the picker requires an
explicit replacement instead of submitting an invalid model.

## Data and key boundary

GNU Radio World is static, so the browser calls `https://openrouter.ai` or
`https://api.openai.com` directly — never both, and the dock's boundary line
names the one connected. The connection dialog says exactly what crosses that
boundary, rewriting its copy, links, and buttons for the provider chosen in it.
OpenRouter receives the API key plus the request, and the selected model provider
receives the prompt, flowgraph, runnable block metadata, tool results, and
console output captured during an observed run, but not the OpenRouter key; on
OpenAI the one host receives both. The dialog links to the exact client source,
that provider's privacy or data controls, and its key page, where a user can
create a dedicated key with a small spending limit.

The primary Connect with OpenRouter path uses OAuth PKCE with an S256 challenge,
so a user authorizes on OpenRouter instead of pasting a key into the editor. The
one-time verifier and a canvas snapshot live in `sessionStorage`; after the
redirect the authorization code is exchanged directly with OpenRouter, removed
from the URL, and the canvas is restored — switching the dock back to OpenRouter
if it had since moved to OpenAI. Manual key entry remains available, and is the
whole of the OpenAI path.

**Each provider stores its own key, consent, and model, and never sees the
other's.** Keys are session-only by default in
`sessionStorage['gnuradio-world.<provider>-session-key']`. The explicit Remember
checkbox instead uses `localStorage['gnuradio-world.<provider>-key']`; all storage
access is behind try/catch so disabled storage degrades to the in-memory session.
The always-visible Disconnect control clears both locations for the connected
provider. A key must never enter a URL, flowgraph, console message, runner
`postMessage`, or recording binding. Transcript nodes are built with
`createElement`, `textContent`, and text nodes; model output and tool payloads are
untrusted.

Both API origins are declared in `providers.ts` with a
`pr-security-scan: allow new-outbound-host` line, which is what keeps the PR
security gate's new-host rule from blocking on them; a further provider needs the
same. Streaming tool-call fragments are joined by their index, and aborting the
dock's Stop control aborts the fetch.

## Graph editing and history

`tools.ts` exposes granular edits. Parameter names are checked against the
instance's `defFor(inst)` definition before a mutation; an unknown id is a tool
error that lists valid ids. Port labels and message ports resolve through the
same expanded port metadata the canvas uses. Each mutation returns the fresh
validation state.

The editor's ordinary actions record history immediately, but Copilot operations
use non-recording variants. The panel snapshots before a user turn, allows all
tool calls to auto-apply and redraw, then calls `recordHistory()` exactly once if
the snapshot changed. Ctrl+Z therefore reverses the entire turn. The message's
diff is derived from the two snapshots, and Revert restores the pre-turn snapshot
as another undoable history entry.

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

## Tests

Keep the pure edit dispatcher covered through a stub `AiToolDeps`, and the loop
covered with an SSE-producing fetch stub; neither needs a key or network. The
same stub covers the provider split — that an OpenAI turn reaches
`api.openai.com` with no attribution headers and an explicit usage request, that
each provider's stored key is independent, and that the two model lists are
parsed the way each provider actually returns them. Radio
gesture checks belong in the existing radio suites. The normal editor check must
pass with no stored key:

```bash
(cd editor && npm run check)
node test/test_smoke.mjs
```
