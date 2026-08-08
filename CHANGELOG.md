# Changelog

## v0.5.0

- Split the application into a public read-only scoreboard (`/`) and protected admin console (`/admin`).
- Public dashboard API no longer returns participant names/emails, unmatched data, or administrative records.
- Added bearer-token admin authentication using `ADMIN_TOKEN`, with compatibility for `SYNC_ADMIN_TOKEN`.
- Added manual volunteer-hours entry and deletion for service performed outside SignUpGenius.
- Manual service uses the same effective-dated program attribution engine as synchronized service.
- Manual hours contribute to impact/program totals without inflating SignUpGenius need-coverage calculations.
- Added dynamic July 1 program-year default Start Date.
- Blank End Date continues to mean through today.
- Added clickable public program drill-downs using aggregate-only data.
- Preserved manual overrides, effective-dated affiliation history, proportional multi-program allocation, date filtering, normalized roster, and 15-minute synchronization.
