# Changelog

## v0.4.3
- Fixed Start-only date filters: a blank End date now resolves to today instead of including future signups.
- Volunteer Hours detail, program allocations, unmatched review, event totals, and scoreboard metrics use the same bounded assignment-date filter.
- Added effective-dated volunteer program affiliations.
- Historical volunteer assignments retain the affiliation active on the assignment date.
- Admins can change a volunteer's programs with an effective date directly from Volunteer Hours.
- Added affiliation history display and D1 migration `0005_effective_dated_affiliations.sql`.
- Program-hour allocations in Volunteer Hours are calculated from assignment-level dated affiliations rather than dividing a volunteer's aggregate hours by their current program count.
