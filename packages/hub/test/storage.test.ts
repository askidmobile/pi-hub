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

  it("enforces foreign keys", () => {
    expect(() => repos.insertTask(newTask("s_missing", "p_missing"))).toThrow();
  });
});
