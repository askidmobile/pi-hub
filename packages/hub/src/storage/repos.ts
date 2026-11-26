import { createHash, randomUUID } from "node:crypto";
import type {
  ClientKind,
  DelegationMode,
  QualityStatus,
  QuestionKind,
  RoutedBy,
  TaskStatus,
} from "@pi-hub/protocol";
import type { Db } from "./db.js";

const now = () => new Date().toISOString();

export interface ProjectRow {
  id: string;
  repo_root: string;
  remote_url: string | null;
  default_mode: DelegationMode;
  daily_budget: number | null;
}

export interface SeniorSessionRow {
  id: string;
  client: ClientKind;
  client_session_id: string | null;
  parent_pid: number | null;
  project_id: string | null;
  mode: DelegationMode;
  connected_at: string;
  last_seen_at: string;
  token_id: string | null;
}

export interface TaskRow {
  id: string;
  owner_session_id: string;
  project_id: string;
  status: TaskStatus;
  role: string | null;
  model: string | null;
  routed_by: RoutedBy | null;
  route_reason: string | null;
  escalated_from_task_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  pi_session_path: string | null;
  log_path: string | null;
  summary: string | null;
  quality_status: QualityStatus | null;
  pid: number | null;
  created_at: string;
  finished_at: string | null;
  task_text: string;
  base_branch: string | null;
  warnings_json: string;
  assumptions_json: string;
  failure_reason: string | null;
  cost_usd: number;
  attempt: number;
  started_at: string | null;
  base_commit: string | null;
  quality_issues_json: string;
  quality_log_path: string | null;
}

/** Columns a caller may change after insert. `id`, `owner_session_id`, `project_id`, `created_at` are fixed. */
export type TaskPatch = Partial<
  Omit<TaskRow, "id" | "owner_session_id" | "project_id" | "created_at">
>;

export interface NewTask {
  owner_session_id: string;
  project_id: string;
  task_text: string;
  base_branch: string;
  role: string | null;
  model: string | null;
  routed_by: RoutedBy;
  route_reason: string;
}

export interface StepInput {
  task_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  cost_source: CostSource;
  /** Price used for `tokens_x_price`, USD per 1M tokens (stage 2 FR-116). */
  price_json?: string | null;
  latency_ms?: number | null;
  tool_name?: string | null;
}

/** Where a step's cost comes from, most accurate first (stage 2 FR-116). */
export type CostSource = "provider" | "pi_event" | "tokens_x_price" | "unknown";

export interface QuestionRow {
  id: string;
  task_id: string;
  round: number;
  kind: QuestionKind;
  text: string;
  options_json: string | null;
  critical: number;
  answer: string | null;
  answered_by: string | null;
  asked_at: string;
  /** Set when answered or closed without an answer (`cancel`); NULL means open. */
  answered_at: string | null;
  pi_dialog_id: string | null;
  resume_status: "planning" | "running" | null;
  hook_delivered_at: string | null;
}

export interface NewQuestion {
  task_id: string;
  kind: QuestionKind;
  text: string;
  options?: string[] | undefined;
  pi_dialog_id?: string | null;
  resume_status: "planning" | "running";
}

export interface BaselineRow {
  project_id: string;
  base_commit: string;
  command: string;
  exit_code: number | null;
  timed_out: number;
  checked_at: string;
}

export interface UsageTotals {
  steps: number;
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const TASK_PATCHABLE = new Set<keyof TaskPatch>([
  "status",
  "role",
  "model",
  "routed_by",
  "route_reason",
  "escalated_from_task_id",
  "worktree_path",
  "branch",
  "pi_session_path",
  "log_path",
  "summary",
  "quality_status",
  "pid",
  "finished_at",
  "task_text",
  "base_branch",
  "warnings_json",
  "assumptions_json",
  "failure_reason",
  "cost_usd",
  "attempt",
  "started_at",
  "base_commit",
  "quality_issues_json",
  "quality_log_path",
]);

/** Deterministic project id: the same repository always maps to the same row. */
export function projectIdFor(repoRoot: string): string {
  return `p_${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`;
}

export function parseJsonList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** All SQL lives here; the rest of the hub never writes queries. */
export class Repos {
  constructor(private readonly db: Db) {}

  // --- projects ---

