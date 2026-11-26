-- Stage 1 task fields (plan phase 1).
ALTER TABLE tasks ADD COLUMN task_text TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
ALTER TABLE tasks ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN assumptions_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN failure_reason TEXT;
ALTER TABLE tasks ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN started_at TEXT;
CREATE INDEX tasks_status_idx ON tasks(status, created_at);
