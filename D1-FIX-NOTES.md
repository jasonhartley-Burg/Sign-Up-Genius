# D1 dashboard query depth fix

Changed `worker/db.ts`: 22 CTE declarations now use `AS MATERIALIZED` to avoid repeated CTE inlining and excessive SQLite subquery nesting.

No data modifications, migrations, or credential changes. Deploy using the repository's normal Cloudflare Workers deployment workflow.

Validation: Check the dashboard, volunteer totals, program attribution, and date filters after deployment. This patch has not been tested against your production D1 database.