  upsertProject(repoRoot: string, remoteUrl: string | null): ProjectRow {
    const id = projectIdFor(repoRoot);
    this.db
      .prepare(
        `INSERT INTO projects (id, repo_root, remote_url) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET remote_url = excluded.remote_url`,
      )
      .run(id, repoRoot, remoteUrl);
    return this.getProject(id) as ProjectRow;
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  // --- senior sessions ---

  createSession(input: {
    client: ClientKind;
    parent_pid: number;
    project_id: string | null;
    mode: DelegationMode;
    client_session_id?: string | null;
  }): SeniorSessionRow {
    const id = `s_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO senior_sessions
           (id, client, client_session_id, parent_pid, project_id, mode, connected_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.client,
        input.client_session_id ?? null,
        input.parent_pid,
        input.project_id,
        input.mode,
        ts,
        ts,
      );
    return this.getSession(id) as SeniorSessionRow;
  }

  getSession(id: string): SeniorSessionRow | undefined {
    return this.db.prepare("SELECT * FROM senior_sessions WHERE id = ?").get(id) as
      | SeniorSessionRow
      | undefined;
  }

  setSessionMode(id: string, mode: DelegationMode): void {
    this.db
      .prepare("UPDATE senior_sessions SET mode = ?, last_seen_at = ? WHERE id = ?")
      .run(mode, now(), id);
  }

  /** Sessions whose shim was started by one of `pids` (hook resolution, plan PD-107). */
  sessionsByParentPids(pids: readonly number[], client?: ClientKind): SeniorSessionRow[] {
    if (pids.length === 0) return [];
    const marks = pids.map(() => "?").join(", ");
    const byClient = client ? " AND client = ?" : "";
    return this.db
      .prepare(
        `SELECT * FROM senior_sessions WHERE parent_pid IN (${marks})${byClient}
         ORDER BY last_seen_at DESC`,
      )
      .all(...pids, ...(client ? [client] : [])) as unknown as SeniorSessionRow[];
  }

  sessionsForProject(projectId: string, client?: ClientKind): SeniorSessionRow[] {
    const byClient = client ? " AND client = ?" : "";
    return this.db
      .prepare(
        `SELECT * FROM senior_sessions WHERE project_id = ?${byClient} ORDER BY last_seen_at DESC`,
      )
      .all(projectId, ...(client ? [client] : [])) as unknown as SeniorSessionRow[];
  }

  touchSession(id: string): void {
    this.db.prepare("UPDATE senior_sessions SET last_seen_at = ? WHERE id = ?").run(now(), id);
  }

  // --- tasks ---

  /** `t_0001`, `t_0002`, ... in creation order; width grows past 9999. */
  nextTaskId(): string {
    const row = this.db
      .prepare(
        "SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) AS n FROM tasks WHERE id LIKE 't\\_%' ESCAPE '\\'",
      )
      .get() as { n: number | null } | undefined;
    const next = (row?.n ?? 0) + 1;
    return `t_${String(next).padStart(4, "0")}`;
  }

  insertTask(input: NewTask): TaskRow {
    const id = this.nextTaskId();
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, owner_session_id, project_id, status, role, model, routed_by, route_reason,
            task_text, base_branch, created_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.owner_session_id,
        input.project_id,
        input.role,
        input.model,
        input.routed_by,
        input.route_reason,
        input.task_text,
        input.base_branch,
        now(),
      );
    return this.getTask(id) as TaskRow;
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  updateTask(id: string, patch: TaskPatch): void {
    const keys = Object.keys(patch) as (keyof TaskPatch)[];
    if (keys.length === 0) return;
    for (const k of keys) {
      if (!TASK_PATCHABLE.has(k)) throw new Error(`task column "${String(k)}" is not patchable`);
    }
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch[k] ?? null) as string | number | null);
    this.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...values, id);
  }

  listTasksByOwner(ownerSessionId: string): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE owner_session_id = ? ORDER BY created_at, id")
      .all(ownerSessionId) as unknown as TaskRow[];
  }

  listTasksByStatus(statuses: readonly TaskStatus[]): TaskRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${marks}) ORDER BY created_at, id`)
      .all(...statuses) as unknown as TaskRow[];
  }

  listAllTasks(limit = 200): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as TaskRow[];
  }

  // --- questions ---

