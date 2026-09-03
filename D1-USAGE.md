# Why the D1 daily limit was being hit, and what changed in v0.6.x

D1's free tier allows roughly **5,000,000 rows read** and **100,000 rows written**
per day.

Cloudflare's alert identifies the limit being hit as **`rows_written`** — 86% of
100,000 in a day. So sections 3 and 6 below are the ones doing the damage; the
read-path work in sections 1 and 2 is real but is headroom, not the fix.

**A detail that matters for writes:** D1 bills one row written for the table row
*plus one for every index entry the write touches*. A table with four indexes
costs roughly five writes per changed row. Index count is therefore a direct
multiplier on the sync's cost, which is why v0.6.1 trims `volunteer_slots` back
to three indexes plus its implicit UNIQUE index — one fewer than v0.5.2 carried.

---

## 1. Every dashboard load scanned and JSON-parsed the whole slot table, ten times over

`worker/db.ts` derived three values inside its `WHERE` clauses using
`json_extract(v.raw_json, ...)`:

- the slot start time (`$.startdate`)
- the slot day (`date(json_extract(...), 'unixepoch')`)
- whether a row was manual or from SignUpGenius (`$.source`)

An expression like that can never use an index, so SQLite had to read every row
of `volunteer_slots` and parse its JSON blob. `dashboard()` issues about a dozen
queries and several of them do this two or three times inside CTEs, so **one page
view cost roughly ten full passes over the table**. With a few thousand slots
that is tens of thousands of rows read per visitor, and the read limit is
reachable in a couple of hundred page views.

**Fixed by** promoting those three values to real indexed columns —
`start_epoch`, `slot_day`, `source` — written at sync time and backfilled once
from the existing `raw_json`. Every `WHERE` clause in `db.ts` now compares plain
columns.

## 2. The public dashboard had no caching at all

Each request re-ran the full query set. A station display, a shared link in a
parent Facebook group, or an uptime monitor could exhaust the daily reads on its
own.

**Fixed by** caching `/api/dashboard` responses in the Workers Cache API
(`DASHBOARD_CACHE_SECONDS`, default 600). A cache hit returns without touching D1
at all. `/api/admin/dashboard` is never cached, since it carries volunteer names
and emails. Admin mutations and the cron purge the cached copy.

## 3. `raw_json` comparison caused a full table rewrite on most syncs

The incremental sync in v0.5.x compared the whole stored `raw_json` against the
whole fresh API payload. SignUpGenius report rows include volatile fields —
counters, server timestamps, ordering keys — so a byte would change on nearly
every row on nearly every run. The sync then dutifully wrote back every row it
thought had changed.

At 96 cron runs a day, a few thousand slots is a few hundred thousand writes:
past the 100,000 write limit by itself.

**Fixed by**
- computing a hash over only the fields actually persisted, and updating a row
  only when that hash differs;
- shrinking stored `raw_json` to `{"startdate":…,"source":…}` — the only two keys
  anything downstream ever read — so rows are small and stable;
- doing the same for `events.raw_json`, which had the same problem.

The compare pass also now selects only the slot id and hash instead of dragging
every stored blob back across the wire.

## 4. Schema bootstrap ran on every cold isolate, before every request

`ensureSchema()` executed ~25 `CREATE TABLE` / `CREATE INDEX` / `INSERT OR IGNORE`
statements plus two `PRAGMA table_info` calls. It was memoised in a module-level
variable, which only lasts as long as a single Worker isolate — and isolates are
recycled constantly. Every cold start therefore paid 27 D1 round trips before the
real query even began.

**Fixed by** `worker/schema.ts`, which reads a single indexed row
(`settings.schema_version`) and returns immediately when the schema is current.
The DDL runs once per database, and is batched when it does run.

## 5. The roster sync re-ran every 15 minutes for data that can only change on deploy

`NORMALIZED_ROSTER` is compiled into the Worker bundle. It cannot change without
a redeploy. Yet every cron read all ~370 `contact_mappings` rows, ran two
whole-table aggregates, and wrote a log row.

**Fixed by** hashing the compiled roster and storing that hash in
`settings.roster_hash`. When it matches, `syncContacts()` returns after one
indexed single-row read. The "Sync Contacts" button still forces a full run.

