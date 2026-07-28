For now I'm using Cloudflare's R2 which has a free tier that lets you host up to 10 GB of files

Currently it's only the .sigmf-data file that gets uploaded, the .sigmf-meta file needs to be in the repo, for now

Public access enabled at https://pub-8660d644b79248808cbeb122f5992820.r2.dev

Note that if you're running the app locally, eg for development, it will just look for local SigMF recordings in the `/example_recordings` directory.

# Upload a new recording

```
npx wrangler r2 object put \
  gnuradio-wasm-recordings/cellular_downlink_880MHz.sigmf-data --remote \
  --file example_recordings/cellular_downlink_880MHz.sigmf-data \
  --content-type application/octet-stream
```


# Things I only had to do once

```
npx wrangler login
npx wrangler r2 bucket create gnuradio-wasm-recordings
npx wrangler r2 bucket dev-url enable gnuradio-wasm-recordings
npx wrangler r2 bucket cors set gnuradio-wasm-recordings --file scripts/r2-cors.json
```

Also I set the GitHub variable (not secret!) RECORDINGS_R2_BASE to the value from the command above
