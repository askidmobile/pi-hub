import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultExtensionPath } from "../src/assets.js";
import { listTasks } from "../src/cli/status.js";
import { type DaemonHandle, startDaemon } from "../src/daemon.js";
import { pidAlive } from "../src/tasks/task-service.js";
import { FAKE_WORKER, initRepo, tempDir } from "./helpers.js";

/**
 * Plan phase 4 independent check: the senior's path end to end over real stdio —
 * SDK client -> pi-hub-shim process -> unix socket -> daemon -> fake worker.
 * Needs a build (`pnpm test` builds first): the shim and CLI run from dist.
 */
const SHIM = fileURLToPath(new URL("../../shim/dist/index.js", import.meta.url));
const HUB_CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function writeConfig(home: string, repo: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    JSON.stringify({
      allowed_repos: [git(repo, "rev-parse", "--show-toplevel")],
      roles: { code: { model: "fake/success" } },
      default_role: "code",
      pi: {
        bin: process.execPath,
        bin_args: [FAKE_WORKER],
        extension_path: defaultExtensionPath(),
      },
      clients: { "claude-code": { tool_list: "dynamic", max_wait_sec: 2, progress_every_sec: 1 } },
    }),
  );
}

async function connectClient(home: string, cwd: string, serveCommand?: string[]) {
  const listChanged: number[] = [];
  const client = new Client({ name: "test-senior", version: "0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged.push(Date.now());
  });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PI_HUB_HOME: home,
    PI_HUB_PROJECT_DIR: cwd,
  };
  if (serveCommand) env.PI_HUB_SERVE_COMMAND = JSON.stringify(serveCommand);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SHIM, "--client", "claude-code"],
      env,
      cwd,
    }),
  );
  return { client, listChanged };
}

const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
const parse = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { text: string }[])[0]?.text ?? "";
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

