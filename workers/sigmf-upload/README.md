# SigMF submission and triage Worker

This Worker accepts anonymous, multipart SigMF submissions into a separate R2
triage bucket. D1 stores upload state, public notes, review history, and private
uploader contact details. Nothing enters the production recording bucket until
an authorized reviewer approves it.

The public API and `/recordings/triage/` deliberately expose completed triage
recordings. Upload capabilities and uploader contact fields are never returned
by a public route. The editor's ordinary recording index and picker continue to
read only the production bucket's `index.json`.

## Limits and lifecycle

- 1–10 SigMF pairs per submission
- 300,000,000 bytes per `.sigmf-data`
- 5,000,000 bytes per `.sigmf-meta`
- 2,000,000,000 bytes for the complete submission
- incomplete uploads expire after 24 hours
- completed triage submissions expire after 30 days if nobody reviews them
- private contact data is erased 30 days after approval/rejection

The browser rejects incomplete pairs, bad JSON, unsupported `core:datatype`,
oversized files, and sample-size misalignment before uploading. The Worker
repeats all security-relevant checks and verifies the final R2 object sizes.

## Provision and deploy

Run these commands from this directory after authenticating Wrangler:

```bash
npm ci
npx wrangler r2 bucket create gnuradio-world-recording-triage
npx wrangler d1 create gnuradio-world-recording-submissions
```

Put the returned D1 UUID in `wrangler.jsonc`, then initialize it:

```bash
npx wrangler d1 migrations apply gnuradio-world-recording-submissions --remote
npx wrangler r2 bucket cors set gnuradio-world-recording-triage \
  --file ../../scripts/r2-triage-cors.json
npx wrangler secret put TURNSTILE_SECRET
npm run deploy
```

Create a public custom domain such as
`recording-submissions.gnuradioworld.com` for the Worker and a public custom
domain such as `triage-recordings.gnuradioworld.com` for the triage bucket.
Keep the production R2 binding pointed at `gnuradio-wasm-recordings`; approvals
copy data first and metadata last, which causes the existing SigMF indexer to
publish the complete pair.

Configure these Pages build variables:

```text
VITE_RECORDING_UPLOAD_API=https://recording-submissions.gnuradioworld.com
VITE_RECORDING_REVIEW_API=https://review-recordings.gnuradioworld.com
VITE_TURNSTILE_SITE_KEY=<public Turnstile site key>
```

The Turnstile widget must allow the production, Pages, preview, and local test
hostnames that the Worker's origin allowlist accepts.

## Privileged authorization

Create a second custom hostname for this same Worker, for example
`review-recordings.gnuradioworld.com`, then create a Cloudflare Access
self-hosted application covering that hostname. Its Allow policy should name
the reviewer emails or an identity-provider group; do not use an `Everyone`
policy. Put the application audience tag in `ACCESS_AUD`, the team URL in
`ACCESS_TEAM_DOMAIN`, and repeat the allowed emails in `ADMIN_EMAILS` as a
defense-in-depth check.

Access authenticates the reviewer before an `/v1/admin/*` request reaches the
Worker and supplies `Cf-Access-Jwt-Assertion`. The Worker verifies the JWT's
RS256 signature against the team's JWKS, issuer, audience, expiry, and email
allowlist on every admin request. Public endpoints never accept this header as
authority and never return contact data.

Reviewer mode links to `/v1/admin/session?return=...`. Cloudflare Access performs
the login, the Worker validates the resulting assertion, and then redirects to
the triage UI. Subsequent credentialed requests to the review hostname carry
the Access cookie; Access injects a fresh assertion before the Worker sees them.
Approval/rejection requires an explicit confirmation body and is recorded in
`review_events` with reviewer email and timestamp.

Because Access policy is enforced at the hostname, exclude the public upload
hostname from that Access application. Conversely, do not expose the admin
routes on a Worker route that bypasses Access; the Worker JWT check remains a
second layer, not a replacement for the Access boundary.

## Local work

```bash
npm run dev
npm test
```

Use Wrangler D1/R2 local bindings for end-to-end testing. The public uploader
uses Turnstile's documented localhost test site key when built without a site
key on localhost; provide the corresponding test secret to the local Worker.
