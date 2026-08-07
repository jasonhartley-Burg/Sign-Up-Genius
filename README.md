# Volunteer Dashboard v0.2.0

Cloudflare Worker + React/Vite + D1 foundation with SignUpGenius synchronization.

## Deploy
1. Replace the GitHub repository contents with this ZIP.
2. Commit and push.
3. Cloudflare should build with `npm install` and `npm run build`.
4. Apply the D1 migration once with `npx wrangler d1 migrations apply volunteer-dashboard --remote`.
5. Open the Worker and click **Sync SignUpGenius**.

## Cloudflare settings
Existing settings are expected:
- D1 binding: `DB` -> `volunteer-dashboard`
- Secret: `SIGNUPGENIUS_API_KEY`
- Variable: `SIGNUPGENIUS_API_BASE=https://api.signupgenius.com/v2/k/`
- Variable: `APP_NAME=Volunteer Dashboard`
- Variable: `APP_ENV=production`
- Variable: `SYNC_INTERVAL_MINUTES=15`

The API key is server-side only.
