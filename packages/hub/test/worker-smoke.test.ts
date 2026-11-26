import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Accounting } from "../src/accounting/accounting.js";
import { defaultExtensionPath } from "../src/assets.js";
import { buildWorkerLaunch } from "../src/pi-rpc/launcher.js";
import { PiExitedError, PiRpcClient } from "../src/pi-rpc/pi-rpc-client.js";
import { migrate, openDatabase } from "../src/storage/db.js";
import { Repos } from "../src/storage/repos.js";
import { writeWorkerPrompt } from "../src/tasks/prompt.js";
import { GitLock } from "../src/workspaces/git.js";
import { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { FAKE_WORKER, initRepo, tempDir } from "./helpers.js";

/**
 * Phase 2 independent check: the fake worker runs a task end to end through the real
 * launcher, RPC client, worktree manager and accounting, without MCP or a task service.
 */
describe("worker smoke (fake worker)", () => {
  let dir: ReturnType<typeof tempDir>;
  let repo: string;
  beforeEach(() => {
    dir = tempDir();
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
  });
  afterEach(() => dir.cleanup());

  async function launch(scenario: string, taskId = "t_0001") {
    const db = openDatabase(":memory:");
    migrate(db);
    const repos = new Repos(db);
    const project = repos.upsertProject(repo, null);
    const session = repos.createSession({
      client: "claude-code",
      parent_pid: 1,
      project_id: project.id,
      mode: "on",
    });
    const task = repos.insertTask({
      owner_session_id: session.id,
      project_id: project.id,
      task_text: "add hello",
      base_branch: "main",
      role: "code",
      model: `fake/${scenario}`,
      routed_by: "architect",
      route_reason: "test",
    });
    const wm = new WorkspaceManager(join(dir.path, "wt"), new GitLock());
    const ws = await wm.create({
      taskId: task.id,
      projectId: project.id,
      repoRoot: repo,
      baseBranch: "main",
    });
    const promptFile = writeWorkerPrompt(join(dir.path, "prompts"), task.id, {
      branch: ws.branch,
      base_branch: "main",
    });
    const spec = buildWorkerLaunch({
      bin: process.execPath,
      binArgs: [FAKE_WORKER],
      provider: "fake",
      modelId: scenario,
      cwd: ws.path,
      sessionDir: join(dir.path, "sessions"),
      taskId,
      extensionPath: defaultExtensionPath(),
      promptFile,
      piAgentDir: join(dir.path, "pi-agent"),
      secrets: {},
    });
    const client = new PiRpcClient(spec);
    const accounting = new Accounting(repos);
    client.on("event", (e) => {
      if (e.kind === "assistant_message") accounting.record(task.id, e.message);
    });
    client.start();
    return { client, accounting, repos, task, ws, wm };
  }

  it("runs a task: commit on pi/t_0001, steps recorded, summary available", async () => {
    const { client, accounting, task, ws, wm } = await launch("success");
    const state = await client.getState();
    expect(state.sessionFile).toMatch(/t_0001\.jsonl$/);
    const settled = client.waitSettled();
    expect((await client.prompt("Create hello.txt")).disposition).toBe("started");
    expect(await settled).toEqual({ aborted: false });
    expect(await client.getLastAssistantText()).toContain("SUMMARY:");
    expect(
      execFileSync("git", ["log", "-1", "--format=%s", "pi/t_0001"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe("Add hello.txt");
    expect(await wm.changedFiles(ws.path, ws.baseCommit)).toEqual(["hello.txt"]);
    const usage = accounting.usage(task.id);
    expect(usage.steps).toBe(1);
    expect(usage.cost).toBeCloseTo(0.001);
    await client.stop(2000);
    expect(client.hasExited).toBe(true);
  });

  it("surfaces a worker crash as PiExitedError with stderr", async () => {
    const { client } = await launch("crash");
    const settled = client.waitSettled();
    await client.prompt("go");
    await expect(settled).rejects.toBeInstanceOf(PiExitedError);
    await expect(settled).rejects.toThrow(/simulated crash/);
  });

  it("aborts a hanging worker and stops it", async () => {
    const { client } = await launch("hang");
    const settled = client.waitSettled();
    await client.prompt("go");
    await client.abort();
    expect(await settled).toEqual({ aborted: true });
    const exit = await client.stop(2000);
    expect(exit.code).toBe(0);
  });
});
