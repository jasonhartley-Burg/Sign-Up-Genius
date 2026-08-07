## 0.2.5
- Makes SignUpGenius slot parsing tolerant of nested report structures and alternate field names.
- Uses the available-slot report as the authoritative open/filled indicator when available.
- Calculates slot hours from direct hour fields or start/end times across common API field variants.
- Preserves volunteer name/email extraction for later family/program matching.

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

## 0.2.6 - 2026-08-07
- Added a read-only SignUpGenius diagnostic inspector.
- Added live inspection of all, available, and filled report endpoints for a selected event.
- Added detected nested field-path inventory and complete raw JSON display.
- Added D1 slot-accounting diagnostics (total, distinct IDs, zero-hour rows, and status counts).
- No changes to Cloudflare bindings, API secret handling, synchronization schedule, or program attribution.
