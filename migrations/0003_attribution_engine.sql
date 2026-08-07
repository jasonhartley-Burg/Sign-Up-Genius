CREATE TABLE IF NOT EXISTS contact_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  parent_name TEXT,
  student_name TEXT,
  program TEXT NOT NULL,
  source_tab TEXT,
  source_type TEXT NOT NULL DEFAULT 'program_roster',
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contact_email ON contact_mappings(email);
CREATE INDEX IF NOT EXISTS idx_contact_program ON contact_mappings(program);
CREATE TABLE IF NOT EXISTS contact_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_time TEXT NOT NULL,
  records INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  message TEXT
);