describe("MCP over shim with an in-process daemon", () => {
  let dir: ReturnType<typeof tempDir>;
  let home: string;
  let repo: string;
  let hub: DaemonHandle;
  const clients: Client[] = [];
  beforeEach(async () => {
    dir = tempDir();
    home = join(dir.path, "h");
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    writeConfig(home, repo);
    hub = await startDaemon({ PI_HUB_HOME: home });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await hub.close();
    dir.cleanup();
  });

  it("scenario 2 + 1: only architect_mode until on, then list_changed, start/wait/result, merge", async () => {
    const { client, listChanged } = await connectClient(home, repo);
    clients.push(client);
    expect(await toolNames(client)).toEqual(["architect_mode"]);
    const refused = await client.callTool({
      name: "start",
      arguments: { task: "x", repo, base_branch: "main" },
    });
    expect(refused.isError).toBe(true);
    expect(
      parse(await client.callTool({ name: "architect_mode", arguments: { mode: "on" } })),
    ).toEqual({ mode: "on", running_tasks: [] });
    expect(await until(() => listChanged.length > 0)).toBe(true);
    expect(await toolNames(client)).toEqual([
      "architect_mode",
      "cancel",
      "result",
      "send",
      "start",
      "status",
      "wait",
    ]);

    const s = parse(
      await client.callTool({
        name: "start",
        arguments: { task: "Create hello.txt", repo, base_branch: "main" },
      }),
    );
    expect(s).toMatchObject({
      task_id: "t_0001",
      model: "fake/success",
      route_reason: "default_role code -> fake/success",
    });
    let w = parse(
      await client.callTool({ name: "wait", arguments: { task_id: s.task_id, timeout: 60 } }),
    );
    for (let i = 0; i < 5 && w.status !== "done"; i++) {
      w = parse(
        await client.callTool({ name: "wait", arguments: { task_id: s.task_id, timeout: 60 } }),
      );
    }
    expect(w.status).toBe("done");
    expect(w.cost_line).toContain("SKIPPED");
    const env = parse(await client.callTool({ name: "result", arguments: { task_id: s.task_id } }));
    expect(env).toMatchObject({
      status: "done",
      branch: "pi/t_0001",
      changed_files: ["hello.txt"],
    });
    expect(parse(await client.callTool({ name: "status", arguments: {} })).tasks).toHaveLength(1);
    git(repo, "merge", "-q", "--no-edit", "pi/t_0001");
    expect(existsSync(join(repo, "hello.txt"))).toBe(true);

    const off = parse(
      await client.callTool({ name: "architect_mode", arguments: { mode: "off" } }),
    );
    expect(off.mode).toBe("off");
    await until(() => listChanged.length > 1);
    expect(await toolNames(client)).toEqual(["architect_mode"]);
  });

  it("off with a running task refuses new starts; the task survives the client closing", async () => {
    const { client } = await connectClient(home, repo);
    clients.push(client);
    await client.callTool({ name: "architect_mode", arguments: { mode: "on" } });
    const s = parse(
      await client.callTool({
        name: "start",
        arguments: { task: "x", model: "fake/hang", repo, base_branch: "main" },
      }),
    );
    const off = parse(
      await client.callTool({ name: "architect_mode", arguments: { mode: "off" } }),
    );
    expect(off.running_tasks).toEqual([s.task_id]);
    const refused = await client.callTool({
      name: "start",
      arguments: { task: "y", repo, base_branch: "main" },
    });
    // Dynamic tool list: the SDK refuses the disabled tool before the hub sees the call.
    expect(refused.isError).toBe(true);

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await new Promise((r) => setTimeout(r, 300));
    const [row] = listTasks({ PI_HUB_HOME: home });
    expect(row).toMatchObject({ id: s.task_id, status: "running" });
    expect(row?.pid && pidAlive(row.pid)).toBe(true);
  });

  it("wait returns running at the client cap and sends progress (ADR-0006)", async () => {
    const { client } = await connectClient(home, repo);
    clients.push(client);
    await client.callTool({ name: "architect_mode", arguments: { mode: "on" } });
    const s = parse(
      await client.callTool({
        name: "start",
        arguments: { task: "x", model: "fake/hang", repo, base_branch: "main" },
      }),
    );
    const progress: unknown[] = [];
    const t0 = Date.now();
    const w = parse(
      await client.callTool(
        { name: "wait", arguments: { task_id: s.task_id, timeout: 600 } },
        undefined,
        {
          onprogress: (p) => progress.push(p),
          resetTimeoutOnProgress: true,
        },
      ),
    );
    const took = Date.now() - t0;
    expect(w).toMatchObject({ status: "running", hint: "still running: call wait again" });
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(5000);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(
      parse(await client.callTool({ name: "cancel", arguments: { task_id: s.task_id } })).status,
    ).toBe("cancelled");
  });

  it("project delegation = on shows all tools at once; errors are short tool errors", async () => {
    writeFileSync(join(repo, ".pi-hub.toml"), 'delegation = "on"\n');
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "enable pi-hub");
    const { client } = await connectClient(home, repo);
    clients.push(client);
    expect(await toolNames(client)).toHaveLength(7);
    const bad = await client.callTool({
      name: "start",
      arguments: { task: "x", repo, base_branch: "nope" },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("ветка nope не найдена");
    const missing = await client.callTool({ name: "result", arguments: { task_id: "t_9999" } });
    expect(text(missing)).toContain("не найдена");
  });

  it("rejects an incompatible protocol version with a clear message", async () => {
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(hub.paths.socket, () => {
        s.write(
          `${JSON.stringify({ type: "hello", protocol_version: "9.0.0", client: "mcp", parent_pid: 1, pid: 2, cwd: repo })}\n`,
        );
      });
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\n")) {
          s.destroy();
          resolve(buf);
        }
      });
    });
    expect(JSON.parse(reply)).toMatchObject({
      type: "hello_reject",
      reason: "incompatible_protocol",
    });
    expect(reply).toContain("update the hub");
  });
});

