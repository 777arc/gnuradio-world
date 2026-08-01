# SigMF R2 indexer

This scheduled Cloudflare Worker scans an R2 bucket daily at 4:00 AM EST and replaces
`index.json` with a deterministic JSON array of complete SigMF recordings. A
recording is included only when the bucket contains both `<base>.sigmf-data` and
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

3. Run the tests and deploy:

   ```bash
   npm test
   npm run deploy
   ```

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

## Upload the metadata sidecars

This repository historically put recording data in R2 but served the small
metadata sidecars from Pages. The indexer intentionally requires both objects
to be present in R2. Preview the repository's metadata upload with:

```bash
npm run upload-meta
```

After checking the bucket and keys shown in the preview, upload them and invoke
the manual rebuild:

```bash
npm run upload-meta -- --apply

curl --fail-with-body -X POST \
  -H "Authorization: Bearer $REBUILD_TOKEN" \
  https://gnuradio-world-sigmf-indexer.<account-subdomain>.workers.dev/rebuild
```

The uploader validates every sidecar before making remote changes, preserves
collection prefixes in object keys, uploads four objects at a time, and is safe
to rerun because R2 replaces metadata objects under the same keys. Use
`--bucket <name>` if the target differs from `gnuradio-wasm-recordings`.

For a local scheduled-trigger check, run:

```bash
npm run dev
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+*"
```