---

## 6. Index write amplification

`volunteer_slots` carried `idx_slots_event`, `idx_slots_email`,
`idx_slots_signupgenius_slot_id` and the implicit UNIQUE index on
`signupgenius_slot_id` — so every rewritten row cost about five writes, not one.
Two of those indexes were dead weight: `idx_slots_signupgenius_slot_id`
duplicated the UNIQUE constraint's own index exactly, and `idx_slots_email` was
never used because every query lowercases the address.

**Fixed by** dropping the redundant indexes (`DROP INDEX IF EXISTS`, run as part
of the schema bootstrap) and keeping only `idx_slots_event`,
`idx_slots_email_lower` and `idx_slots_status_epoch`. Same three equivalents on
the contact/override/affiliation tables. Net effect: one fewer index on the hot
write path than before, while the read path gets better coverage.

---

## Smaller changes

- **Cron cadence** `*/15` → `0 11-23/3 * * *` (96 → 5 runs/day): every 3 hours
  between 7am and 7pm Eastern, with overnight runs dropped. This is a ~19x
  reduction in scheduled work on its own, and it compounds with the change
  detection in section 3 — fewer runs, and each run writing far less.
- **`preview_urls` turned off.** Preview deployments bind to the *same*
  production D1 database, so traffic to a preview URL spent the same daily quota.
- **`sync_log` / `contact_sync_log` are pruned** to the most recent 200 rows,
  occasionally, instead of growing forever.
- **Round trips consolidated.** The two "last sync" lookups became one query; the
  three contact/override/history count queries became one; several sequential
  `.run()` calls became `batch()` calls.
- **`/api/admin/manual-hours`** filters on the indexed `source` column instead of
  `signupgenius_slot_id LIKE 'manual:%'`, which forced a full scan.
- **`/api/health` no longer touches D1**, so uptime monitors are free.
- **`observability` enabled** in `wrangler.jsonc`.

---

## Expected effect

Reads drop by roughly an order of magnitude from the indexed columns alone, and
again from caching. Writes drop to near zero on syncs where SignUpGenius data has
not actually changed.

## Watching it

```
npx wrangler d1 insights volunteer-dashboard --timePeriod=7d --sort-by=reads
npx wrangler d1 insights volunteer-dashboard --timePeriod=7d --sort-by=writes
```

That ranks actual queries by cost, so if something still stands out you will see
which statement it is.

## One-time cost on first deploy — deploy after the daily reset

The backfill updates every existing slot row (`start_epoch`, `slot_day`,
`source`), and the first sync afterwards rewrites each row once more to populate
`content_hash`. Counting index entries, that is roughly **3-4 writes per slot,
once**.

If the account is already at 86% of its daily writes, that one-time cost can push
it over. **Deploy just after `00:00 UTC`, when the counter resets** (8:00 PM
Eastern during daylight time), so the migration lands on a fresh daily budget.

If you would rather not wait, deploy in two steps:

1. Set `"triggers": { "crons": [] }` in `wrangler.jsonc` and deploy. That stops
   the write source immediately while leaving the dashboard live.
2. After the next reset, restore the cron and deploy again.

Subsequent syncs settle to writing only genuine changes.

## If you are still near the limit

In order of effectiveness:

For writes, in order of effectiveness:

1. Slow the cron further — `0 12,21 * * *` is twice a day and still fine for a
   scoreboard. The admin "Sync All" button covers the case where you need fresh
   numbers right before an event.
2. Check `wrangler d1 insights ... --sort-by=writes`. If `volunteer_slots`
   updates are still high after this release, SignUpGenius is genuinely changing
   those fields — inspect a sync log message, which reports inserted / updated /
   deleted / unchanged counts, to see how many rows really move per run.
3. Resist adding indexes to `volunteer_slots`. Each one is a permanent tax on
   every sync.

For reads:

1. Raise `DASHBOARD_CACHE_SECONDS` (1800 is fine for a scoreboard).
2. Delete slot rows older than the current season — the dashboard defaults to
   all dates, so old rows are scanned on every uncached query.

The Workers Paid plan at $5/month raises this to 50 million writes and 25 billion
reads per month, which for this workload is effectively unlimited. Worth weighing
against further tuning if the free tier stays tight.
