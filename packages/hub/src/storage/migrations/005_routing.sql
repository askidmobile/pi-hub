-- Stage 3: model history of a task, first-try PASS, router steps (plan phase 1).

-- Every model that worked on a task, in order: the first one from the role / architect /
-- System One, the next ones from escalation (spec FR-205, plan PD-205).
CREATE TABLE task_model_runs (
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  seq          INTEGER NOT NULL,
  model        TEXT NOT NULL,
  routed_by    TEXT NOT NULL CHECK (routed_by IN ('architect','rules','system_one','escalation')),
  reason       TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  quality      TEXT CHECK (quality IN ('PASS','FAIL','SKIPPED')),
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX task_model_runs_model_idx ON task_model_runs(model);

-- 1: the first model passed its first check (no auto round, escalation or send);
-- 0: it did not; NULL: not known yet, no check commands (SKIPPED, D-215) or a stage 1-2 task.
ALTER TABLE tasks ADD COLUMN first_try_pass INTEGER CHECK (first_try_pass IN (0, 1));

-- A worker step or a System One request (spec FR-222, plan PD-206).
ALTER TABLE steps ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'
  CHECK (kind IN ('worker', 'router'));

-- Past tasks get one run: the model they were started on.
INSERT INTO task_model_runs (task_id, seq, model, routed_by, reason, started_at, finished_at, quality)
SELECT id, 1, model, COALESCE(routed_by, 'rules'), route_reason,
       COALESCE(started_at, created_at), finished_at, quality_status
FROM tasks WHERE model IS NOT NULL;
