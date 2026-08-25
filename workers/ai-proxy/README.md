# Graham shared-key proxy

This Cloudflare Worker is what makes Graham usable without an API
key. The editor's two free providers — "OpenAI Free Tier (gpt-5.6-luna)" and
"OpenRouter Free Tier (nemotron-3-ultra)" — send their chat-completion requests here,
and this Worker forwards them upstream using a key held for every visitor,
metering that key so no single visitor, and no single day, can drain it.

It answers on `ai.gnuradioworld.com` and speaks the OpenAI chat-completions wire
format, so the editor's one request path in `editor/src/ai/client.ts` reaches it
unchanged. See [docs/graham.md](../../docs/graham.md) for the editor
side.

## Two upstreams, selected by path

| path | upstream | key | models | metered in |
|------|----------|-----|--------|-----------|
| `/v1/…` | `api.openai.com` | `OPENAI_API_KEY` | `MODELS` | tokens |
| `/openrouter/v1/…` | `openrouter.ai` | `OPENROUTER_API_KEY` | `OPENROUTER_MODELS` | requests |

**The path is the whole of the routing.** Nothing in the request body can move a
request from one key to the other: each upstream has its own model allowlist and
refuses the other's ids by name. Everything an upstream differs in — its URL,
its key variable, its allowlist, its window limits, the field it takes an
output ceiling in, whether it gets a cache key, what reasoning effort it is
sent, and whether the Worker attributes the request — is a field of `UPSTREAMS`
in `src/index.js`, so a third one is another entry rather than a branch.

The OpenRouter upstream exists to offer a large open-weights model at no cost,
and it serves **`:free` model ids only**. That suffix is what pins a request to
the endpoints that charge nothing; the same id without it is a paid model, and
the shared key must never reach one. `npm test` asserts the allowlist keeps the
suffix.

Each upstream also meters into Durable Objects of its own (the OpenRouter ones
under an `or:` name prefix), so their windows, their refusals and their usage
histories are independent — the free tier running out is not the site losing its
Graham, and neither is the paid budget running out.

## What it is not

It is not a passthrough. The upstream request body is rebuilt from a whitelist
in `sanitizeBody()`, which is what keeps a caller from turning a shared key
into a general-purpose proxy:

| field | treatment |
|-------|-----------|
| `model` | must be one of that upstream's allowlist, or the request is refused by name; absent means the first |
| `stream` | forced on |
| `stream_options.include_usage` | forced on — the metering settles against this event, and the history counts tokens from it either way |
| the output ceiling | replaced with `MAX_COMPLETION_TOKENS`, under the name that upstream knows it by — `max_completion_tokens` on OpenAI, `max_tokens` on OpenRouter |
| `reasoning_effort` | set by the upstream, never accepted: `'none'` on OpenAI, whose models otherwise refuse function tools, and `'low'` on the free model, where reasoning is just slower output |
| `prompt_cache_key` | OpenAI only, replaced with one shared key per model so every visitor warms the same prefix; dropped entirely on OpenRouter |
| `messages`, `tools`, `tool_choice` | passed through, within size limits |
| anything else (`user`, `store`, `metadata`, …) | dropped |

OpenRouter's ranking headers (`HTTP-Referer`, `X-Title`) are added by the Worker
on that upstream. They are not the browser's to send: the editor only ever talks
to this origin, so its own headers would name the wrong thing and widen its
preflight for nothing.

The key never leaves the Worker: a caller's own `Authorization` header is
discarded, and an upstream error body — which can name the organization and the
key — is replaced with a sanitized message rather than forwarded.

`GET /v1/models` and `GET /openrouter/v1/models` answer from their upstream's
allowlist alone and never call it, so neither account's model catalog is
exposed either.

## Rate limiting

Instances of one Durable Object class, `TokenLimiter`, use the same arithmetic
over different windows:

- **per client IP**, over a rolling 60 seconds
- **per client IP**, over the **UTC calendar day**, on OpenAI
- **globally**, over the **UTC calendar day**

The minute limit is the abuse ceiling. The per-user daily cap gives each
visitor a fair share; because there is no account or login, a "user" here is a
client IP. The **global daily cap is what bounds the bill** — a rotating-IP
client can evade either visitor limit. Set it against what you are willing to
spend.

What those windows *count* is the upstream's own unit:

