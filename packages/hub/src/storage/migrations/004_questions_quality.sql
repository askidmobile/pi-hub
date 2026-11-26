-- Stage 2: worker questions, quality gate, cost sources (plan phase 1).

-- Questions: how the question arrived, the Pi dialog to answer, the status to return to,
-- and when the Stop hook first blocked on it (spec FR-102, FR-109, D-110).
ALTER TABLE questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question'
  CHECK (kind IN ('question', 'plan', 'text'));
ALTER TABLE questions ADD COLUMN pi_dialog_id TEXT;
ALTER TABLE questions ADD COLUMN resume_status TEXT CHECK (resume_status IN ('planning', 'running'));
ALTER TABLE questions ADD COLUMN hook_delivered_at TEXT;

-- Quality verdict details for the envelope (spec FR-112).
ALTER TABLE tasks ADD COLUMN quality_issues_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN quality_log_path TEXT;

-- Quality of the base commit, once per project and commit, per command (spec FR-119).
CREATE TABLE quality_baselines (
  project_id   TEXT NOT NULL REFERENCES projects(id),
  base_commit  TEXT NOT NULL,
  command      TEXT NOT NULL,          -- test | lint | typecheck
  exit_code    INTEGER,
  timed_out    INTEGER NOT NULL DEFAULT 0,
  checked_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, base_commit, command)
);

-- steps: new cost source `unknown` and the price used for `tokens_x_price` (spec FR-116).
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt (plan PD-105).
CREATE TABLE steps_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  seq                 INTEGER NOT NULL,
  model               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost                REAL NOT NULL DEFAULT 0,  -- 0 when cost_source = 'unknown'
  cost_source         TEXT NOT NULL
    CHECK (cost_source IN ('provider', 'pi_event', 'tokens_x_price', 'unknown')),
  price_json          TEXT,                     -- USD per 1M tokens at the time of the step
  latency_ms          INTEGER,
  tool_name           TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
INSERT INTO steps_new
  (id, task_id, seq, model, provider, input_tokens, output_tokens, cache_read_tokens,
   cache_write_tokens, cost, cost_source, latency_ms, tool_name, created_at)
SELECT id, task_id, seq, model, provider, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost, cost_source, latency_ms, tool_name, created_at
FROM steps;
DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE INDEX steps_created_idx ON steps(created_at);
