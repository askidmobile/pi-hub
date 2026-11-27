import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubError } from "../src/errors.js";
import { extractSummary, hasSummaryBlock, looksIncomplete } from "../src/tasks/finalize.js";
import { initRepo, tempDir } from "./helpers.js";
import { connect, git, type Harness, makeHarness, start } from "./task-harness.js";

describe("TaskService (fake worker)", () => {
  let dir: ReturnType<typeof tempDir>;
  let h: Harness;
  beforeEach(async () => {
    dir = tempDir();
    h = makeHarness(dir.path);
    await connect(h);
  });
  afterEach(async () => {
    await h.service.shutdown();
    dir.cleanup();
  });

  it("scenario 1: start -> wait -> result, branch mergeable, envelope complete", async () => {
    const s = await start(h);
    expect(s).toMatchObject({ task_id: "t_0001", model: "fake/success", warnings: [] });
    expect(["queued", "running"]).toContain(s.status);
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect(w.status).toBe("done");
    expect(w.cost_line).toMatch(
      /^0,001 \$ · .* вход \(\d+% из кэша\) · .* выход · .* · SKIPPED · по сессии 0,001 \$$/,
    );
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env).toMatchObject({
      status: "done",
      branch: "pi/t_0001",
      changed_files: ["hello.txt"],
      quality: { status: "SKIPPED", issues: [] },
      warnings: [],
    });
    expect(env.summary).toContain("Added hello.txt");
    expect(env.usage.cost_usd).toBeCloseTo(0.001);
    expect(existsSync(env.log_path)).toBe(true);
    expect(JSON.stringify(env).length).toBeLessThan(2048);
    git(h.repo, "merge", "-q", "--no-edit", "pi/t_0001");
    expect(readFileSync(join(h.repo, "hello.txt"), "utf8")).toBe("hello from pi-hub\n");
  });

  it("records assumptions reported by the worker", async () => {
    const s = await start(h, "fake/assumption");
    await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect((await h.service.result(h.sessionId, s.task_id)).assumptions).toEqual([
      "Password length is at least 10 characters",
    ]);
  });

  it("asks once for a summary when SUMMARY is missing (FR-026)", async () => {
    const s = await start(h, "fake/no-summary");
    await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.summary).toContain("Added hello.txt");
    const log = readFileSync(env.log_path, "utf8");
    // exactly one follow-up was sent (its response is in the task log)
    expect(log.match(/"command":"follow_up"/g)).toHaveLength(1);
  });

  it("commits leftovers and warns (FR-016)", async () => {
    const s = await start(h, "fake/no-commit");
    await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.changed_files).toEqual(["hello.txt"]);
    expect(env.warnings.some((w) => w.startsWith("хаб закоммитил"))).toBe(true);
    expect(git(h.repo, "log", "-1", "--format=%an", "pi/t_0001")).toBe("Test User");
  });

  it("warns on empty diff, incompleteness and AI attribution (FR-016, FR-027)", async () => {
    const a = await start(h, "fake/empty-diff");
    const b = await start(h, "fake/ai-attribution");
    await h.service.waitFor(h.sessionId, a.task_id, 15_000);
    await h.service.waitFor(h.sessionId, b.task_id, 15_000);
    expect((await h.service.result(h.sessionId, a.task_id)).warnings).toContain("изменений нет");
    const eb = await h.service.result(h.sessionId, b.task_id);
    expect(eb.status).toBe("done");
    expect(eb.warnings.some((w) => /содержит подпись ИИ: Co-authored-by: Claude/.test(w))).toBe(
      true,
    );
    const c = await start(h, "fake/incomplete");
    await h.service.waitFor(h.sessionId, c.task_id, 15_000);
    expect((await h.service.result(h.sessionId, c.task_id)).warnings).toContain(
      "в итоге воркера есть признаки незавершённой работы",
    );
  });

  it("fails on worker crash with the reason in the envelope", async () => {
    const s = await start(h, "fake/crash");
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toMatch(/simulated crash/);
    expect((await h.service.result(h.sessionId, s.task_id)).warnings[0]).toMatch(
      /^причина: воркер завершился/,
    );
  });

  it("fails on a setup error before Pi starts, with no steps recorded (FR-024)", async () => {
    writeFileSync(join(h.repo, ".pi-hub.toml"), 'setup = "echo broken deps >&2; exit 3"\n');
    const s = await start(h);
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toMatch(/setup завершился с кодом 3: .*broken deps/);
    expect(h.repos.taskUsage(s.task_id).steps).toBe(0);
  });

  it("stops a task over the cost limit (FR-025)", async () => {
    const s = await start(h, "fake/expensive");
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toMatch(/лимит стоимости 2 \$/);
  });

  it("queues over max_workers and starts in order as slots free (FR-020)", async () => {
    const t1 = await start(h, "fake/hang");
    const t2 = await start(h, "fake/hang");
    const t3 = await start(h, "fake/success");
    expect([t1.status, t2.status, t3.status]).toEqual(["running", "running", "queued"]);
    const cancelStarted = Date.now();
    expect(await h.service.cancel(h.sessionId, t1.task_id)).toEqual({
      task_id: t1.task_id,
      status: "cancelled",
    });
    expect(Date.now() - cancelStarted).toBeLessThan(10_000);
    expect((await h.service.waitFor(h.sessionId, t3.task_id, 15_000)).status).toBe("done");
    const c = h.repos.getTask(t1.task_id);
    expect(c?.status).toBe("cancelled");
    expect(c?.worktree_path && existsSync(c.worktree_path)).toBe(true);
    expect(git(h.repo, "branch", "--list", "pi/t_0001")).toContain("pi/t_0001");
    await h.service.cancel(h.sessionId, t2.task_id);
  });

  it("stops a task over the time limit (FR-021)", async () => {
    await h.service.shutdown();
    h = makeHarness(dir.path, { timeLimitMs: 300 });
    await connect(h);
    const s = await start(h, "fake/hang");
    const w = await h.service.waitFor(h.sessionId, s.task_id, 10_000);
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toMatch(/превышено время задачи/);
  });

  it("status lists only the caller's tasks; others are not found", async () => {
    const mine = await start(h);
    await h.service.waitFor(h.sessionId, mine.task_id, 15_000);
    const other = await h.sessions.connect({ client: "claude-code", parent_pid: 1, cwd: h.repo });
    expect(h.service.status(h.sessionId).map((r) => r.task_id)).toEqual([mine.task_id]);
    expect(h.service.status(other.session.id)).toEqual([]);
    await expect(h.service.result(other.session.id, mine.task_id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects start when delegation is off, repo not allowed or base missing; warns on stale base", async () => {
    await connect(h, "off");
    await expect(start(h)).rejects.toMatchObject({ code: "delegation_off" });
    await connect(h, "on");
    const other = join(dir.path, "other");
    mkdirSync(other);
    initRepo(other);
    await expect(
      h.service.start(h.sessionId, { task: "x", repo: other, base_branch: "main" }),
    ).rejects.toMatchObject({ code: "repo_not_allowed" });
    await expect(start(h, "fake/success", { base_branch: "nope" })).rejects.toMatchObject({
      code: "base_not_found",
    });
    await expect(start(h, "badmodel")).rejects.toBeInstanceOf(HubError);
    writeFileSync(join(h.repo, "dirty.txt"), "x");
    const s = await start(h);
    expect(s.warnings[0]).toMatch(/незакоммиченные правки/);
    await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect((await h.service.result(h.sessionId, s.task_id)).warnings[0]).toMatch(
      /незакоммиченные правки/,
    );
  });

  it("send is refused for a task that is still working", async () => {
    const s = await start(h, "fake/hang");
    await expect(h.service.send(h.sessionId, s.task_id, "more")).rejects.toThrow(
      /send принимает задачи needs_input, done, failed или interrupted; статус running/,
    );
    await h.service.cancel(h.sessionId, s.task_id);
  });
});

