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
    expect(migrate(db)).toEqual([4]);
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
