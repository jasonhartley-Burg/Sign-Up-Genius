# Migrations

`0001`–`0006` are the original schema history and are still applied by
`npm run db:migrate:remote` on a fresh database.

The v0.6.0 columns (`start_epoch`, `slot_day`, `source`, `content_hash`), the new
indexes and the one-time backfill are **not** shipped as `0007_*.sql` on purpose.

An existing production database has already had some of those `ALTER TABLE`
statements applied at runtime by the old `ensureColumns()` helper, and SQLite has
no `ADD COLUMN IF NOT EXISTS`. A migration file would therefore fail partway
through on an already-patched database and leave `d1_migrations` in a broken
state.

Instead, `worker/schema.ts` applies them idempotently, guarded by
`settings.schema_version`. It runs once per database, then costs a single
indexed one-row read per Worker isolate. You can re-run it deliberately with:

```
curl -X POST https://<your-worker>/api/admin/bootstrap \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
