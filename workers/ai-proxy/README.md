# Flowgraph Copilot shared-key proxy

This Cloudflare Worker is what makes Flowgraph Copilot usable without an API
key. The editor's default provider — "GNU Radio World (free)" — sends its
chat-completion requests here, and this Worker forwards them to OpenAI using one
key held for every visitor, metering that key so no single visitor, and no
single day, can drain it.

It answers on `ai.gnuradioworld.com` and speaks the OpenAI chat-completions wire
format, so the editor's one request path in `editor/src/ai/client.ts` reaches it
unchanged. See [docs/ai-copilot.md](../../docs/ai-copilot.md) for the editor
side.

## What it is not

It is not a passthrough. The upstream request body is rebuilt from a whitelist
in `sanitizeBody()`, which is what keeps a caller from turning the shared key
into a general-purpose OpenAI proxy:

| field | treatment |
|-------|-----------|
| `model` | must equal `MODEL`, or the request is refused by name |
| `stream` | forced on |
| `stream_options.include_usage` | forced on — the metering settles against this event |
| `max_completion_tokens` | replaced with `MAX_COMPLETION_TOKENS`, a ceiling on one completion |
| `prompt_cache_key` | replaced with one shared key, so every visitor warms the same prefix |
| `messages`, `tools`, `tool_choice` | passed through, within size limits |
| anything else (`user`, `store`, `metadata`, …) | dropped |

The key never leaves the Worker: a caller's own `Authorization` header is
discarded, and an upstream error body — which can name the organization and the
key — is replaced with a sanitized message rather than forwarded.

`GET /v1/models` answers from `MODEL` alone and never calls OpenAI, so the
account's model catalog is not exposed either.

## Rate limiting

Two instances of one Durable Object class, `TokenLimiter`, using the same
arithmetic over different windows:

- **per client IP**, `TOKENS_PER_MINUTE` over a rolling 60 seconds (1,000,000
  by default)
- **globally**, `DAILY_TOKEN_CAP` over the **UTC calendar day** (2,500,000 by
  default)

The per-IP limit is the abuse ceiling. The **daily cap is what bounds the
bill** — a rotating-IP client never trips the per-IP window, and 1M tokens per
minute is not a small budget. Set it against what you are willing to spend.

The daily window is anchored to the epoch rather than to its first request, and
the epoch is itself midnight UTC — so the site's budget resets at **00:00 UTC**
for everyone at once, on the same boundary the usage records are keyed by,
instead of 24 hours after whichever request happened to open the period. A
window state left behind by an unaligned anchor rolls on the next request
rather than holding that anchor for one more day, so changing this needs no
migration.

A completion's token count is only known once its stream has ended, so a request
**reserves** an estimate (`body bytes ÷ 4`, plus `OUTPUT_ESTIMATE` for the
answer) before it is forwarded, and **settles** the difference when the usage
event arrives. A settle carries the `windowStart` of its reservation, so one
that lands after its window has rolled is discarded rather than charged against
the next minute — or, for the daily window, against tomorrow.

Reservation is deliberately **admit-if-under-limit**: a request is allowed
whenever the window still has budget, even when its estimate would carry it
past. One large turn can therefore overshoot the ceiling, which is the friendly
failure — the alternative refuses a legitimate long conversation outright — and
it costs at most one request's worth of tokens.

A refused request answers `429` with `Retry-After`, a `rate_limit_exceeded`
error in OpenAI's shape, and a message naming the wait and the way forward. The
editor shows that message and offers to switch to a personal key.

Every response carries `X-RateLimit-Limit-Tokens`,
`X-RateLimit-Remaining-Tokens` and `X-RateLimit-Reset-Seconds` for the caller's
per-IP window.

## Usage stats

Every request already passes through the global Durable Object to be metered, so
the usage history rides along on calls that had to happen anyway — no extra
service, no extra request, and nothing to keep running.

One record per UTC day:

| field | meaning |
|-------|---------|
| `requests` | upstream completions attempted |
| `turns` | requests that *began* a turn — see below |
| `visitors` | distinct visitors that day |
| `tokens` | tokens charged, estimate included where no usage event arrived |
| `refused` | requests stopped by a rate limit |
| `failed` | requests that reached no model, and were refunded |

**`requests` is not a measure of use.** The agent loop sends one request per tool
round, so a single thing a human asked for is roughly ten of them. `turns` is the
honest number: a round that begins a turn is the one whose last message came from
the user, where every later round of the same turn ends with a tool result.

