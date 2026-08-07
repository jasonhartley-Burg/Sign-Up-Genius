## 0.2.4
- Fixes the D1 volunteer slot INSERT placeholder count (11 columns / 11 values).

## 0.2.3
- Calculates slot hours from explicit duration fields or start/end times.
- Imports both filled and available SignUpGenius report data.
- Distinguishes open versus filled slots more reliably.
- Keeps the existing GitHub → Cloudflare deployment workflow.

# Changelog

## 0.2.1
- Includes a prebuilt `dist/` directory so Cloudflare can deploy with `npx wrangler deploy` without a separate frontend build command.
- Static dashboard calls the Worker API directly.

## 0.2.0
- Cloudflare Worker API.
- React/Vite dashboard source.
- D1 migration.
- SignUpGenius synchronization foundation.
- 15-minute scheduled sync.