| upstream | per IP, per minute | per IP, per UTC day | site-wide, per UTC day |
|----------|--------------------|---------------------|------------------------|
| OpenAI | `TOKENS_PER_MINUTE` tokens (1,000,000) | `PER_USER_DAILY_CAP` tokens (1,000,000) | `GLOBAL_DAILY_TOKEN_CAP` tokens (5,000,000) |
| OpenRouter | `OPENROUTER_REQUESTS_PER_MINUTE` requests (15) | — | `OPENROUTER_DAILY_REQUEST_CAP` requests (900) |

**A free model has no bill for a token budget to bound.** What runs out on the
OpenRouter path is the free-tier *request* allowance OpenRouter grants the
account itself: **20 requests a minute, and 50 a day — or 1000 a day once the
account has bought at least 10 credits.** Requests are therefore what those
windows ration, and both defaults are set under those ceilings, the daily one
assuming the 1000 tier. Check which allowance the account actually has and set
`OPENROUTER_DAILY_REQUEST_CAP` below it; a cap set above it only moves the
refusal upstream, where it reads as a broken model rather than a spent budget.
Note that OpenRouter's minute limit is per *account*, not per caller, so the
per-IP window cannot stop two visitors contending for it — it only stops one
visitor from being the reason. A request-metered
reservation is exact from the start — one request is one unit — so it reserves
one and settles nothing; the usage event is still read, because the day's
history counts tokens whether or not they cost anything.

The daily windows are anchored to the epoch rather than to their first request,
and the epoch is itself midnight UTC — so both visitor and site-wide budgets
reset at **00:00 UTC** for everyone at once, on the same boundary the usage
records are keyed by, instead of 24 hours after whichever request happened to
open the period. A window state left behind by an unaligned anchor rolls on the
next request rather than holding that anchor for one more day, so changing this
needs no migration.

A completion's token count is only known once its stream has ended, so a request
**reserves** an estimate (`body bytes ÷ 4`, plus `OUTPUT_ESTIMATE` for the
answer) before it is forwarded, and **settles** the difference when the usage
event arrives. A settle carries the `windowStart` of its reservation, so one
that lands after its window has rolled is discarded rather than charged against
the next minute — or, for the daily window, against tomorrow.

Reservation is deliberately **admit-if-under-limit**: a request is allowed
whenever every applicable window still has budget, even when its estimate would
carry one past. One large turn can therefore overshoot a ceiling, which is the
friendly failure — the alternative refuses a legitimate long conversation
outright — and it costs at most one request's worth of tokens.

A refused request answers `429` with `Retry-After`, a `rate_limit_exceeded`
error in OpenAI's shape, and a message naming the wait and the way forward. The
editor shows that message and offers to switch to a personal key.

Every response carries `X-RateLimit-Reset-Seconds` and a limit/remaining pair
for the caller's per-IP window, named for what that window counts —
`X-RateLimit-Limit-Tokens` and `-Remaining-Tokens` on the OpenAI path,
`-Limit-Requests` and `-Remaining-Requests` on the free one.

## Usage stats

Every request already passes through its upstream's global Durable Object to be
metered, so the usage history rides along on calls that had to happen anyway —
no extra service, no extra request, and nothing to keep running.

One record per UTC day, per upstream:

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

Configure a token once, and keep a copy — Cloudflare stores it write-only and
will not hand it back, so a lost token means putting a new one:

```bash
STATS_TOKEN=$(openssl rand -hex 32)
printf '%s' "$STATS_TOKEN" | npx wrangler secret put STATS_TOKEN
```

Generating it into a shell variable is what makes the read below work in the
same shell; `wrangler secret put` sends the value to Cloudflare and sets nothing
locally, so prompting for it instead leaves `$STATS_TOKEN` empty and every read
answers 401. Export it from your profile, or an ignored env file, to keep it
across shells.

```bash
curl -s -H "Authorization: Bearer $STATS_TOKEN" \
  'https://ai.gnuradioworld.com/stats?days=30' | jq
curl -s -H "Authorization: Bearer $STATS_TOKEN" \
  'https://ai.gnuradioworld.com/stats?days=30&upstream=openrouter' | jq
```

`days` defaults to 30 and the newest day comes first. `upstream` defaults to
`openai`, so an existing read keeps reading what it always did; each upstream
has a history of its own, and there is no combined view. On the free upstream
`tokens` is a measure of work rather than of money — nothing there is billed.

`/stats` is answered **before** the origin gate, because a terminal sends no
`Origin` at all, and deliberately **outside CORS**, so no page can read it. An
absent `STATS_TOKEN` gives 503 rather than an open endpoint; a wrong one gives
401.

## Origins

