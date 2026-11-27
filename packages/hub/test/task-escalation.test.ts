import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { escalationWarning, nextModel } from "../src/router/escalation.js";
import { escalationMessage } from "../src/tasks/prompt.js";
import { tempDir } from "./helpers.js";
import { connect, git, type Harness, makeHarness, start } from "./task-harness.js";

describe("nextModel (stage 3 FR-202, FR-203)", () => {
  const config = {
    roles: { code: { model: "a/x", escalate: ["a/y", "a/z"] }, docs: { model: "a/d" } },
  };
  const run = (model: string, routed_by: "rules" | "architect" | "escalation" = "rules") => ({
    model,
    routed_by,
  });

  it("walks the role's chain, skipping models that already ran", () => {
    expect(nextModel({ role: "code" }, [run("a/x")], config)).toBe("a/y");
    expect(nextModel({ role: "code" }, [run("a/x"), run("a/y", "escalation")], config)).toBe("a/z");
    expect(
      nextModel({ role: "code" }, [run("a/x"), run("a/y"), run("a/z", "escalation")], config),
    ).toBe(null);
  });

  it("never escalates a model chosen by the architect, a role without a chain or no runs", () => {
    expect(nextModel({ role: "code" }, [run("a/x", "architect")], config)).toBe(null);
    expect(nextModel({ role: "docs" }, [run("a/d")], config)).toBe(null);
    expect(nextModel({ role: "gone" }, [run("a/x")], config)).toBe(null);
    expect(nextModel({ role: null }, [run("a/x")], config)).toBe(null);
    expect(nextModel({ role: "code" }, [], config)).toBe(null);
  });

  it("the escalation message carries the task, the previous summary and the issues", () => {
    const m = escalationMessage("Add login", "- added form", ["test: код 1"], "/l/q.log");
    expect(m.startsWith("ESCALATION:")).toBe(true);
    expect(m).toContain("TASK:\nAdd login");
    expect(m).toContain("PREVIOUS MODEL SUMMARY:\n- added form");
    expect(m).toContain("- test: код 1\nFull output: /l/q.log");
    expect(escalationWarning("a/x", "a/y")).toBe("эскалировано: a/x → a/y (FAIL после авто-круга)");
  });
});

