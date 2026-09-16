CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'approving', 'approved', 'rejected', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  capability_hash TEXT NOT NULL,
  public_notes TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_handle TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER,
  reviewer_email TEXT,
  review_reason TEXT,
  triage_cleaned_at INTEGER
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  base_name TEXT NOT NULL,
  data_key TEXT NOT NULL UNIQUE,
  meta_key TEXT NOT NULL UNIQUE,
  data_size INTEGER NOT NULL,
  meta_size INTEGER NOT NULL,
  data_upload_id TEXT NOT NULL,
  data_complete INTEGER NOT NULL DEFAULT 0,
  meta_complete INTEGER NOT NULL DEFAULT 0,
  datatype TEXT,
  sample_rate REAL,
  title TEXT,
  author TEXT,
  description TEXT,
  frequency REAL,
  production_key TEXT,
  UNIQUE (submission_id, base_name)
);

CREATE INDEX submissions_status_created ON submissions(status, created_at DESC);
CREATE INDEX recordings_submission ON recordings(submission_id);

CREATE TABLE review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  reviewer_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  reason TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX review_events_submission ON review_events(submission_id, created_at DESC);
