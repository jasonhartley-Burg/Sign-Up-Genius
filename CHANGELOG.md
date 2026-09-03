# Changelog

## v0.6.2 — sync cadence

- Cron moved to `0 11-23/3 * * *`: every 3 hours between 7am and 7pm Eastern,
  5 runs/day. Overnight runs dropped entirely. Down from 96 runs/day on the
  original `*/15` schedule.
- `DASHBOARD_CACHE_SECONDS` raised from 600 to 1800. With syncs 3 hours apart a
  30-minute edge cache is never staler than the data behind it, and it cuts
  uncached dashboard reads by roughly a further 3x.
- `SYNC_INTERVAL_MINUTES` display value updated to match.
- No schema change; `SCHEMA_VERSION` stays at 0.6.1.

## v0.6.1 — index write amplification

- D1 bills one row written per index entry touched in addition to the table row,
  so index count is a direct multiplier on sync cost. Trimmed `volunteer_slots`
  to `idx_slots_event`, `idx_slots_email_lower` and `idx_slots_status_epoch`
  plus its implicit UNIQUE index — one fewer than v0.5.2 carried.
- Schema bootstrap now runs `DROP INDEX IF EXISTS` for indexes nothing queries:
  `idx_slots_signupgenius_slot_id` (exactly duplicated the UNIQUE constraint's
  index), `idx_slots_email`, `idx_contact_email`, `idx_override_email` and
  `idx_affiliation_history_email` (all superseded by `LOWER(email)` equivalents).
- Documented the one-time backfill write cost and advised deploying just after
  the `00:00 UTC` daily reset.

## v0.6.0 — D1 quota fixes

Read path:
- Added indexed `start_epoch`, `slot_day` and `source` columns to
  `volunteer_slots`, backfilled once from `raw_json`. All dashboard `WHERE`
  clauses now compare indexed columns instead of `json_extract(raw_json, ...)`,
  which could not use an index and forced a full scan plus a JSON parse of the
  whole table on every sub-query.
- Added `LOWER(email)` expression indexes on `volunteer_slots`,
  `contact_mappings`, `volunteer_program_overrides` and
  `volunteer_affiliation_history`, plus composite `(status, start_epoch)` and
  `(source, start_epoch)` indexes.
- `/api/dashboard` responses are cached in the Workers Cache API for
  `DASHBOARD_CACHE_SECONDS` (default 600). Cache hits do no D1 work. Admin
  mutations and the cron purge the cached copy. `/api/admin/dashboard` is never
  cached.
- Folded the two sync-log lookups into one query and the three
  contact/override/history count queries into one.
- `/api/admin/manual-hours` filters on the indexed `source` column instead of
  `signupgenius_slot_id LIKE 'manual:%'`.
- `/api/health` no longer touches the database.

Write path:
- Sync change-detection now hashes only the fields that are persisted. Volatile
  fields in the SignUpGenius payload no longer make every row look changed and
  trigger a full table rewrite each cycle.
- Stored `raw_json` reduced to `{"startdate":…,"source":…}` on both slots and
  events — the only keys anything downstream reads.
- The compare pass selects only the slot id and content hash instead of every
  stored blob.
- The compiled-in roster sync is gated on a hash of the roster held in
  `settings.roster_hash`, so it is skipped entirely unless the roster changed.
  The "Sync Contacts" button still forces a full run.
- `sync_log` and `contact_sync_log` are pruned to the most recent 200 rows.
- Several sequential `.run()` calls converted to `batch()`.

Schema and configuration:
- Schema bootstrap moved to `worker/schema.ts`, guarded by
  `settings.schema_version`. It costs one indexed single-row read per isolate
  instead of ~27 statements on every cold start, and applies its DDL in batches.
- Added `POST /api/admin/bootstrap` to re-apply schema, indexes and backfill.
- Cron moved from `*/15 * * * *` (96 runs/day) to `0 * * * *` (24 runs/day).
- `preview_urls` disabled — preview deployments share the production D1 database
  and were spending the same daily quota.
- `observability` enabled.

No API response shapes changed; the frontend in `dist/` is untouched.

## 0.5.2 - D1 write optimization
- Replaced full volunteer-slot delete/reinsert syncs with incremental inserts, updates, and stale-row deletes.
- Replaced full contact-mapping rebuilds with incremental comparison and writes only when mappings change.
- Event rows now update only when source event data changes.
- Sync logs now report actual D1 changes versus unchanged rows.
- Keeps the existing 15-minute schedule while dramatically reducing unnecessary D1 writes.

## v0.5.1
- Added defensive date parsing across the public and administrative UI.
- Date-only values, ISO timestamps, blank values, and malformed timestamps no longer crash rendering.
- Invalid or missing dates display as an em dash.
- Last-sync timestamps now use the same safe formatter.
- Preserves all v0.5.0 public/admin separation, manual hours, effective-dated affiliations, privacy, drill-downs, and date filtering.
