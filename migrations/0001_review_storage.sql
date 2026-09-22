PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS annotators (
  annotator_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_states (
  annotator_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  text_len INTEGER NOT NULL,
  payload TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (annotator_id, doc_id),
  FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS review_states_updated_at
  ON review_states (annotator_id, updated_at DESC);
