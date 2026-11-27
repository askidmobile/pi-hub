import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, migrate, openDatabase } from "../src/storage/db.js";
import { Repos } from "../src/storage/repos.js";
import { buildUsageReport, MAX_REPORT_BYTES, periodStart } from "../src/tasks/usage-report.js";
import { tempDir } from "./helpers.js";
import { connect, type Harness, makeHarness } from "./task-harness.js";

/** Stage 3 scenario 4: usage_report built from steps and model runs (FR-206, D-209, D-215). */
describe("usage report", () => {
  let db: Db;
  let repos: Repos;
  let projectId: string;
  let sessionId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    repos = new Repos(db);
    projectId = repos.upsertProject("/repo/a", null).id;
    sessionId = repos.createSession({
      client: "claude-code",
      parent_pid: 1,
      project_id: projectId,
      mode: "on",
    }).id;
  });

  const now = new Date().toISOString();
  const task = (
    role: string,
    model: string,
    opts: { quality?: "PASS" | "FAIL" | "SKIPPED"; first?: 0 | 1 | null; cost?: number } = {},
  ) => {
    const t = repos.insertTask({
      owner_session_id: sessionId,
      project_id: projectId,
      task_text: "x",
      base_branch: "main",
      role,
      model,
      routed_by: "rules",
      route_reason: "",
    });
    repos.startModelRun(t.id, { model, routed_by: "rules" });
    repos.updateTask(t.id, {
      quality_status: opts.quality ?? "PASS",
      first_try_pass: opts.first === undefined ? 1 : opts.first,
      cost_usd: opts.cost ?? 0,
    });
    return t.id;
  };
  const step = (taskId: string, model: string, cost: number, unknown = false, at = now) =>
    db
      .prepare(
        `INSERT INTO steps (task_id, seq, model, provider, input_tokens, output_tokens,
           cache_read_tokens, cost, cost_source, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE task_id = ?),
           ?, '9router', 1000, 100, 3000, ?, ?, ?)`,
      )
      .run(taskId, taskId, model, cost, unknown ? "unknown" : "pi_event", at);
  const report = (period: "day" | "week" | "month" | "all" = "week") =>
    buildUsageReport(repos, {
      scope: "project",
      period,
      filter: { projectId, since: periodStart(period) },
    });

  it("totals, model and role lines, first-try share and the average cost of a PASS", () => {
    const a = task("code", "9router/glm:high", { cost: 0.2 });
    step(a, "glm", 0.2);
    const b = task("code", "9router/glm", { quality: "FAIL", first: 0, cost: 0.1 });
    step(b, "glm", 0.1);
    const c = task("docs", "9router/deep", { quality: "SKIPPED", first: null });
    step(c, "deep", 0, true);
    const r = report();
    expect(r.total).toEqual({
      cost_usd: 0.3,
      unknown_price_steps: 1,
      input: 12000,
      output: 300,
      cached_share: 0.75,
      tasks: 3,
      unchecked_tasks: 1,
    });
    // `:high` is the same model; deep has only unknown prices
    expect(r.by_model).toEqual([
      {
        name: "9router/glm",
        tasks: 2,
        cost_usd: 0.3,
        first_try_pass_share: 0.5,
        avg_cost_pass: 0.2,
      },
      {
        name: "9router/deep",
        tasks: 1,
        cost_usd: "unknown",
        first_try_pass_share: null,
        avg_cost_pass: null,
      },
    ]);
    expect(r.by_role.map((x) => [x.name, x.tasks, x.first_try_pass_share])).toEqual([
      ["code", 2, 0.5],
      ["docs", 1, null],
    ]);
  });

  it("a line with some unknown steps keeps its sum and names the gap", () => {
    const a = task("code", "9router/glm");
    step(a, "glm", 0.5);
    step(a, "glm", 0, true);
    expect(report().by_model[0]).toMatchObject({ cost_usd: 0.5, unknown_price_steps: 1 });
  });

  it("the period limits steps and tasks", () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const a = task("code", "9router/glm");
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(old, a);
    step(a, "glm", 1, false, old);
    const b = task("code", "9router/glm");
    step(b, "glm", 0.25);
    expect(report("week").total).toMatchObject({ cost_usd: 0.25, tasks: 1 });
    expect(report("month").total).toMatchObject({ cost_usd: 1.25, tasks: 2 });
    expect(report("all").since).toBe(null);
  });

  it("20 models and 10 roles fit 2 KB, the most expensive kept, the rest counted", () => {
    for (let i = 0; i < 20; i++) {
      const id = task(`role-with-a-long-name-${i % 10}`, `9router/model-with-a-long-id-${i}`);
      step(id, `model-with-a-long-id-${i}`, i + 1);
    }
    const r = report();
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(r.by_model[0]?.name).toBe("9router/model-with-a-long-id-19");
    expect(r.by_model.length + (r.more?.models ?? 0)).toBe(20);
    expect(r.by_role.length + (r.more?.roles ?? 0)).toBe(10);
    expect(r.more?.models).toBeGreaterThan(0);
  });

  it("builds from 10 000 steps within 200 ms", () => {
    const ids = Array.from({ length: 100 }, (_, i) => task(`r${i % 5}`, `p/m${i % 10}`));
    db.exec("BEGIN");
    for (let i = 0; i < 10_000; i++) step(ids[i % 100] as string, `m${i % 10}`, 0.001);
    db.exec("COMMIT");
    report();
    const t0 = performance.now();
    const r = report();
    expect(performance.now() - t0).toBeLessThan(200);
    expect(r.total.cost_usd).toBeCloseTo(10);
  });
});

describe("TaskService.usageReport", () => {
  let dir: ReturnType<typeof tempDir>;
  let h: Harness;
  beforeEach(() => {
    dir = tempDir();
    h = makeHarness(dir.path);
  });
  afterEach(async () => {
    await h.service.shutdown();
    dir.cleanup();
  });

  it("is refused while delegation is off (FR-206)", async () => {
    await connect(h, "off");
    expect(() => h.service.usageReport(h.sessionId, "session", "week")).toThrow(
      /режим архитектора выключен/,
    );
  });

  it("scopes: session, project, all", async () => {
    await connect(h, "on");
    for (const scope of ["session", "project", "all"] as const) {
      expect(h.service.usageReport(h.sessionId, scope, "day")).toMatchObject({
        scope,
        period: "day",
        total: { tasks: 0 },
      });
    }
  });
});