`Origin` is checked against the site, its Pages previews, and any local port —
the same set `scripts/r2-cors.json` allows for the recordings bucket. **This is
not a security boundary**: `Origin` is trivially forged outside a browser. It
only stops another site's page from spending this key. The real floor is the
visitor limits, the global daily cap, and a spend limit configured on the
OpenAI key itself — configure that too.

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

3. Store the shared keys. Create a dedicated OpenAI key with a **hard monthly
   spend limit** on it — that limit is the last line of defense:

   ```bash
   printf '%s' "$OPENAI_KEY" | npm exec wrangler secret put OPENAI_API_KEY
   ```

   Then a dedicated OpenRouter key for the free upstream. Nothing it can reach
   costs money — the allowlist is `:free` ids only — but its free-tier request
   allowance is 50 a day until the account has bought 10 credits, and 1000 a day
   after that. Check which one applies and set `OPENROUTER_DAILY_REQUEST_CAP`
   below it; the default of 900 assumes the larger:

   ```bash
   printf '%s' "$OPENROUTER_KEY" | npm exec wrangler secret put OPENROUTER_API_KEY
   ```

   Each upstream is optional and independent: without its key that path answers
   `503` and the other keeps working, so the OpenAI upstream can be deployed
   alone exactly as before.

4. Store a token for the usage history. Optional, and it can be added at any
   time — `wrangler secret put` redeploys the Worker but leaves the Durable
   Object's records untouched, so days recorded before the token existed are
   still readable once it does. Keep the copy it leaves in your shell:

   ```bash
   STATS_TOKEN=$(openssl rand -hex 32)
   printf '%s' "$STATS_TOKEN" | npx wrangler secret put STATS_TOKEN
   ```

5. Run the tests and deploy:

   ```bash
   npm test
   npm run deploy
   ```

6. Stream diagnostics with `npm run tail`, and read the history with `/stats`
   as described under "Usage stats" above.

Without an upstream's key the Worker answers `503` on that path and says the
shared model is not configured, rather than failing upstream. The other path is
unaffected.

## Tunables

All of these are plain `vars` in `wrangler.jsonc`; `src/index.js` carries the
same values as `DEFAULTS` so the tests need no environment.

| var | default | what it decides |
|-----|---------|-----------------|
| `MODELS` | `gpt-5.6-luna` | the models the shared OpenAI key is accepted for, comma-separated; the first is the default |
| `TOKENS_PER_MINUTE` | `1000000` | per-IP ceiling, OpenAI upstream |
| `PER_USER_DAILY_CAP` | `1000000` | per-IP ceiling per UTC day, OpenAI upstream |
| `GLOBAL_DAILY_TOKEN_CAP` | `5000000` | site-wide ceiling per UTC day — the bill's bound |
| `OPENROUTER_MODELS` | `nvidia/nemotron-3-ultra-550b-a55b:free` | the models the shared OpenRouter key is accepted for; `:free` ids only |
| `OPENROUTER_REQUESTS_PER_MINUTE` | `15` | per-IP ceiling, free upstream |
| `OPENROUTER_DAILY_REQUEST_CAP` | `900` | site-wide requests per UTC day — keep it under the account's own free-tier allowance |
| `MAX_BODY_BYTES` | `1048576` | largest accepted request, both upstreams |
| `MAX_COMPLETION_TOKENS` | `16384` | ceiling on one completion, reasoning included |
| `OUTPUT_ESTIMATE` | `2000` | assumed output when reserving on the token-metered upstream |

Changing a model list alone is not enough: the editor's pickers are populated
from `HOSTED_MODELS` and `HOSTED_OPENROUTER_MODELS` in
`editor/src/ai/providers.ts`, and the proxy refuses anything else by name.
Change both together.

Every model on the OpenAI upstream is metered against the same token windows,
which count tokens rather than dollars — so adding a cheaper model buys more
work out of the same budgets, not larger ones. That is why both lists ship with
a single entry: a second model is a choice for the user to make, not an
allowance, and a one-entry list locks the editor's picker.

## Tests

`npm test` runs `node --test` against `test/`, on plain Node with no Wrangler,
Worker runtime, or network involved. The window arithmetic and the stats folding
are exported as pure functions, and the request path is exercised against the
**real** `TokenLimiter` class over `test/storage.js`'s in-memory stand-in for
Durable Object storage, with a stubbed upstream — so the metering and counting
under test are the code that ships, not a reimplementation of it.

Salt rotation is covered by stubbing `Date.now` across a day boundary and
asserting that the same visitor leaves two unrelated hashes.
