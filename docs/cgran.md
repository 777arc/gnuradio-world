# The supported OOT catalog (`/cgran/`)

GNU Radio World publishes a CGRAN-like directory at `/cgran/`. It is deliberately
narrower than the historical CGRAN catalog: it lists only out-of-tree modules
with at least one runnable block in GNU Radio World. The static generator emits
the hub and one page per project, and Vite carries those pages into the deployed
site.

Read this document before adding or updating a catalog entry.

## Sources of truth

There are three, with separate jobs:

- `editor/public/blocks.json` decides membership. It is generated from block
  metadata; every distinct non-empty `oot_module` on a `runnable: true` block
  must have exactly one catalog entry. Do not maintain a parallel module list.
- `editor/content/cgran-projects.json` is committed editorial research. It holds
  the name, URL slug, canonical repository, one or two main authors, a three- or
  four-sentence summary, optional project artwork, and an audit trail of the
  source paths read.
- `editor/content/cgran-repository-snapshot.json` is committed repository
  activity data written by `scripts/refresh-cgran-metadata.mjs`.

The generated pages under `editor/public/cgran/` are ignored build output. Never
edit or commit them.

Unlike the editor and runner, `/cgran/` documents are not served with COOP/COEP
cross-origin isolation: they do not run threaded WebAssembly, and some official
project-site artwork does not publish CORP/CORS headers. Keep the exception in
`server.mjs` aligned with the `/cgran` rules written to the deployment's
`_headers` by `scripts/assemble-site.mjs`. The editor, runner, and recording view
must remain isolated.

## Adding an OOT

After completing the OOT build checklist in `adding-modules.md`:

1. Read the upstream repository itself: its README, docs, GRC block YAML,
   implementation, applications, and useful examples. Do not source the entry
   from `MANIFEST.yml` or `MANIFEST.md`.
2. Use `git shortlog -sne --all --no-merges` plus copyright/history evidence to
   identify one or two people who best represent the project's authorship.
   Commit count is evidence, not an automatic verdict: imported history,
   generated files, and maintainership changes can distort it.
3. Add one object to `editor/content/cgran-projects.json`. The `module` must
   exactly match `oot_module`; the URL `slug` may normalize underscores to
   hyphens. Record the revision reviewed and the relevant source paths in
   `evidence` so a later editor can audit or refresh the prose.
4. Write three or four sentences about the OOT itself. Explain the system it
   implements and, more importantly, how its processing blocks combine into
   useful functionality. It is fine to omit minor blocks. Do not describe what
   GNU Radio World's examples demonstrate, enumerate browser-supported blocks,
   state a supported-block count, add categories/tags, or discuss compatible GNU
   Radio versions.
5. Check the repository README and image assets, plus any project website it
   names, for a real logo or distinctive project-owned visual. If one exists,
   add `artwork` with descriptive alt text, a source URL, a display fit, and a
   precise label such as `Project-site logo`, `Repository artwork`, or
   `Project-site screenshot`. Prefer `source_path` for an image already in the
   checked-out OOT; the generator copies it into its ignored output. If an
   official remote image cannot be hotlinked reliably, keep the one-time snapshot
   under `editor/content/cgran-artwork/`. Use `remote_url` only for a stable
   official project-site/README asset that is not in the checkout. Do not
   substitute a maintainer avatar, a generic GNU Radio logo, or
   third-party protocol/vendor branding, and do not invent a logo merely to fill
   the space. Record every project without suitable artwork in the document-level
   `artwork_audit.no_suitable_artwork` list and update its audit date; this makes
   a completed audit distinguishable from an entry nobody checked.
6. Refresh activity for the new module:

   ```bash
   node scripts/refresh-cgran-metadata.mjs gr-example
   ```

7. Add and run an example flowgraph where practical. Follow
   `docs/flowgraph-files.md`; the catalog will associate every example containing
   any block whose `oot_module` matches this entry, including examples stored
   outside that OOT's directory and flowgraphs that use multiple OOTs.
8. Run `(cd editor && npm run check)`. The generator intentionally fails if the
   runnable OOT set and editorial entries differ, metadata is stale, summaries
   or authors violate the limits, or evidence names a MANIFEST file.

## Repository activity and the three-month label

Run this at least every three months:

```bash
node scripts/refresh-cgran-metadata.mjs
```

The script makes a temporary bare, blob-filtered clone of every canonical
repository and finds the newest commit reachable from any branch head. Tags do
not participate. It records the commit hash, committer timestamp, and check time,
then removes the clones. A partial run updates only named modules and preserves
the other snapshot entries.

The public page compares the commit timestamp with that check time. Activity
within 90 days is displayed only as `< 3 months`; the exact timestamp is omitted
from visible HTML, attributes, and structured data. Older activity is displayed
as an ISO date. Generation fails once the check itself is 90 days old, forcing a
refresh before the coarse label could become misleading.

## Page generation and example association

`editor/gen/gen_example_pages.mjs` parses every `.grc` using the editor's actual
parser and annotates each distinct block ID from `blocks.json`. It passes those
parsed examples to `gen_cgran_pages.mjs`, which selects a project whenever an
example row has the project's `oot_module`. That structural lookup is the only
example association mechanism; never add a hand-maintained list to the content
JSON.

The hub cards and project facts show the reviewed summary, main authors, and
last-modified label. They do not expose supported-block counts. Project pages
link every associated example page and use an explicit empty state if none
exists. The hub's final section tells upstream authors to email Marc at
`support@gnuradioworld.com` or join the GNU Radio World Discord to request
support and listing.
