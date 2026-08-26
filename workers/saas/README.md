# Graham prepaid credits service

This Cloudflare Worker is Graham's optional authenticated, prepaid-credit
provider. Users sign in with Google or GitHub, buy one-time credit packs through
Polar, and spend the D1 balance on a bounded OpenAI Chat Completions path. It is
separate from `workers/ai-proxy`; the existing free provider remains intact.

The Worker is the billing and secret boundary. The browser never receives an
OpenAI key, Polar token, Better Auth secret, OAuth client secret, webhook
secret, or provider-spend token. `/api/chat` rebuilds an allowed request body;
there is no arbitrary upstream proxy or user API key.

## Open-source boundary

No application code has to be closed source. This directory, its migrations,
pricing arithmetic, and editor integration are safe to publish. Keep these as
Cloudflare secrets, never committed files or Wrangler vars:

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_SECRET`
- `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET`
- `OPENAI_API_KEY`
- optional `PROVIDER_SPEND_TOKEN`, `ALERT_WEBHOOK_URL`, and legacy
  `EMAIL_WEBHOOK_URL`

OAuth client IDs, Polar product IDs, public prices, routes, and D1 database IDs
are identifiers rather than credentials. The actual D1 contents—users,
balances, ledger rows, and `model_rates`—remain private service data even though
the schema is public. Exact wholesale rates and markup can therefore remain
private D1 rows without making any source code private.

## Implemented behavior

- Better Auth 1.7 with native D1, Google/GitHub only, verified-email account
  linking, secure `httpOnly`/`sameSite=lax` cookies, and a tighter OAuth limit.
- Polar's Better Auth plugin for customer creation, authenticated checkout,
  portal, and verified webhooks. Only a signed `order.paid` event grants credits,
  and the server's product-ID map—not client metadata—sets the amount.
- Integer micro-dollar, versioned, cache-aware pricing; basis-point markup;
  minimum charges; bounded output; and a 20% reservation pad.
- Conditional D1 reservation, retry-safe atomic settlement, immutable ledger,
  FIFO credit lots, refunds/dispute freezes, and 12-month expiry.
- `waitUntil()` settlement. Client disconnects are billed from exact usage or an
  estimate; upstream failures are released and recorded as absorbed cost.
- Minute hold reaping and daily balance/hold/Polar-order/absorbed-cost
  reconciliation, reports, expiry, and low-balance notification hooks.

Polar meters are intentionally absent. D1 is the only usage authority.

## 1. Polar sandbox

Use Polar's sandbox first; sandbox and production tokens, customers, and
product IDs are separate.

1. Create one-time `$5`, `$10`, `$25`, `$50`, and `$100` products. Do not use a
   subscription or metered price.
2. Create an organization access token with customer, checkout, portal, order,
   and refund access.
3. Create a webhook endpoint at
   `https://<sandbox-worker>/api/webhooks/polar`, subscribing at least to
   `order.paid`, `refund.created`, `customer.created`, and `customer.updated`.
4. Put the sandbox product IDs into the sandbox `CREDIT_PRODUCTS` var:

```json
{
  "credits-5": {"productId":"PRODUCT_ID","creditsMicros":5000000},
  "credits-10":{"productId":"PRODUCT_ID","creditsMicros":10000000},
  "credits-25":{"productId":"PRODUCT_ID","creditsMicros":25000000},
  "credits-50":{"productId":"PRODUCT_ID","creditsMicros":50000000},
  "credits-100":{"productId":"PRODUCT_ID","creditsMicros":100000000}
}
```

Checkout metadata and client-supplied amounts are ignored.

## 2. Better Auth and OAuth

Better Auth is the library already installed in this Worker, not another hosted
account to create. Create Google and GitHub OAuth applications and register:

```text
https://credits.gnuradioworld.com/api/auth/callback/google
https://credits.gnuradioworld.com/api/auth/callback/github
```

Register separate sandbox/local callbacks too. GitHub requests `user:email`; an
identity that still supplies no verified email is rejected. Generate the auth
secret locally with `openssl rand -base64 32`.

## 3. D1 and secrets

```bash
cd workers/saas
npm install
npx wrangler d1 create gnuradio-world-saas-sandbox
npx wrangler d1 create gnuradio-world-saas-production
```

Replace the placeholder IDs in `wrangler.jsonc`, then apply migrations:

```bash
npx wrangler d1 migrations apply gnuradio-world-saas-sandbox --env sandbox --remote
npx wrangler d1 migrations apply gnuradio-world-saas-production --remote
```

`0001_better_auth.sql` is tied to the pinned Better Auth version. Verify or
regenerate it with Better Auth's CLI before upgrading the package.

