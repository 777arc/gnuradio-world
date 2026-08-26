# Read-only D1 queries

Saved `SELECT`s for inspecting the credits service's database — the catalog the
editor offers, what each model earns, balances, and the two tables that show
something is wrong. Every file here is read-only by design.

Run one from `workers/saas/`, naming the database and passing the file's
contents as `--command`:

```bash
npx wrangler d1 execute gnuradio-world-saas-production -y --remote --command="$(cat queries/catalog.sql)"
```

**Do not use `--file` here.** With `--remote`, `d1 execute --file` goes through
D1's bulk *import* pipeline rather than the query endpoint: it prints how many
queries ran and how many rows were read, and throws the rows themselves away.
Only `--command` returns results. The `=` in `--command=` matters too — without
it, the leading `--` comment at the top of each file is parsed as flags.

| file | question it answers |
|------|--------------------|
| `catalog.sql` | which models the picker offers, and what a customer pays per million tokens |
| `rate-history.sql` | every rate version, current and closed, with its wholesale columns |
| `usage-by-model.sql` | requests, tokens, revenue, upstream cost, and margin per model |
| `absorbed-costs.sql` | upstream spend nobody was billed for, by model and reason |
| `wallets.sql` | balances, held funds, and what is actually available to spend |
| `active-holds.sql` | outstanding reservations, and whether the hold reaper is behind |
| `migrations.sql` | which migrations this database has applied |

## What is safe here, and what is not

**The queries are public; their results are not.** Nothing in these files is a
secret — they are `SELECT`s over a schema that `migrations/` already publishes,
and `catalog.sql` only repeats arithmetic that `src/pricing.ts` already
contains. What comes back is a different matter: wholesale rates and markup are
private service data, and `wallets.sql` returns customer email addresses.
Results belong in your terminal, not in an issue or a screenshot.

**Nothing here writes.** Opening a model, repricing one, adjusting a balance, or
correcting a ledger row are all deliberate one-off statements carrying real
rates or real money, so they are run by hand and kept out of the repository —
see section 4 of the parent README for how a rate version is opened and closed.
Adding a mutation to this directory would put private numbers in git and make a
destructive statement a copy-paste away.

**End every statement with a semicolon** if you add a file. `wrangler d1
migrations apply` concatenates its own bookkeeping `INSERT` onto the file it
runs, and a missing terminator merges the two into a syntax error; `d1 execute`
is more forgiving, but the habit costs nothing.