  /** Rounds count from 1 per task; the id is stable and readable (`q_t_0142_1`). */
  insertQuestion(q: NewQuestion): QuestionRow {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(round), 0) + 1 AS round FROM questions WHERE task_id = ?")
      .get(q.task_id) as { round: number };
    const id = `q_${q.task_id}_${row.round}`;
    this.db
      .prepare(
        `INSERT INTO questions
           (id, task_id, round, kind, text, options_json, pi_dialog_id, resume_status, asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        q.task_id,
        row.round,
        q.kind,
        q.text,
        q.options?.length ? JSON.stringify(q.options) : null,
        q.pi_dialog_id ?? null,
        q.resume_status,
        now(),
      );
    return this.getQuestion(id) as QuestionRow;
  }

  getQuestion(id: string): QuestionRow | undefined {
    return this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as
      | QuestionRow
      | undefined;
  }

  /** The task's open question; a worker asks one at a time, so at most one is open. */
  openQuestion(taskId: string): QuestionRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM questions WHERE task_id = ? AND answered_at IS NULL ORDER BY round DESC LIMIT 1",
      )
      .get(taskId) as QuestionRow | undefined;
  }

  answerQuestion(id: string, answer: string, answeredBy: string): void {
    this.db
      .prepare(
        "UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL",
      )
      .run(answer, answeredBy, now(), id);
  }

  /** Closes an open question without an answer (task cancelled). */
  closeQuestion(id: string): void {
    this.db
      .prepare("UPDATE questions SET answered_at = ? WHERE id = ? AND answered_at IS NULL")
      .run(now(), id);
  }

  /** Open questions of every task owned by the session, oldest first. */
  openQuestionsForSession(seniorSessionId: string): QuestionRow[] {
    return this.db
      .prepare(
        `SELECT q.* FROM questions q JOIN tasks t ON t.id = q.task_id
         WHERE t.owner_session_id = ? AND q.answered_at IS NULL
         ORDER BY q.asked_at, q.id`,
      )
      .all(seniorSessionId) as unknown as QuestionRow[];
  }

  markHookDelivered(id: string): void {
    this.db
      .prepare(
        "UPDATE questions SET hook_delivered_at = ? WHERE id = ? AND hook_delivered_at IS NULL",
      )
      .run(now(), id);
  }

  countQuestions(taskId: string): { asked: number; answered: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS asked, COUNT(answer) AS answered FROM questions WHERE task_id = ?`,
      )
      .get(taskId) as { asked: number; answered: number };
  }

  // --- quality baselines ---

  getBaseline(projectId: string, baseCommit: string): BaselineRow[] {
    return this.db
      .prepare("SELECT * FROM quality_baselines WHERE project_id = ? AND base_commit = ?")
      .all(projectId, baseCommit) as unknown as BaselineRow[];
  }

  putBaseline(row: Omit<BaselineRow, "checked_at">): void {
    this.db
      .prepare(
        `INSERT INTO quality_baselines (project_id, base_commit, command, exit_code, timed_out, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, base_commit, command) DO UPDATE SET
           exit_code = excluded.exit_code, timed_out = excluded.timed_out,
           checked_at = excluded.checked_at`,
      )
      .run(row.project_id, row.base_commit, row.command, row.exit_code, row.timed_out, now());
  }

  // --- steps ---

  insertStep(step: StepInput): void {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM steps WHERE task_id = ?")
      .get(step.task_id) as { seq: number };
    this.db
      .prepare(
        `INSERT INTO steps
           (task_id, seq, model, provider, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cost, cost_source, price_json, latency_ms, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.task_id,
        row.seq,
        step.model,
        step.provider,
        step.input_tokens,
        step.output_tokens,
        step.cache_read_tokens,
        step.cache_write_tokens,
        step.cost,
        step.cost_source,
        step.price_json ?? null,
        step.latency_ms ?? null,
        step.tool_name ?? null,
        now(),
      );
  }

  taskUsage(taskId: string): UsageTotals {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS steps, COALESCE(SUM(cost), 0) AS cost,
                COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write
         FROM steps WHERE task_id = ?`,
      )
      .get(taskId) as unknown as UsageTotals;
  }

  sessionCost(seniorSessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.cost), 0) AS cost
         FROM steps s JOIN tasks t ON t.id = s.task_id
         WHERE t.owner_session_id = ?`,
      )
      .get(seniorSessionId) as { cost: number };
    return row.cost;
  }
}