/** Stage 3 scenario 2 on the TaskService level: the check fails while broken.txt exists. */
describe("escalation (fake worker)", () => {
  let dir: ReturnType<typeof tempDir> | undefined;
  let h: Harness;
  afterEach(async () => {
    await h?.service.shutdown();
    dir?.cleanup();
  });

  const setup = async (escalate: string[], first = "fake/quality-broken") => {
    dir = tempDir();
    h = makeHarness(dir.path, { roles: { code: { model: first, escalate } } });
    await connect(h);
    writeFileSync(
      join(h.repo, ".pi-hub.toml"),
      '[quality]\ntest = "test ! -f broken.txt || { echo error: broken.txt found; exit 1; }"\n',
    );
  };
  const finish = async (id: string) => {
    const w = await h.service.waitFor(h.sessionId, id, 30_000);
    return { w, env: await h.service.result(h.sessionId, id) };
  };

  it("FAIL after the fix round continues the same task on the next model (FR-202, FR-204)", async () => {
    await setup(["fake/quality-fix"]);
    const s = await start(h, null);
    const { w, env } = await finish(s.task_id);
    expect(w.status).toBe("done");
    expect(env.quality.status).toBe("PASS");
    expect(env.models).toEqual(["fake/quality-broken", "fake/quality-fix"]);
    expect(env.warnings).toContain(escalationWarning("fake/quality-broken", "fake/quality-fix"));
    // the same branch: the weak model's commit and the fix are both on it
    const log = git(h.repo, "log", "--format=%s", `main..${env.branch}`);
    expect(log).toContain("Remove broken.txt");
    expect(log).toContain("Add hello.txt and broken.txt");
    // cost covers the steps of both models
    const models = h.repos
      .modelRuns(s.task_id)
      .map((r) => [r.seq, r.model, r.routed_by, r.quality]);
    expect(models).toEqual([
      [1, "fake/quality-broken", "rules", "FAIL"],
      [2, "fake/quality-fix", "escalation", "PASS"],
    ]);
    const task = h.repos.getTask(s.task_id);
    expect(task).toMatchObject({ model: "fake/quality-fix", routed_by: "escalation" });
    expect(task?.first_try_pass).toBe(0);
    const steps = h.repos.usageCostBy("model", { since: null }).map((r) => r.key);
    expect(steps.sort()).toEqual(["fake/quality-broken", "fake/quality-fix"]);
    expect(readFileSync(env.quality.log_path as string, "utf8")).toContain("=== attempt 1.3 ·");
  });

  it("a used-up chain ends done with FAIL, as in stage 2", async () => {
    await setup(["fake/quality-broken:again"]);
    const s = await start(h, null);
    const { w, env } = await finish(s.task_id);
    expect(w.status).toBe("done");
    expect(env.quality.status).toBe("FAIL");
    expect(env.models).toEqual(["fake/quality-broken", "fake/quality-broken:again"]);
    expect(h.repos.modelRuns(s.task_id).map((r) => r.quality)).toEqual(["FAIL", "FAIL"]);
  });

  it("no escalation for a model set by the architect (D-211)", async () => {
    await setup(["fake/quality-fix"]);
    const a = await start(h, "fake/quality-broken");
    const env = (await finish(a.task_id)).env;
    expect(env.quality.status).toBe("FAIL");
    expect(env.models).toEqual(["fake/quality-broken"]);
    expect(env.warnings.some((x) => x.startsWith("эскалировано"))).toBe(false);
  });

  it("no escalation when every failure was on the base (FR-203)", async () => {
    await setup(["fake/quality-fix"]);
    writeFileSync(join(h.repo, ".pi-hub.toml"), '[quality]\ntest = "test -f required.txt"\n');
    const b = await start(h, null);
    const env = (await finish(b.task_id)).env;
    expect(env.quality.issues[0]).toMatch(/падало до задачи/);
    expect(env.models).toEqual(["fake/quality-broken"]);
  });

  it("send on done reworks on the last model without escalating (FR-203)", async () => {
    await setup(["fake/quality-fix", "fake/quality-fix:spare"]);
    const s = await start(h, null);
    expect((await finish(s.task_id)).env.quality.status).toBe("PASS");
    // the rework runs on a model that breaks the check again; the chain still has a model
    h.repos.updateTask(s.task_id, { model: "fake/quality-broken" });
    await h.service.send(h.sessionId, s.task_id, "Add broken.txt back");
    const { env } = await finish(s.task_id);
    expect(env.quality.status).toBe("FAIL");
    expect(env.attempt).toBe(2);
    expect(h.repos.modelRuns(s.task_id)).toHaveLength(2);
    expect(env.warnings.some((x) => x.startsWith("эскалировано"))).toBe(false);
  });

  it("cancel during the escalated model keeps the branch", async () => {
    await setup(["fake/hang"]);
    const s = await start(h, null);
    const deadline = Date.now() + 20_000;
    while (h.repos.getTask(s.task_id)?.model !== "fake/hang" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(h.repos.getTask(s.task_id)?.model).toBe("fake/hang");
    await h.service.cancel(h.sessionId, s.task_id);
    const task = h.repos.getTask(s.task_id);
    expect(task?.status).toBe("cancelled");
    const runs = h.repos.modelRuns(s.task_id);
    expect(runs.map((r) => [r.model, r.quality])).toEqual([
      ["fake/quality-broken", "FAIL"],
      ["fake/hang", null],
    ]);
    expect(runs[1]?.finished_at).toBeTruthy();
    expect(git(h.repo, "branch", "--list", task?.branch as string)).toContain(task?.branch);
  });

  it("first-try PASS is 1 on a clean pass and unknown without check commands (D-215)", async () => {
    await setup([], "fake/success");
    writeFileSync(join(h.repo, ".pi-hub.toml"), '[quality]\ntest = "true"\n');
    const a = await start(h, null);
    await finish(a.task_id);
    expect(h.repos.getTask(a.task_id)?.first_try_pass).toBe(1);
    writeFileSync(join(h.repo, ".pi-hub.toml"), "");
    const b = await start(h, "fake/empty-diff");
    await finish(b.task_id);
    expect(h.repos.getTask(b.task_id)?.first_try_pass).toBe(null);
  });
});
