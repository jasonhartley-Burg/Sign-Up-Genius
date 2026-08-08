CREATE TABLE IF NOT EXISTS volunteer_program_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  volunteer_name TEXT,
  program TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(email, program)
);
CREATE INDEX IF NOT EXISTS idx_override_email ON volunteer_program_overrides(email);
CREATE INDEX IF NOT EXISTS idx_override_program ON volunteer_program_overrides(program);
