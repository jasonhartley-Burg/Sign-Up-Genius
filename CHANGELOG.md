# Changelog

## v0.2.7 — deterministic hours engine

- Replaced guessed hour parsing with the observed SignUpGenius report fields.
- Calculates duration from `startdate` and `enddate` Unix timestamps.
- Treats rows without an end timestamp as **Time TBD**, not zero-hour work.
- Uses `myqty` so multi-position open/filled rows are counted correctly.
- Uses `itemmemberid` for filled signup row identity and `slotitemid` for open-row identity.
- Detects volunteers from `firstname`, `lastname`, and `email`.
- Adds optional, configurable planning estimates for untimed/TBA positions (default 6 hours, disabled by default).
- Adds volunteer known-hour totals and separate TBD assignment counts.
- Removes the v0.2.6 raw diagnostic inspector.
- Leaves program attribution intentionally unassigned until the D1 family/program reference workflow is built.