describe("shim autostart and stub", () => {
  let dir: ReturnType<typeof tempDir>;
  let home: string;
  let repo: string;
  beforeEach(() => {
    dir = tempDir();
    home = join(dir.path, "h");
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    writeConfig(home, repo);
  });
  afterEach(() => dir.cleanup());

  it("two shims at once start exactly one daemon (FR-002)", async () => {
    const serve = [process.execPath, HUB_CLI, "serve"];
    const [a, b] = await Promise.all([
      connectClient(home, repo, serve),
      connectClient(home, repo, serve),
    ]);
    try {
      expect(await toolNames(a.client)).toEqual(["architect_mode"]);
      expect(await toolNames(b.client)).toEqual(["architect_mode"]);
      const pid = Number(readFileSync(join(home, "hub.lock"), "utf8"));
      expect(pidAlive(pid)).toBe(true);
      const log = readFileSync(join(home, "logs", "hub.log"), "utf8");
      expect(log.match(/"pi-hub listening"/g)).toHaveLength(1);
      await a.client.close();
      await b.client.close();
      expect(pidAlive(pid)).toBe(true); // the daemon outlives its clients
      process.kill(pid, "SIGTERM");
      expect(await until(() => !pidAlive(pid), 5000)).toBe(true);
      expect(existsSync(join(home, "hub.sock"))).toBe(false);
    } finally {
      await a.client.close().catch(() => undefined);
      await b.client.close().catch(() => undefined);
    }
  });

  it("serves a stub within 5 s when the hub cannot start", async () => {
    const t0 = Date.now();
    const { client } = await connectClient(home, repo, ["/usr/bin/false"]);
    try {
      expect(await toolNames(client)).toEqual(["architect_mode"]);
      expect(Date.now() - t0).toBeLessThan(5000);
      const r = await client.callTool({ name: "architect_mode", arguments: { mode: "on" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("pi-hub недоступен");
    } finally {
      await client.close();
    }
  });
});

/** Runs `pi-hub-shim hook stop` like Claude Code does: hook JSON on stdin, decision on stdout. */
function runHook(
  home: string,
  input: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM, "hook", "stop"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PI_HUB_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** Stage 2 plan phase 5 independent check: a worker question reaches the senior three ways. */
describe("worker questions over shim (stage 2)", () => {
  let dir: ReturnType<typeof tempDir>;
  let home: string;
  let repo: string;
  let hub: DaemonHandle | undefined;
  const clients: Client[] = [];
  beforeEach(async () => {
    dir = tempDir();
    home = join(dir.path, "h");
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    writeConfig(home, repo);
    hub = await startDaemon({ PI_HUB_HOME: home });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await hub?.close();
    dir.cleanup();
  });

  const startAsk = async (client: Client) => {
    await client.callTool({ name: "architect_mode", arguments: { mode: "on" } });
    const s = parse(
      await client.callTool({
        name: "start",
        arguments: { task: "x", model: "fake/ask", repo, base_branch: "main" },
      }),
    );
    let w = parse(
      await client.callTool({ name: "wait", arguments: { task_id: s.task_id, timeout: 60 } }),
    );
    for (let i = 0; i < 5 && w.status !== "needs_input"; i++) {
      w = parse(
        await client.callTool({ name: "wait", arguments: { task_id: s.task_id, timeout: 60 } }),
      );
    }
    return { taskId: s.task_id as string, w };
  };
  const pending = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    (r.content as { text: string }[]).slice(1).map((c) => c.text);

  it("wait, the line in every response and the Stop hook (once); another session sees nothing", async () => {
    const { client } = await connectClient(home, repo);
    clients.push(client);
    const { taskId, w } = await startAsk(client);
    // 1. wait
    expect(w).toMatchObject({
      status: "needs_input",
      question: {
        round: 1,
        question: "Which storage should sessions use?",
        options: ["A: Redis", "B: database table"],
      },
      hint: "the worker waits: answer with send(task_id, answer)",
    });
    // 2. the line in any response
    expect(pending(await client.callTool({ name: "status", arguments: {} }))).toEqual([
      `ожидают ответа: ${taskId} (1 вопрос) — ответьте через send`,
    ]);
    // 3. the hook: not while Claude Code already continues, then once, then never again
    expect((await runHook(home, { cwd: repo, stop_hook_active: true })).stdout).toBe("");
    const blocked = await runHook(home, { cwd: repo, stop_hook_active: false });
    expect(blocked.code).toBe(0);
    const decision = JSON.parse(blocked.stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain(`${taskId}: Which storage should sessions use?`);
    expect((await runHook(home, { cwd: repo, stop_hook_active: false })).stdout).toBe("");

    // a second session of the same project does not see the question
    const other = await connectClient(home, repo);
    clients.push(other.client);
    await other.client.callTool({ name: "architect_mode", arguments: { mode: "on" } });
    expect(pending(await other.client.callTool({ name: "status", arguments: {} }))).toEqual([]);

    expect(
      parse(await client.callTool({ name: "send", arguments: { task_id: taskId, message: "B" } })),
    ).toMatchObject({ status: "running" });
    let done = parse(
      await client.callTool({ name: "wait", arguments: { task_id: taskId, timeout: 60 } }),
    );
    for (let i = 0; i < 5 && done.status !== "done"; i++) {
      done = parse(
        await client.callTool({ name: "wait", arguments: { task_id: taskId, timeout: 60 } }),
      );
    }
    expect(done.status).toBe("done");
    expect(pending(await client.callTool({ name: "status", arguments: {} }))).toEqual([]);
    const log = readFileSync(join(home, "logs", "hooks.log"), "utf8");
    expect(log).toContain('"decision":"block"');
    expect(log).toContain('"why":"stop_hook_active"');
  });

  it("the hook does not block with mode off, or when the hub is down, and stays fast (FR-110)", {
    timeout: 15_000,
  }, async () => {
    const { client } = await connectClient(home, repo);
    clients.push(client);
    await startAsk(client);
    await client.callTool({ name: "architect_mode", arguments: { mode: "off" } });
    expect((await runHook(home, { cwd: repo })).stdout).toBe("");
    await client.callTool({ name: "architect_mode", arguments: { mode: "on" } });

    const times: number[] = [];
    for (let i = 0; i < 20; i++) times.push((await runHook(home, { cwd: repo })).ms);
    times.sort((a, b) => a - b);
    // p95 of the whole process, Node start included
    expect(times[18]).toBeLessThanOrEqual(100);

    // the daemon waits for open connections on close: disconnect the senior first
    await client.close();
    clients.splice(0);
    await hub?.close();
    hub = undefined;
    const downTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const down = await runHook(home, { cwd: repo });
      expect(down).toMatchObject({ code: 0, stdout: "" });
      downTimes.push(down.ms);
    }
    downTimes.sort((a, b) => a - b);
    expect(downTimes[18]).toBeLessThanOrEqual(100);
    expect(readFileSync(join(home, "logs", "hooks.log"), "utf8")).toContain('"source":"shim"');
  });

  it("an incompatible protocol version gets no block", async () => {
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(join(home, "hub.sock"));
      let buf = "";
      s.on("connect", () =>
        s.write(
          `${JSON.stringify({ type: "hook_query", protocol_version: "9.0.0", event: "stop", client: "claude-code", pid: process.pid, cwd: repo })}\n`,
        ),
      );
      s.on("data", (b) => {
        buf += b.toString();
      });
      s.on("close", () => resolve(buf.trim()));
    });
    expect(JSON.parse(reply)).toEqual({ type: "hook_reply", block: false });
  });
});