### How a visitor is counted without keeping one

A visitor is a **hash of their IP under a salt that is regenerated every day and
never kept**. Within a day the count is exact. Once the day turns over the salt
is replaced, and the hashes it produced become permanently inert: yesterday's
cannot be matched against today's, and none of them can be walked back to an
address, because the input that produced them no longer exists anywhere. The raw
IP is used to compute the hash and is never written to storage, and `/stats`
reports counts only — a hash never leaves the object.

Two constants in `src/limiter.js` bound it: `RETAIN_DAYS` (400) prunes old
records on the first request of each day, and `MAX_VISITORS` (5,000) caps one
day's hash set. Past that cap the day still counts every request and sets
`visitors_capped`, so the visitor number reads as a floor rather than a lie.

### Reading it

Configure a token once:

```bash
npx wrangler secret put STATS_TOKEN
```

Then:

```bash
curl -s -H "Authorization: Bearer $STATS_TOKEN" \
  'https://ai.gnuradioworld.com/stats?days=30' | jq
```

`/stats` is answered **before** the origin gate, because a terminal sends no
`Origin` at all, and deliberately **outside CORS**, so no page can read it. An
absent `STATS_TOKEN` gives 503 rather than an open endpoint; a wrong one gives
401.

## Origins

`Origin` is checked against the site, its Pages previews, and any local port —
the same set `scripts/r2-cors.json` allows for the recordings bucket. **This is
not a security boundary**: `Origin` is trivially forged outside a browser. It
only stops another site's page from spending this key. The real floor is the
per-IP limit, the daily cap, and a spend limit configured on the OpenAI key
itself — configure that too.

`Access-Control-Max-Age` is a day, because a JSON `POST` is preflighted and
without it every completion would cost two Worker requests instead of one.

## Deploy

Durable Objects require the Workers Paid plan, which this account already has
for the Queue in `workers/sigmf-indexer`.

1. With Node.js 20.3 or newer, install dependencies and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

2. Point `ai.gnuradioworld.com` at the Worker. The `custom_domain` route in
   `wrangler.jsonc` creates the DNS record on first deploy, provided the zone is
   on this Cloudflare account.

3. Store the shared OpenAI key. Create a dedicated key with a **hard monthly
   spend limit** on it — that limit is the last line of defense:

   ```bash
   printf '%s' "$OPENAI_KEY" | npm exec wrangler secret put OPENAI_API_KEY
   ```

4. Store a token for the usage history (optional, but there is no way to add it
   later without a redeploy of nothing — it is only a secret, so do it now):

   ```bash
   npx wrangler secret put STATS_TOKEN
   ```

5. Run the tests and deploy:

   ```bash
   npm test
   npm run deploy
   ```

6. Stream diagnostics with `npm run tail`, and read the history with `/stats`
   as described under "Usage stats" above.

Without `OPENAI_API_KEY` the Worker answers `503` and says the shared model is
not configured, rather than failing at OpenAI.

## Tunables

All of these are plain `vars` in `wrangler.jsonc`; `src/index.js` carries the
same values as `DEFAULTS` so the tests need no environment.

| var | default | what it decides |
|-----|---------|-----------------|
| `MODEL` | `gpt-5.4-mini` | the only model the shared key is accepted for |
| `TOKENS_PER_MINUTE` | `1000000` | per-IP ceiling |
| `DAILY_TOKEN_CAP` | `2500000` | site-wide ceiling per UTC day — the bill's bound |
| `MAX_BODY_BYTES` | `1048576` | largest accepted request |
| `MAX_COMPLETION_TOKENS` | `16384` | ceiling on one completion, reasoning included |
| `OUTPUT_ESTIMATE` | `2000` | assumed output when reserving |

Changing `MODEL` alone is not enough: the editor's picker is locked to
`HOSTED_MODEL` in `editor/src/ai/providers.ts`, and the proxy refuses anything
else by name. Change both together.

## Tests

`npm test` runs `node --test` against `test/`, on plain Node with no Wrangler,
Worker runtime, or network involved. The window arithmetic and the stats folding
are exported as pure functions, and the request path is exercised against the
**real** `TokenLimiter` class over `test/storage.js`'s in-memory stand-in for
Durable Object storage, with a stubbed upstream — so the metering and counting
under test are the code that ships, not a reimplementation of it.

Salt rotation is covered by stubbing `Date.now` across a day boundary and
asserting that the same visitor leaves two unrelated hashes.
