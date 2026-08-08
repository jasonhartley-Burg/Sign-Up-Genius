CREATE TABLE IF NOT EXISTS volunteer_affiliation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  volunteer_name TEXT,
  program TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(email, program, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_email ON volunteer_affiliation_history(email);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_dates ON volunteer_affiliation_history(email,effective_from,effective_to);
CREATE INDEX IF NOT EXISTS idx_affiliation_history_program ON volunteer_affiliation_history(program);
