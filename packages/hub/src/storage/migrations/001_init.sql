-- pi-hub initial schema. Only the hub daemon writes to this database.
-- PRAGMA journal_mode = WAL is set by the storage layer on open.

CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  repo_root     TEXT NOT NULL UNIQUE,
  remote_url    TEXT,
  default_mode  TEXT NOT NULL DEFAULT 'off' CHECK (default_mode IN ('on','off')),
  daily_budget  REAL
);

CREATE TABLE tokens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope_json  TEXT NOT NULL,          -- {"projects":[...], "admin":false}
  hash        TEXT NOT NULL,          -- only hashes are stored
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

CREATE TABLE senior_sessions (
  id                 TEXT PRIMARY KEY,
  client             TEXT NOT NULL,   -- claude-code | codex | mcp
  client_session_id  TEXT,
  parent_pid         INTEGER,
  project_id         TEXT REFERENCES projects(id),
  mode               TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('on','off')),
  connected_at       TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  token_id           TEXT REFERENCES tokens(id)
);
CREATE INDEX senior_sessions_client_idx ON senior_sessions(client, client_session_id);
CREATE INDEX senior_sessions_pid_idx ON senior_sessions(parent_pid);

CREATE TABLE tasks (
  id                      TEXT PRIMARY KEY,   -- t_0142
  owner_session_id        TEXT NOT NULL REFERENCES senior_sessions(id),
  project_id              TEXT NOT NULL REFERENCES projects(id),
  status                  TEXT NOT NULL,
  role                    TEXT,
  model                   TEXT,
  routed_by               TEXT CHECK (routed_by IN ('architect','rules','system_one','escalation')),
  route_reason            TEXT,
  escalated_from_task_id  TEXT REFERENCES tasks(id),
  worktree_path           TEXT,
  branch                  TEXT,
  pi_session_path         TEXT,
  log_path                TEXT,
  summary                 TEXT,
  quality_status          TEXT CHECK (quality_status IN ('PASS','FAIL','SKIPPED')),
  pid                     INTEGER,
  created_at              TEXT NOT NULL,
  finished_at             TEXT
);
CREATE INDEX tasks_owner_status_idx ON tasks(owner_session_id, status);
CREATE INDEX tasks_project_idx ON tasks(project_id, created_at);

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  round         INTEGER NOT NULL,
  text          TEXT NOT NULL,
  options_json  TEXT,
  critical      INTEGER NOT NULL DEFAULT 1,
  answer        TEXT,
  answered_by   TEXT,                 -- senior | consultant | user | worker
  asked_at      TEXT NOT NULL,
  answered_at   TEXT
);
CREATE INDEX questions_open_idx ON questions(task_id) WHERE answer IS NULL;

CREATE TABLE steps (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  seq                 INTEGER NOT NULL,
  model               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost                REAL NOT NULL DEFAULT 0,  -- price at the time of the step
  cost_source         TEXT NOT NULL CHECK (cost_source IN ('provider','tokens_x_price','pi_event')),
  latency_ms          INTEGER,
  tool_name           TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (task_id, seq)
);
CREATE INDEX steps_created_idx ON steps(created_at);

CREATE TABLE prices (
  model        TEXT NOT NULL,
  provider     TEXT NOT NULL,
  input        REAL NOT NULL,   -- USD per 1M tokens
  output       REAL NOT NULL,
  cache_read   REAL,
  cache_write  REAL,
  valid_from   TEXT NOT NULL,
  PRIMARY KEY (model, provider, valid_from)
);

INSERT INTO schema_version (version) VALUES (1);
