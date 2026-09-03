export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SIGNUPGENIUS_API_KEY: string;
  SIGNUPGENIUS_API_BASE?: string;
  APP_NAME?: string;
  APP_ENV?: string;
  SYNC_INTERVAL_MINUTES?: string;
  PROGRAM_CONTACTS_SHEET_ID?: string;
  ADMIN_TOKEN?: string;
  SYNC_ADMIN_TOKEN?: string;
  /** Edge cache lifetime for the public dashboard, in seconds. "0" disables caching. */
  DASHBOARD_CACHE_SECONDS?: string;
  /** Public origin, e.g. https://volunteers.example.org — lets the cron purge the cached dashboard. */
  PUBLIC_ORIGIN?: string;
}
