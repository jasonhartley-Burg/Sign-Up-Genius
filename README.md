# Miamisburg Band & Guard Boosters Volunteer Impact Scoreboard v0.4.2

Public-facing volunteer impact scoreboard backed by SignUpGenius, Cloudflare Workers/D1, the embedded normalized roster, and persistent manual attribution overrides.

## Attribution model
Every event is an organization-wide Booster opportunity. Events are not assigned to individual programs. Volunteer credit follows the program(s) represented by the volunteer. Multi-program volunteers split credited hours proportionally across those programs.

## Scoreboards
- Total Impact: credited volunteer hours by program.
- Participation Strength: fractional participating caregiver equivalents divided by fractional eligible caregiver equivalents.
- Organization Coverage Contribution: each program's credited known hours as a share of all known filled volunteer hours.
- Volunteer Need Coverage: filled volunteer demand compared with available demand.

## Date filtering
The Start and End date filter is applied server-side using each SignUpGenius assignment start time. It updates KPI totals, events, program standings, participation metrics, unmatched volunteers, and Volunteer Hours detail. This allows individual volunteer totals to be validated for a selected period.
