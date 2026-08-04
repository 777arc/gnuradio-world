# SigMF R2 indexer

This Cloudflare Worker scans an R2 bucket after recording uploads and replaces
`index.json` with a deterministic JSON array of complete SigMF recordings. R2
event notifications enter a Cloudflare Queue, which collects up to 100 changes
for up to 60 seconds before invoking one index rebuild. A daily 4:00 AM EST cron
and an authenticated manual endpoint provide fallback rebuild paths. A recording
is included only when the bucket contains both `<base>.sigmf-data` and
`<base>.sigmf-meta`.

`base_filename` is the full object key without the SigMF suffix, including any
collection prefix (for example `estevez/ao73`). The other fields come from the
SigMF global metadata and first capture with a frequency. `number_of_samples`
is calculated from the `.sigmf-data` object's size and `core:datatype` without
reading the data object; `byte_length` carries that R2 object size for streaming
clients. The sample count is `null` for an unknown datatype or a byte count that
is not an exact number of samples.

The Worker paginates the complete R2 listing. It does not write anything until
all matched metadata has been read and parsed, so an unsuccessful refresh keeps
the previous index in place. A successful `put()` replaces that object.
The GNU Radio World editor reads this index and both recording objects directly
from R2; it has no repository recording manifest.

Each run logs every listing page and a summary containing the total object,
data, metadata, matched-pair, and other-object counts. It also logs up to ten
representative keys from each unmatched side. If the bucket contains SigMF data
or metadata but no complete pair, the run fails without replacing the previous
index; this commonly means the `.sigmf-meta` sidecars were not uploaded to R2.

## Deploy

1. Make sure `bucket_name` in `wrangler.jsonc` matches the R2 bucket name.
2. With Node.js 20.3 or newer, install dependencies and authenticate Wrangler:

   ```bash
   npm install
   npx wrangler login
   ```

3. Create the event queue once. A subsequent invocation reporting that the queue
   already exists is harmless; do not delete and recreate a production queue:

   ```bash
   npx wrangler queues create gnuradio-world-sigmf-events
   ```

4. Run the tests and deploy the Queue consumer:

   ```bash
   npm test
   npm run deploy
   ```

5. Create the two non-overlapping R2 event-notification rules once:

   ```bash
   npx wrangler r2 bucket notification create gnuradio-wasm-recordings \
     --event-type object-create \
     --queue gnuradio-world-sigmf-events \
     --suffix ".sigmf-data"

   npx wrangler r2 bucket notification create gnuradio-wasm-recordings \
     --event-type object-create \
     --queue gnuradio-world-sigmf-events \
     --suffix ".sigmf-meta"
   ```

The suffix filters ensure the Worker's own `index.json` write cannot enqueue
another rebuild. `max_batch_timeout` starts a window when the first notification
arrives; the consumer runs once after at most 60 seconds. It can run sooner if a
batch reaches 100 notifications. `max_concurrency: 1` prevents two batches from
rebuilding the index simultaneously.

The default cron is `0 9 * * *` (09:00 UTC, which is 4:00 AM EST). This is a
fixed EST schedule, so it runs at 5:00 AM when Eastern Daylight Time is active.
Change `triggers.crons` in `wrangler.jsonc` to use a different schedule.

After deployment, stream the diagnostic output with `npm run tail`.

## Manual rebuild

The Worker also accepts an authenticated `POST /rebuild`. Configure its bearer
token once (and again for each separately configured Wrangler environment):

```bash
REBUILD_TOKEN=$(openssl rand -hex 32)
printf '%s' "$REBUILD_TOKEN" | npm exec wrangler secret put REBUILD_TOKEN
```

Then trigger a rebuild at the deployed Worker URL:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $REBUILD_TOKEN" \
  https://gnuradio-world-sigmf-indexer.<account-subdomain>.workers.dev/rebuild
```

The request waits for the rebuild and returns JSON containing `ok`,
`recordings`, and `index_key`. Missing or incorrect credentials cannot start a
scan. The daily cron does not use or require this secret.

## Publish a recording

Upload matching `<base>.sigmf-data` and `<base>.sigmf-meta` objects directly to
the `gnuradio-wasm-recordings` R2 bucket using the Cloudflare dashboard, its
S3-compatible API, rclone, or another R2 client. Use the same full base key for
both objects; collection prefixes are significant. For example:

```text
estevez/ao73.sigmf-data
estevez/ao73.sigmf-meta
```

The event queue normally refreshes the index within about one minute of the first
upload notification. The daily run and authenticated manual rebuild remain as
fallbacks. The editor reads the resulting `index.json`, metadata, and sample data
directly from `https://recordings.gnuradioworld.com`. Do not add the recording or
an index to this repository, and do not rebuild or redeploy the website.

For a local scheduled-trigger check, run:

```bash
npm run dev
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+*"
```
