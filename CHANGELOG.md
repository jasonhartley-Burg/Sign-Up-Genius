# Changelog

## v0.3.0 — 2026-08-08
- Embedded the normalized 2026–2027 parent roster as the authoritative program mapping.
- Batched D1 contact writes to avoid Cloudflare Worker subrequest-limit failures.
- Multi-program volunteers now split hours proportionally across represented programs.
- Added start-date/end-date filtering across KPIs, program attribution, events, volunteers, and unmatched review.
- Added v0.3.0 health metadata for easier deployment verification.

## v0.2.9 — normalized roster + split program credit
- Uses the uploaded 2026–2027 normalized parent contacts as the authoritative program roster.
- Automatically splits each volunteer's hours evenly across every program they represent.
- Multi-program volunteers are no longer treated as unresolved or excluded from program totals.
- The unmatched review contains only volunteers with no roster email match.
- Reworked the main dashboard columns so Volunteer Hours sits directly beneath Program Participation instead of leaving a large blank area.
- Updated roster/status wording throughout the UI.


## v0.2.8
- Added Program Contacts attribution engine.
- Automatically normalizes A Guard, Elementary Fall Guard, Fall Guard, Marching Band, and World roster tabs from the configured Google Sheet.
- Known Table is supplemental only and is not treated as a complete source of truth.
- Added case-insensitive email matching from SignUpGenius volunteers to roster contacts.
- Added program participation totals for unambiguous matches.
- Added Multiple Programs and Unmatched review queues; ambiguous hours are not guessed.
- Added contact-sync coverage KPIs and a manual Sync Contacts action.
- Scheduled/Sync All refreshes both SignUpGenius and contact attribution.

## v0.2.7
- Correct SignUpGenius timestamp-based hour calculations and Time TBD handling.
