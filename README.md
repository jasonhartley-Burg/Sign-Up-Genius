# Miamisburg Band & Guard Boosters Volunteer Dashboard — v0.5.0

v0.5.0 separates the application into a public impact scoreboard and an authenticated administrative console while preserving the v0.4.x attribution engine.

## Public scoreboard

The public site is the Worker root (`/`). It exposes only organization/program-level data and date filtering. Participant email addresses, unmatched records, affiliation tools, sync controls, and volunteer-level detail are not returned by the public dashboard API.

The Start Date defaults dynamically to July 1 of the current program year. Leaving End Date blank means through today.

Program leaderboard rows and gap cards have public aggregate drill-downs. They show credited hours, share of work, participation rate, volunteer equivalents, and the hours needed to catch the next-ranked program. They never show participant contact information.

## Administrative console

Open `/admin`. The console requires a bearer token. Configure either `ADMIN_TOKEN` (preferred) or the existing `SYNC_ADMIN_TOKEN` as a Worker secret. Example:

```bash
npx wrangler secret put ADMIN_TOKEN
```

The admin console includes:

- SignUpGenius and contact synchronization controls.
- Volunteer-level hours and email detail.
- Manual unmatched-program assignment.
- Effective-dated affiliation changes that preserve historical attribution.
- Manual volunteer-hours entry for service performed outside SignUpGenius.
- Deletion of manual hour entries.
- Data-health/status information.

Manual entries require the volunteer's email so existing roster/override/effective-dated attribution can be applied. If the email is not known to the roster, the manual service appears in Unmatched and can be assigned from the Admin Console.

Manual volunteer hours count toward volunteer/program impact, but they do **not** create fake SignUpGenius volunteer opportunities or inflate the Volunteer Need Coverage denominator.

## Privacy design

The public `/api/dashboard` endpoint omits volunteer arrays, unmatched records, settings, and all participant email/name detail. Administrative data is available only from authenticated endpoints such as `/api/admin/dashboard`.

## Deployment

The deployable static assets are already in `dist/`; no frontend build step is required for this package.

```bash
npx wrangler deploy
```

The existing D1 binding and 15-minute cron remain unchanged.
