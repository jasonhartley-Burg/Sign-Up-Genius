ALTER TABLE volunteer_slots ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE volunteer_slots ADD COLUMN hours_known INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')));
INSERT OR IGNORE INTO settings(key,value) VALUES('estimate_untimed_enabled','0'),('estimate_untimed_hours','6');