describe("TaskService restart and continue (scenario 4)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("marks tasks of a dead hub interrupted and continues them in the same Pi session", async () => {
    const dbFile = join(dir.path, "shared.db");
    const a = makeHarness(dir.path, { dbFile });
    await connect(a);
    const s = await start(a, "fake/hang");
    await new Promise((r) => setTimeout(r, 300));
    const before = a.repos.getTask(s.task_id);
    expect(before?.status).toBe("running");
    expect(before?.pi_session_path).toMatch(/t_0001\.jsonl$/);
    // simulate a crashed hub: the worker dies, the row stays "running"
    process.kill(before?.pid as number, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    a.repos.updateTask(s.task_id, { status: "running", failure_reason: null, finished_at: null });

    const b = makeHarness(dir.path, { dbFile, repo: a.repo });
    b.sessionId = a.sessionId;
    expect(b.service.recover()).toEqual({ interrupted: [s.task_id] });
    expect(b.repos.getTask(s.task_id)?.status).toBe("interrupted");
    // continue with a scenario that finishes: switch the model to fake/success for the retry
    b.repos.updateTask(s.task_id, { model: "fake/success" });
    expect((await b.service.send(a.sessionId, s.task_id, "continue")).status).toBe("running");
    const w = await b.service.waitFor(a.sessionId, s.task_id, 15_000);
    expect(w.status).toBe("done");
    expect(w.summary).toContain("Added hello.txt");
    const log = readFileSync(b.repos.getTask(s.task_id)?.log_path as string, "utf8");
    expect(log).toContain('"command":"switch_session"');
    expect(b.repos.getTask(s.task_id)?.attempt).toBe(2);
    await b.service.shutdown();
    await a.service.shutdown();
  });

  it("shutdown interrupts running tasks", async () => {
    const h = makeHarness(dir.path);
    await connect(h);
    const s = await start(h, "fake/hang");
    await new Promise((r) => setTimeout(r, 200));
    await h.service.shutdown();
    expect(h.repos.getTask(s.task_id)?.status).toBe("interrupted");
  });
});

describe("summary helpers", () => {
  it("extracts and caps the SUMMARY block", () => {
    expect(hasSummaryBlock("text\nSUMMARY:\n- a")).toBe(true);
    expect(hasSummaryBlock("no summary here")).toBe(false);
    expect(extractSummary("blah\n\nSUMMARY:\n- a\n\n- b")).toBe("- a\n- b");
    expect(extractSummary(`SUMMARY:\n${"x".repeat(900)}`).length).toBe(500);
    expect(looksIncomplete("Частично сделано")).toBe(true);
    expect(looksIncomplete("All done")).toBe(false);
  });
});
