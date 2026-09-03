# Sign-Up-Genius Volunteer Dashboard v0.6.2

Cloudflare Worker + D1 volunteer-hours scoreboard for the Miamisburg Band & Guard
Boosters, synced from SignUpGenius.

Public scoreboard: `/`
Admin console: `/admin`

The admin console authenticates with the `ADMIN_TOKEN` secret (`SYNC_ADMIN_TOKEN`
is still accepted as a fallback).

## v0.6.0 — D1 quota fixes

This release exists to stop the Worker exhausting its D1 daily allowance. The
full analysis is in **[D1-USAGE.md](./D1-USAGE.md)**; briefly:

- Slot start time, slot day and manual/SignUpGenius source are now indexed
  columns instead of `json_extract()` calls, which had forced a full scan and a
  JSON parse of the entire slot table roughly ten times per dashboard load.
- The public dashboard is cached at the edge; a cache hit costs no D1 reads.
- Sync change-detection uses a content hash of the persisted fields, so volatile
  fields in the SignUpGenius payload no longer trigger a full table rewrite every
  cycle.
- Schema bootstrap costs one indexed row read per isolate rather than 27
  statements per cold start.
- The compiled-in roster sync is skipped unless the roster itself changed.
- Cron moved from every 15 minutes (96 runs/day) to every 3 hours during
  waking hours (5 runs/day); `preview_urls` turned off.

## Deploy

```bash
npm install

# Fresh database only. An existing database is upgraded automatically by the
# runtime schema guard — see migrations/README.md.
npm run db:migrate:remote

npm run deploy
```

Secrets:

```bash
npx wrangler secret put SIGNUPGENIUS_API_KEY
npx wrangler secret put ADMIN_TOKEN
```

After the first deploy, set `PUBLIC_ORIGIN` in `wrangler.jsonc` to your live
hostname so the hourly cron can purge the cached dashboard, then redeploy.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_CACHE_SECONDS` | `1800` | Edge cache lifetime for `/api/dashboard`. `0` disables caching. Raise it to cut D1 reads further. |
| `PUBLIC_ORIGIN` | `""` | Live origin, so the cron can purge the cached dashboard after a sync. |
| `SIGNUPGENIUS_API_BASE` | SignUpGenius v2 | API base URL. |
| `triggers.crons` | `0 11-23/3 * * *` | Sync cadence: every 3 hours, 7am-7pm Eastern (5 runs/day). See the comments in `wrangler.jsonc` for slower options. |

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | none | No database access. |
| GET | `/api/dashboard` | none | Cached. No names or emails. |
| GET | `/api/admin/dashboard` | admin | Never cached. |
| POST | `/api/sync` | admin | `?contacts=force` also forces a roster sync. |
| POST | `/api/contacts/sync` | admin | Always forces a roster sync. |
| POST | `/api/admin/bootstrap` | admin | Re-applies schema, indexes and backfill. |
| GET/POST/DELETE | `/api/admin/manual-hours` | admin | |
| GET/POST | `/api/settings` | admin | |
| GET/POST | `/api/affiliations/*` | admin | |
| POST | `/api/attribution/override` | admin | |

## Monitoring D1 spend

```bash
npx wrangler d1 insights volunteer-dashboard --timePeriod=7d --sort-by=reads
npx wrangler d1 insights volunteer-dashboard --timePeriod=7d --sort-by=writes
npx wrangler tail
```

## Note on `src/` vs `dist/`

`dist/app.js` is the deployed, hand-maintained frontend and is what
`wrangler deploy` publishes. `src/App.tsx` is an older Vite source tree that has
drifted out of sync with it and is **not** part of the build (`npm run build` is
a no-op). Nothing in this release changes the API response shape, so the frontend
is untouched — but be aware of the drift before editing `src/`.
