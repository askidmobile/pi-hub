import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  listMigrations,
  migrate,
  openDatabase,
  schemaVersion,
} from "../src/storage/db.js";
import { parseJsonList, projectIdFor, Repos } from "../src/storage/repos.js";
import { tempDir } from "./helpers.js";

describe("migrations", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("applies all bundled migrations on a fresh database and is idempotent", () => {
    const db = openDatabase(join(dir.path, "hub.db"));
    const versions = listMigrations().map((m) => m.version);
    expect(migrate(db)).toEqual(versions);
    expect(schemaVersion(db)).toBe(versions.at(-1));
    expect(migrate(db)).toEqual([]);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("wal");
    db.close();
  });

  it("survives reopening the file", () => {
    const file = join(dir.path, "hub.db");
    const a = openDatabase(file);
    migrate(a);
    a.close();
    const b = openDatabase(file);
    expect(migrate(b)).toEqual([]);
    b.close();
  });

  it("rolls back a failing migration and keeps the previous version", () => {
    const mdir = join(dir.path, "m");
    mkdirSync(mdir);
    writeFileSync(
      join(mdir, "001_a.sql"),
      "CREATE TABLE schema_version (version INTEGER NOT NULL); CREATE TABLE a (x INTEGER);",
    );
    writeFileSync(join(mdir, "002_b.sql"), "CREATE TABLE b (x INTEGER); THIS IS NOT SQL;");
    const db = openDatabase(":memory:");
    expect(() => migrate(db, mdir)).toThrow(/002_b\.sql/);
    expect(schemaVersion(db)).toBe(1);
    const b = db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get();
    expect(b).toBeUndefined();
  });

  it("migrates a stage 1 database (schema 3) without losing steps", () => {
    const file = join(dir.path, "hub.db");
    const stage1 = join(dir.path, "m1");
    mkdirSync(stage1);
    for (const m of listMigrations().filter((x) => x.version <= 3))
      writeFileSync(join(stage1, m.name), m.sql);
    const db = openDatabase(file);
    migrate(db, stage1);
    const repos = new Repos(db);
    const p = repos.upsertProject("/repo/a", null);
    const s = repos.createSession({ client: "mcp", parent_pid: 1, project_id: p.id, mode: "on" });
    const t = repos.insertTask({
      owner_session_id: s.id,
      project_id: p.id,
      task_text: "x",
      base_branch: "main",
      role: null,
      model: "fake/success",
      routed_by: "rules",
      route_reason: "r",
    });
    db.prepare(
      `INSERT INTO steps (task_id, seq, model, provider, cost, cost_source, created_at)
       VALUES (?, 1, 'm', 'p', 0.25, 'pi_event', '2026-11-26T00:00:00Z')`,
    ).run(t.id);
    expect(migrate(db)).toEqual([4, 5]);
    const step = db.prepare("SELECT * FROM steps WHERE task_id = ?").get(t.id) as {
      cost: number;
      cost_source: string;
      price_json: string | null;
    };
    expect(step).toMatchObject({ cost: 0.25, cost_source: "pi_event", price_json: null });
    expect(repos.taskUsage(t.id).cost).toBeCloseTo(0.25);
    // The new cost source is accepted, an unknown one still is not.
    repos.insertStep({
      task_id: t.id,
      model: "m",
      provider: "p",
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost: 0,
      cost_source: "unknown",
    });
    expect(() =>
      db
        .prepare(
          "INSERT INTO steps (task_id, seq, model, provider, cost_source, created_at) VALUES (?, 9, 'm', 'p', 'guess', 'x')",
        )
        .run(t.id),
    ).toThrow();
    db.close();
  });

  it("migrates a stage 2 database (schema 4): past tasks get one model run", () => {
    const stage2 = join(dir.path, "m2");
    mkdirSync(stage2);
    for (const m of listMigrations().filter((x) => x.version <= 4))
      writeFileSync(join(stage2, m.name), m.sql);
    const db = openDatabase(join(dir.path, "hub.db"));
    migrate(db, stage2);
    const repos = new Repos(db);
    const p = repos.upsertProject("/repo/a", null);
    const s = repos.createSession({ client: "mcp", parent_pid: 1, project_id: p.id, mode: "on" });
    const base = {
      owner_session_id: s.id,
      project_id: p.id,
      task_text: "x",
      base_branch: "main",
      role: "code",
      routed_by: "architect" as const,
      route_reason: "model from the architect",
    };
    const done = repos.insertTask({ ...base, model: "9router/glm-5.3-flash" });
    db.prepare(
      "UPDATE tasks SET status = 'done', quality_status = 'PASS', started_at = ?, finished_at = ? WHERE id = ?",
    ).run("2026-11-27T10:00:00Z", "2026-11-27T10:05:00Z", done.id);
    const noModel = repos.insertTask({ ...base, model: null });
    db.prepare(
      `INSERT INTO steps (task_id, seq, model, provider, cost, cost_source, created_at)
       VALUES (?, 1, 'glm-5.3-flash', '9router', 0.1, 'pi_event', '2026-11-27T10:01:00Z')`,
    ).run(done.id);
    expect(migrate(db)).toEqual([5]);
    expect(repos.modelRuns(done.id)).toEqual([
      {
        task_id: done.id,
        seq: 1,
        model: "9router/glm-5.3-flash",
        routed_by: "architect",
        reason: "model from the architect",
        started_at: "2026-11-27T10:00:00Z",
        finished_at: "2026-11-27T10:05:00Z",
        quality: "PASS",
      },
    ]);
    expect(repos.modelRuns(noModel.id)).toEqual([]);
    expect(repos.getTask(done.id)?.first_try_pass).toBe(null);
    const step = db.prepare("SELECT kind FROM steps WHERE task_id = ?").get(done.id) as {
      kind: string;
    };
    expect(step.kind).toBe("worker");
    expect(() =>
      db.prepare("UPDATE steps SET kind = 'other' WHERE task_id = ?").run(done.id),
    ).toThrow();
    db.close();
  });

  it("rejects duplicate migration versions", () => {
    const mdir = join(dir.path, "dup");
    mkdirSync(mdir);
    writeFileSync(join(mdir, "001_a.sql"), "");
    writeFileSync(join(mdir, "001_b.sql"), "");
    expect(() => listMigrations(mdir)).toThrow(/duplicate/);
  });
});

