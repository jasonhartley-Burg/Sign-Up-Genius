# D1 nesting-depth repair

The dashboard previously used chained CTEs in `worker/db.ts`, with repeated expansion of `affiliation_rows`, `allocated`, and related expressions. The new dashboard implementation retrieves affiliations and filled slots with simple D1 queries, pages slots by integer ID, and calculates volunteer/program attribution in TypeScript. No schema changes or data deletion are required.

Deployment: replace the repository contents with this package and deploy the Worker. Do not run migrations for this change. Verify the dashboard and compare volunteer hours, program credits, and unmatched volunteers with a prior trusted report. The live D1 database was not available for testing.
