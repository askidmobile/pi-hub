import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_COMMANDS_ISSUE } from "../src/quality/quality-gate.js";
import { SECOND_TRY_WARNING } from "../src/tasks/worker-runner.js";
import { tempDir } from "./helpers.js";
import { connect, type Harness, makeHarness, start } from "./task-harness.js";

/** Stage 2 scenario 4 on the TaskService level: quality gate and the fix round. */
describe("TaskService quality gate (fake worker)", () => {
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

  const project = (toml: string) => writeFileSync(join(h.repo, ".pi-hub.toml"), toml);
  /** The check fails while broken.txt exists (fake worker quality scenarios). */
  const brokenCheck = () =>
    project(
      '[quality]\ntest = "test ! -f broken.txt || { echo error: broken.txt found; exit 1; }"\n',
    );
  const run = async (model: string) => {
    const s = await start(h, model);
    const w = await h.service.waitFor(h.sessionId, s.task_id, 20_000);
    return { id: s.task_id, w, env: await h.service.result(h.sessionId, s.task_id) };
  };

  it("PASS when every command exits 0", async () => {
    project('[quality]\ntest = "true"\nlint = "echo lint ok"\n');
    const { w, env } = await run("fake/success");
    expect(w.status).toBe("done");
    expect(w.cost_line).toContain("PASS");
    expect(env.quality).toMatchObject({ status: "PASS", issues: [] });
    expect(existsSync(env.quality.log_path as string)).toBe(true);
  });

  it("SKIPPED with a note when no commands are set", async () => {
    const { env } = await run("fake/success");
    expect(env.quality).toEqual({ status: "SKIPPED", issues: [NO_COMMANDS_ISSUE] });
  });

  it("FAIL -> automatic fix round -> PASS with a warning (FR-113)", async () => {
    brokenCheck();
    const { env } = await run("fake/quality-fix");
    expect(env.status).toBe("done");
    expect(env.quality).toMatchObject({ status: "PASS", issues: [] });
    expect(env.warnings).toContain(SECOND_TRY_WARNING);
    const log = readFileSync(env.quality.log_path as string, "utf8");
    expect(log).toContain("=== attempt 1.1 · test:");
    expect(log).toContain("=== attempt 1.2 · test:");
    expect(env.changed_files).toEqual(["hello.txt"]);
  });

  it("FAIL twice is final: issues with the command, full output in the log", async () => {
    brokenCheck();
    const { env } = await run("fake/quality-broken");
    expect(env.status).toBe("done");
    expect(env.quality.status).toBe("FAIL");
    expect(env.quality.issues).toEqual(["test: код 1", "test: error: broken.txt found"]);
    expect(readFileSync(env.quality.log_path as string, "utf8")).toContain("=== attempt 1.2");
  });

  it("send on done after FAIL reworks and checks again (scenario 4, FR-105)", async () => {
    brokenCheck();
    const first = await run("fake/quality-broken");
    expect(first.env.quality.status).toBe("FAIL");
    h.repos.updateTask(first.id, { model: "fake/quality-fix" });
    await h.service.send(h.sessionId, first.id, "The quality check failed: remove broken.txt");
    const w = await h.service.waitFor(h.sessionId, first.id, 20_000);
    expect(w.status).toBe("done");
    const env = await h.service.result(h.sessionId, first.id);
    expect(env.quality.status).toBe("PASS");
    expect(env.attempt).toBe(2);
    expect(readFileSync(env.quality.log_path as string, "utf8")).toContain(
      "=== attempt 2.1 · test:",
    );
  });

  it("errors that fail on the base: no fix round, the base result is reused (FR-119)", async () => {
    const counter = join(dir.path, "runs");
    project(`[quality]\ntest = "echo run >> ${counter}; test -f required.txt"\n`);
    const a = await run("fake/success");
    expect(a.env.quality.status).toBe("FAIL");
    expect(a.env.quality.issues[0]).toMatch(/^test: падало до задачи: /);
    expect(readFileSync(a.env.quality.log_path as string, "utf8")).not.toContain("attempt 1.2");
    await run("fake/empty-diff");
    // base once + one check per task
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("a skipped test is reported even when the check passes (FR-121)", async () => {
    project('[quality]\ntest = "true"\n');
    const { env } = await run("fake/skip-test");
    expect(env.quality.status).toBe("PASS");
    expect(env.warnings).toContain("изменены или отключены тесты: src/math.test.ts");
  });
});