describe("repos", () => {
  let db: Db;
  let repos: Repos;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    repos = new Repos(db);
  });

  function seed() {
    const project = repos.upsertProject("/repo/a", "git@example.invalid:a.git");
    const session = repos.createSession({
      client: "claude-code",
      parent_pid: 4242,
      project_id: project.id,
      mode: "off",
    });
    return { project, session };
  }

  const newTask = (owner: string, project: string) => ({
    owner_session_id: owner,
    project_id: project,
    task_text: "add validation",
    base_branch: "main",
    role: "code",
    model: "deepseek/deepseek-flash",
    routed_by: "rules" as const,
    route_reason: "role code -> deepseek/deepseek-flash",
  });

  it("upserts projects by repository root deterministically", () => {
    const a = repos.upsertProject("/repo/a", null);
    const b = repos.upsertProject("/repo/a", "url");
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(projectIdFor("/repo/a"));
    expect(repos.getProject(a.id)?.remote_url).toBe("url");
  });

  it("creates sessions and switches mode", () => {
    const { session } = seed();
    expect(session.mode).toBe("off");
    repos.setSessionMode(session.id, "on");
    expect(repos.getSession(session.id)?.mode).toBe("on");
  });

  it("numbers tasks sequentially and lists them per owner", () => {
    const { project, session } = seed();
    const other = repos.createSession({
      client: "claude-code",
      parent_pid: 1,
      project_id: project.id,
      mode: "on",
    });
    const t1 = repos.insertTask(newTask(session.id, project.id));
    const t2 = repos.insertTask(newTask(session.id, project.id));
    repos.insertTask(newTask(other.id, project.id));
    expect([t1.id, t2.id]).toEqual(["t_0001", "t_0002"]);
    expect(t1.status).toBe("queued");
    expect(repos.listTasksByOwner(session.id).map((t) => t.id)).toEqual(["t_0001", "t_0002"]);
    expect(repos.listTasksByStatus(["queued"])).toHaveLength(3);
  });

  it("patches only allowed task columns", () => {
    const { project, session } = seed();
    const t = repos.insertTask(newTask(session.id, project.id));
    repos.updateTask(t.id, { status: "running", warnings_json: JSON.stringify(["stale base"]) });
    const row = repos.getTask(t.id);
    expect(row?.status).toBe("running");
    expect(parseJsonList(row?.warnings_json)).toEqual(["stale base"]);
    expect(() => repos.updateTask(t.id, { id: "x" } as never)).toThrow(/not patchable/);
  });

  it("sums steps per task and per session", () => {
    const { project, session } = seed();
    const t1 = repos.insertTask(newTask(session.id, project.id));
    const t2 = repos.insertTask(newTask(session.id, project.id));
    const step = {
      model: "deepseek-flash",
      provider: "deepseek",
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 700,
      cache_write_tokens: 0,
      cost_source: "pi_event" as const,
    };
    repos.insertStep({ ...step, task_id: t1.id, cost: 0.01 });
    repos.insertStep({ ...step, task_id: t1.id, cost: 0.02 });
    repos.insertStep({ ...step, task_id: t2.id, cost: 0.5 });
    const u = repos.taskUsage(t1.id);
    expect(u.steps).toBe(2);
    expect(u.cost).toBeCloseTo(0.03);
    expect(u.input).toBe(2000);
    expect(u.cache_read).toBe(1400);
    expect(repos.sessionCost(session.id)).toBeCloseTo(0.53);
    const seqs = db.prepare("SELECT seq FROM steps WHERE task_id = ? ORDER BY seq").all(t1.id) as {
      seq: number;
    }[];
    expect(seqs.map((s) => s.seq)).toEqual([1, 2]);
  });

  it("records model runs and the first-try flag (stage 3 FR-205)", () => {
    const { project, session } = seed();
    const t = repos.insertTask(newTask(session.id, project.id));
    expect(
      repos.startModelRun(t.id, { model: "a/x", routed_by: "rules", reason: "role code" }),
    ).toBe(1);
    repos.finishModelRun(t.id, 1, "FAIL");
    expect(repos.startModelRun(t.id, { model: "a/y", routed_by: "escalation" })).toBe(2);
    const runs = repos.modelRuns(t.id);
    expect(runs.map((r) => [r.seq, r.model, r.routed_by, r.quality])).toEqual([
      [1, "a/x", "rules", "FAIL"],
      [2, "a/y", "escalation", null],
    ]);
    expect(runs[0]?.finished_at).toBeTruthy();
    expect(runs[1]?.finished_at).toBe(null);
    repos.setFirstTryPass(t.id, false);
    expect(repos.getTask(t.id)?.first_try_pass).toBe(0);
    repos.setFirstTryPass(t.id, null);
    expect(repos.getTask(t.id)?.first_try_pass).toBe(null);
  });

  it("usage report queries filter by session, project and period (stage 3 FR-206)", () => {
    const { project, session } = seed();
    const other = repos.createSession({
      client: "codex",
      parent_pid: 1,
      project_id: project.id,
      mode: "on",
    });
    const p2 = repos.upsertProject("/repo/b", null);
    const s2 = repos.createSession({ client: "mcp", parent_pid: 2, project_id: p2.id, mode: "on" });
    const step = (taskId: string, model: string, cost: number, at: string, unknown = false) =>
      db
        .prepare(
          `INSERT INTO steps (task_id, seq, model, provider, input_tokens, output_tokens,
             cache_read_tokens, cost, cost_source, kind, created_at)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE task_id = ?),
             ?, '9router', 1000, 100, 400, ?, ?, 'worker', ?)`,
        )
        .run(taskId, taskId, model, cost, unknown ? "unknown" : "pi_event", at);
    const task = (owner: string, proj: string, role: string, at: string) => {
      const t = repos.insertTask({ ...newTask(owner, proj), role });
      db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(at, t.id);
      return t;
    };
    const old = "2026-11-01T00:00:00Z";
    const recent = "2026-11-26T00:00:00Z";
    // a: glm fails first, escalates to deepseek, PASS in the end
    const a = task(session.id, project.id, "code", recent);
    repos.startModelRun(a.id, { model: "9router/glm", routed_by: "rules" });
    repos.finishModelRun(a.id, 1, "FAIL");
    repos.startModelRun(a.id, { model: "9router/deepseek", routed_by: "escalation" });
    repos.finishModelRun(a.id, 2, "PASS");
    repos.updateTask(a.id, { quality_status: "PASS", cost_usd: 0.3, first_try_pass: 0 });
    step(a.id, "glm", 0.1, recent);
    step(a.id, "deepseek", 0.2, recent);
    // b: glm, first-try PASS, other session of the same project
    const b = task(other.id, project.id, "code", recent);
    repos.startModelRun(b.id, { model: "9router/glm", routed_by: "rules" });
    repos.updateTask(b.id, { quality_status: "PASS", cost_usd: 0.05, first_try_pass: 1 });
    step(b.id, "glm", 0, recent, true);
    // c: no check commands (SKIPPED), role docs
    const c = task(session.id, project.id, "docs", recent);
    repos.startModelRun(c.id, { model: "9router/glm", routed_by: "rules" });
    repos.updateTask(c.id, { quality_status: "SKIPPED", cost_usd: 0.01 });
    step(c.id, "glm", 0.01, recent);
    // d: old task, e: another project
    const d = task(session.id, project.id, "code", old);
    step(d.id, "glm", 5, old);
    const e = task(s2.id, p2.id, "code", recent);
    step(e.id, "glm", 7, recent);

    const all = repos.usageTotals({ since: null });
    expect(all.cost).toBeCloseTo(12.31);
    expect(all.tasks).toBe(5);
    const week = { projectId: project.id, since: "2026-11-20T00:00:00Z" };
    expect(repos.usageTotals(week)).toMatchObject({
      steps: 4,
      unknown_steps: 1,
      input: 4000,
      cache_read: 1600,
      tasks: 3,
      unchecked_tasks: 1,
    });
    expect(repos.usageTotals(week).cost).toBeCloseTo(0.31);
    expect(repos.usageTotals({ sessionId: other.id, since: null })).toMatchObject({
      steps: 1,
      tasks: 1,
    });

    const cost = repos.usageCostBy("model", week);
    expect(cost.map((r) => [r.key, r.steps, r.unknown_steps])).toEqual([
      ["9router/deepseek", 1, 0],
      ["9router/glm", 3, 1],
    ]);
    const models = Object.fromEntries(repos.usageTasksBy("model", week).map((r) => [r.key, r]));
    // glm: tasks a, b, c; checked first runs a (FAIL) and b (PASS), c is SKIPPED (D-215)
    expect(models["9router/glm"]).toMatchObject({
      tasks: 3,
      first_try_checked: 2,
      first_try_pass: 1,
      pass_tasks: 1,
    });
    expect(models["9router/glm"]?.pass_cost).toBeCloseTo(0.05);
    // deepseek finished task a: the final PASS counts for the last model only
    expect(models["9router/deepseek"]).toMatchObject({
      tasks: 1,
      first_try_checked: 0,
      pass_tasks: 1,
    });
    const roles = Object.fromEntries(repos.usageTasksBy("role", week).map((r) => [r.key, r]));
    expect(roles.code).toMatchObject({
      tasks: 2,
      first_try_checked: 2,
      first_try_pass: 1,
      pass_tasks: 2,
    });
    expect(roles.docs).toMatchObject({ tasks: 1, first_try_checked: 0, pass_tasks: 0 });
    const roleCost = repos.usageCostBy("role", week);
    expect(roleCost.map((r) => r.key)).toEqual(["code", "docs"]);
  });

  it("records questions: rounds, one open at a time, answer, close, per-session view", () => {
    const { project, session } = seed();
    const t = repos.insertTask(newTask(session.id, project.id));
    const q1 = repos.insertQuestion({
      task_id: t.id,
      kind: "question",
      text: "Redis or a table?",
      options: ["A: Redis", "B: table"],
      pi_dialog_id: "d1",
      resume_status: "running",
    });
    expect(q1).toMatchObject({ id: `q_${t.id}_1`, round: 1, pi_dialog_id: "d1" });
    expect(JSON.parse(q1.options_json ?? "[]")).toEqual(["A: Redis", "B: table"]);
    expect(repos.openQuestion(t.id)?.id).toBe(q1.id);
    expect(repos.openQuestionsForSession(session.id).map((q) => q.id)).toEqual([q1.id]);

    repos.markHookDelivered(q1.id);
    const delivered = repos.getQuestion(q1.id)?.hook_delivered_at;
    expect(delivered).toBeTruthy();
    repos.markHookDelivered(q1.id); // first delivery time is kept
    expect(repos.getQuestion(q1.id)?.hook_delivered_at).toBe(delivered);

    repos.answerQuestion(q1.id, "B, with TTL", "senior");
    expect(repos.openQuestion(t.id)).toBeUndefined();
    repos.answerQuestion(q1.id, "late", "senior"); // an answered question is not overwritten
    expect(repos.getQuestion(q1.id)?.answer).toBe("B, with TTL");

    const q2 = repos.insertQuestion({
      task_id: t.id,
      kind: "text",
      text: "Which port?",
      resume_status: "running",
    });
    expect(q2.round).toBe(2);
    expect(q2.options_json).toBeNull();
    repos.closeQuestion(q2.id);
    expect(repos.openQuestion(t.id)).toBeUndefined();
    expect(repos.countQuestions(t.id)).toEqual({ asked: 2, answered: 1 });

    const other = repos.createSession({
      client: "claude-code",
      parent_pid: 5151,
      project_id: project.id,
      mode: "on",
    });
    repos.insertQuestion({ task_id: t.id, kind: "plan", text: "plan", resume_status: "planning" });
    expect(repos.openQuestionsForSession(other.id)).toEqual([]);
    expect(() =>
      repos.insertQuestion({
        task_id: t.id,
        kind: "bogus" as never,
        text: "x",
        resume_status: "running",
      }),
    ).toThrow();
  });

  it("finds sessions by parent pid and by project", () => {
    const { project, session } = seed();
    const codex = repos.createSession({
      client: "codex",
      parent_pid: 777,
      project_id: project.id,
      mode: "on",
    });
    expect(repos.sessionsByParentPids([1, 4242]).map((s) => s.id)).toEqual([session.id]);
    expect(repos.sessionsByParentPids([777], "claude-code")).toEqual([]);
    expect(repos.sessionsByParentPids([])).toEqual([]);
    expect(repos.sessionsForProject(project.id, "claude-code").map((s) => s.id)).toEqual([
      session.id,
    ]);
    expect(
      repos
        .sessionsForProject(project.id)
        .map((s) => s.id)
        .sort(),
    ).toEqual([session.id, codex.id].sort());
  });

  it("stores quality baselines per project, commit and command", () => {
    const { project } = seed();
    repos.putBaseline({
      project_id: project.id,
      base_commit: "abc",
      command: "test",
      exit_code: 1,
      timed_out: 0,
    });
    repos.putBaseline({
      project_id: project.id,
      base_commit: "abc",
      command: "test",
      exit_code: 0,
      timed_out: 0,
    });
    repos.putBaseline({
      project_id: project.id,
      base_commit: "abc",
      command: "lint",
      exit_code: null,
      timed_out: 1,
    });
    const rows = repos.getBaseline(project.id, "abc");
    expect(rows.map((r) => [r.command, r.exit_code, r.timed_out]).sort()).toEqual([
      ["lint", null, 1],
      ["test", 0, 0],
    ]);
    expect(repos.getBaseline(project.id, "other")).toEqual([]);
  });

  it("enforces foreign keys", () => {
    expect(() => repos.insertTask(newTask("s_missing", "p_missing"))).toThrow();
  });
});
