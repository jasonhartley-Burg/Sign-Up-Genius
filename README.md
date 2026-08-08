# Miamisburg Band & Guard Boosters Volunteer Impact Scoreboard v0.4.3

Cloudflare Worker + D1 volunteer dashboard using SignUpGenius data and the embedded normalized parent roster.

## v0.4.3 highlights
- Start date with blank End means Start through today; future commitments are excluded.
- Date-filtered Volunteer Hours detail uses the same range as the public scoreboard.
- Effective-dated volunteer affiliations preserve historical credit when family program relationships change.
- Use the **Affiliation** button beside a volunteer to choose programs and an effective date.
- Existing normalized-roster and manual unmatched assignment behavior remains available for volunteers without dated affiliation history.

Deploy with `npx wrangler deploy` from the project root. The Worker automatically creates the new affiliation-history table; migration 0005 is also included for explicit D1 migration workflows.
