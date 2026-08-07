# Volunteer Dashboard v0.2.1

Cloudflare Worker + static dashboard + D1 foundation with SignUpGenius synchronization.

## Deploy
1. Replace the GitHub repository contents with this ZIP.
2. Commit and push.
3. Cloudflare should build with `npm install` and `npm run build`.
4. Open the Worker and click **Sync SignUpGenius**. The Worker creates the required D1 tables automatically on first request.

## Cloudflare settings
Existing settings are expected:
- D1 binding: `DB` -> `volunteer-dashboard`
- Secret: `SIGNUPGENIUS_API_KEY`
- Variable: `SIGNUPGENIUS_API_BASE=https://api.signupgenius.com/v2/k/`
- Variable: `APP_NAME=Volunteer Dashboard`
- Variable: `APP_ENV=production`
- Variable: `SYNC_INTERVAL_MINUTES=15`

The API key is server-side only.


## v0.2.2 deployment note
The Wrangler configuration includes the existing plaintext variables, preventing the remote-configuration warning seen during deployment. The Worker also initializes the D1 schema automatically so the GitHub → Cloudflare workflow does not require a separate CLI migration step.


### v0.2.3 data correction
This release calculates volunteer hours from SignUpGenius start/end times when the API does not provide an explicit hours field, and combines the filled and available reports so total required hours can include open slots.


### v0.2.4 data-sync fix
Corrects the D1 `volunteer_slots` INSERT statement so the first live sync can write imported slots successfully.
