# Volunteer Dashboard v0.2.8

This build adds roster-based program attribution to the existing SignUpGenius hours engine.

## Program Contacts source
Default spreadsheet ID: `1bbRVZGY-gr6WFcgzayD8eQX22LuGGJIqWQqipF4PB90`

Optional Worker variable: `PROGRAM_CONTACTS_SHEET_ID`

The Worker reads these tabs as CSV: A Guard, Elementary Fall Guard, Fall Guard, Marching Band, World, and Known Table. The Google Sheet must be readable by the Worker (typically **Anyone with the link → Viewer**).

Known Table is supplemental only. The app primarily normalizes the actual program roster tabs.

## Attribution logic
- Volunteer matching key: normalized lowercase email.
- Exactly one roster program → attributed automatically.
- More than one roster program → Multiple Programs / review required.
- No roster email match → Unmatched / review required.
- Ambiguous hours are excluded from program percentages rather than guessed.

## Deploy
Existing D1 and SignUpGenius bindings/secrets are unchanged. `0003_attribution_engine.sql` is included, but the Worker also self-creates the new tables.

After deployment, click **Sync Contacts** (or **Sync All**) once and review Contact Match, Program Participation, and Needs Attribution Review.


## v0.3.0 notes
The dashboard uses the embedded normalized parent roster for attribution. Contact sync uses D1 batch writes. Date filters are sent to `/api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD` and apply to SignUpGenius assignment start timestamps.
