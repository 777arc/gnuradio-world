For now I'm using Cloudflare's R2 which has a free tier that lets you host up to 10 GB of files

Currently it's only the .sigmf-data file that gets uploaded, the .sigmf-meta file needs to be in the repo, for now

Public access enabled at https://pub-8660d644b79248808cbeb122f5992820.r2.dev

Note that if you're running the app locally, eg for development, it will just look for local SigMF recordings in the `/example_recordings` directory.

# Sub-directories

A recording can sit in a sub-directory, which is how a whole collection is kept
together — `estevez/` is the 92 amateur-satellite recordings from
[daniestevez/satellite-recordings](https://github.com/daniestevez/satellite-recordings),
converted to SigMF (48 kHz mono audio as `ri16_le`, plus one 192 kHz IQ
recording as `ci16_le`).

`server.mjs` and `scripts/assemble-site.mjs` both walk the directory
recursively, and a recording's name is then its path relative to
`example_recordings/` (`estevez/ao73`), which is also its R2 object key and the
path in every URL. Nothing else changes: the `.sigmf-meta` is committed, the
`.sigmf-data` is git-ignored and comes from R2 on the deployed site.

# Upload a new recording

```
npx wrangler r2 object put \
  gnuradio-wasm-recordings/cellular_downlink_880MHz.sigmf-data --remote \
  --file example_recordings/cellular_downlink_880MHz.sigmf-data \
  --content-type application/octet-stream
```

A whole collection at once (the object key has to keep the sub-directory, since
that is the path the manifest builds its URLs from):

```
for f in example_recordings/estevez/*.sigmf-data; do
  npx wrangler r2 object put "gnuradio-wasm-recordings/${f#example_recordings/}" \
    --remote --file "$f" --content-type application/octet-stream
done
```


# Things I only had to do once

```
npx wrangler login
npx wrangler r2 bucket create gnuradio-wasm-recordings
npx wrangler r2 bucket dev-url enable gnuradio-wasm-recordings
npx wrangler r2 bucket cors set gnuradio-wasm-recordings --file scripts/r2-cors.json
```

Also I set the GitHub variable (not secret!) RECORDINGS_R2_BASE to the value from the command above
