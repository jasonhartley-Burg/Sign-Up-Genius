## 0.5.2 - D1 write optimization
- Replaced full volunteer-slot delete/reinsert syncs with incremental inserts, updates, and stale-row deletes.
- Replaced full contact-mapping rebuilds with incremental comparison and writes only when mappings change.
- Event rows now update only when source event data changes.
- Sync logs now report actual D1 changes versus unchanged rows.
- Keeps the existing 15-minute schedule while dramatically reducing unnecessary D1 writes.

# Changelog

## v0.5.1
- Added defensive date parsing across the public and administrative UI.
- Date-only values, ISO timestamps, blank values, and malformed timestamps no longer crash rendering.
- Invalid or missing dates display as an em dash.
- Last-sync timestamps now use the same safe formatter.
- Preserves all v0.5.0 public/admin separation, manual hours, effective-dated affiliations, privacy, drill-downs, and date filtering.