Set each secret in sandbox, then repeat for production without `--env sandbox`:

```bash
npx wrangler secret put BETTER_AUTH_SECRET --env sandbox
npx wrangler secret put GOOGLE_CLIENT_ID --env sandbox
npx wrangler secret put GOOGLE_CLIENT_SECRET --env sandbox
npx wrangler secret put GITHUB_CLIENT_ID --env sandbox
npx wrangler secret put GITHUB_CLIENT_SECRET --env sandbox
npx wrangler secret put POLAR_ACCESS_TOKEN --env sandbox
npx wrangler secret put POLAR_WEBHOOK_SECRET --env sandbox
npx wrangler secret put OPENAI_API_KEY --env sandbox
```

Client IDs are not secret, but storing all OAuth environment values this way is
consistent. Production uses Cloudflare Email Service through the `EMAIL` send
binding for low-balance messages and reconciliation alerts. The sending domain
must be onboarded in Cloudflare Email Service before deployment. `EMAIL_FROM`
and `SUPPORT_EMAIL` select the sender and reply/alert address. For deployments
without that binding, optional HTTPS JSON hooks are `ALERT_WEBHOOK_URL` for loud
reports, `EMAIL_WEBHOOK_URL` for low-balance mail delivery, and
`PROVIDER_SPEND_URL`/`PROVIDER_SPEND_TOKEN` for a daily
`{"spend_micros": integer}` total. Without the spend source, the absorbed-cost
identity is reported as skipped; the other reconciliations still run.

## 4. Versioned model pricing

Never fetch live upstream rates in the request path. Insert a deliberate D1
rate version. One dollar is `1_000_000` micro-dollars, so `$0.10 per million
tokens` is `100000`. This is illustrative, not a pricing recommendation:

```sql
INSERT INTO model_rates (
  id, model, provider, input_micros_per_million,
  cached_input_micros_per_million, cache_write_micros_per_million,
  output_micros_per_million, markup_bps, minimum_charge_micros, effective_at
) VALUES (
  'gpt-5.6-luna-2026-08-26', 'gpt-5.6-luna', 'openai',
  200000, 20000, 250000, 1200000, 5000, 100, unixepoch()
);
```

The catalog is exactly the set of models with an open rate version: `/api/models`
lists them for the editor's picker and `/api/chat` refuses anything else, so
offering another model is one more rate row and no code change.
`0005_gpt56_terra.sql` adds `gpt-5.6-terra` that way, copying whatever rate is
open for `gpt-5.6-luna` so the migration carries no private numbers; give terra
its own version once its upstream cost is known.

Close a rate with `ends_at` and insert a new row; never update old pricing.
Size markup using Polar's actual merchant-of-record fee, upstream cost, and
risk. The example uses a 50% sandbox markup, not a production recommendation.
Confirm Polar's current fees and chargeback threshold before production. The
200 KB request cap keeps this rate version below GPT-5.6's separate long-context
price tier; add a versioned long-context rate before raising that cap.

## 5. Test and deploy

For local sandbox development, create an ignored `.dev.vars.sandbox` beside
`wrangler.jsonc`:

```dotenv
BETTER_AUTH_SECRET="generate-with-openssl-rand-base64-32"
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
POLAR_ACCESS_TOKEN="..."
POLAR_WEBHOOK_SECRET="..."
OPENAI_API_KEY="..."
```

Apply the migrations to Wrangler's local D1, then start the Worker. The editor
automatically uses `http://localhost:8787` when it is served from localhost:

```bash
npx wrangler d1 migrations apply gnuradio-world-saas-sandbox --env sandbox --local
npm run dev
```

Use these local OAuth callback URLs:

```text
http://localhost:8787/api/auth/callback/google
http://localhost:8787/api/auth/callback/github
```

Polar cannot deliver a webhook directly to localhost. For sandbox checkout
testing, expose only the local Worker with a temporary tunnel and register its
`/api/webhooks/polar` URL in Polar. Keep the editor itself on localhost so auth
and chat requests continue to use the local Worker.

Before either local or deployed testing, insert at least one current
`model_rates` row into that environment's D1 database.

```bash
npm test
npm run check
npm run dev
npm run deploy
```

Local sandbox uses `LOCAL_INSECURE_COOKIES=true` only because plain-HTTP
localhost cannot store secure cookies. Deployed cookies remain secure.

Credits are surfaced as refundable through Polar within 14 days when unused;
consumed credits are never refunded. Polar handles sales tax/VAT as merchant of
record, but that does not decide revenue recognition. Prepaid sales may be
deferred revenue recognized on consumption; have an accountant confirm the
treatment before launch.
