#!/usr/bin/env node
/**
 * Stage gates on a real Pi and a real model (stage 1 plan PD-002, stage 2 plan phase 6): run
 * by hand before closing a stage and after a Pi upgrade. Not in CI: it needs a provider and
 * costs a few cents.
 *
 *   pnpm build && pnpm e2e --model <provider>/<id> [--extension <path>]... [--scenario ask] [--keep]
 *
 * `--scenario basic` (default, stage 1): start -> wait -> result -> merge.
 * `--router` (stage 3): two roles with descriptions and the System One preset 9router; `start`
 * goes without a role, the smart router must pick `code`; the request is a router step in
 * `usage_report`. The key `NINEROUTER_API_KEY` comes from the environment or ~/.pi-hub/.env.
 * `--scenario ask` (stage 2): the worker must ask with `ask`; `wait` returns the question, the
 * pending line is in the next response, `send` answers it; the quality command from
 * `.pi-hub.toml` gives the verdict. Then the cost line without a manual price, and a second
 * small task with a price in `prices.yaml`.
 *
 * A temp git repo and a separate PI_HUB_HOME; an SDK MCP client talks to the hub through
 * the real pi-hub-shim (which starts the daemon): architect_mode on -> start -> wait ->
 * result -> git merge. The provider key comes from the environment or ~/.pi-hub/.env and is
 * copied only into the temp hub's .env. At the end the temp hub and repo are searched for it.
 *
 * Erasable TypeScript only: Node runs it directly.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HUB_DIST = join(ROOT, "packages/hub/dist");
const SHIM = join(ROOT, "packages/shim/dist/index.js");
const requireFromHub = createRequire(join(ROOT, "packages/hub/package.json"));

async function fromHub<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(requireFromHub.resolve(specifier)).href)) as T;
}

type Scenario = "basic" | "ask";

function args(): { model: string; extensions: string[]; keep: boolean; scenario: Scenario } {
  const argv = process.argv.slice(2);
  const extensions: string[] = [];
  let model = process.env.PI_HUB_E2E_MODEL ?? "";
  let router = false;
  let keep = false;
  let scenario: Scenario = "basic";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") model = argv[++i] ?? "";
    else if (a === "--extension") extensions.push(resolve(argv[++i] ?? ""));
    else if (a === "--keep") keep = true;
    else if (a === "--router") router = true;
    else if (a === "--scenario") scenario = argv[++i] === "ask" ? "ask" : "basic";
  }
  if (!/^[^/\s]+\/\S+$/.test(model)) {
    console.error(
      "usage: pnpm e2e --model <provider>/<id> [--extension <path>]... [--scenario ask] [--router] [--keep]",
    );
    process.exit(2);
  }
  return { model, extensions, keep, scenario, router };
}

function step(msg: string): void {
  console.log(`\n▶ ${msg}`);
}

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
}

/** Every file under `dir` (except `skip`) that contains `needle`. */
function filesContaining(dir: string, needle: string, skip: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (skip.includes(p)) continue;
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

async function main(): Promise<void> {
  const { model, extensions, keep, scenario, router } = args();
  if (!existsSync(SHIM) || !existsSync(join(HUB_DIST, "cli/main.js"))) {
    console.error("build first: pnpm build");
    process.exit(2);
  }
  const { providerKeyEnv } = await fromHub<
    typeof import("../packages/hub/src/pi-rpc/provider-env.ts")
  >("./dist/pi-rpc/provider-env.js");
  const { loadSecrets } =
    await fromHub<typeof import("../packages/hub/src/config/load.ts")>("./dist/config/load.js");
  const { Client } = await fromHub<typeof import("@modelcontextprotocol/sdk/client/index.js")>(
    "@modelcontextprotocol/sdk/client/index.js",
  );
  const { StdioClientTransport } = await fromHub<
    typeof import("@modelcontextprotocol/sdk/client/stdio.js")
  >("@modelcontextprotocol/sdk/client/stdio.js");

  const tmp = mkdtempSync(join(tmpdir(), "pihub-e2e-"));
  const home = join(tmp, "h");
  const repo = join(tmp, "repo");
  const provider = model.split("/")[0] as string;
  const keyVar = providerKeyEnv(provider);
  const key = keyVar
    ? (process.env[keyVar] ?? loadSecrets(join(homedir(), ".pi-hub/.env")).values[keyVar])
    : undefined;
  if (keyVar && !key) {
    console.error(`no ${keyVar} in the environment or ~/.pi-hub/.env`);
    process.exit(2);
  }
  const ROUTER_KEY = "NINEROUTER_API_KEY";
  const routerKey = router
    ? (process.env[ROUTER_KEY] ?? loadSecrets(join(homedir(), ".pi-hub/.env")).values[ROUTER_KEY])
    : undefined;
  if (router && !routerKey) {
    console.error(`--router: no ${ROUTER_KEY} in the environment or ~/.pi-hub/.env`);
    process.exit(2);
  }

  let client: InstanceType<typeof Client> | undefined;
  let ok = false;
  try {
    step(`temp hub ${home}, model ${model}`);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "pi-hub e2e");
    git(repo, "config", "user.email", "e2e@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "# e2e\n");
    if (scenario === "ask") {
      // passes on the base and when every .txt file the worker adds is not empty
      writeFileSync(
        join(repo, ".pi-hub.toml"),
        `[quality]\ntest = "test -z \\"$(find . -name '*.txt' -empty -not -path './.git/*')\\""\ntimeout_minutes = 2\n`,
      );
    }
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const repoRoot = git(repo, "rev-parse", "--show-toplevel");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "config.yaml"),
      JSON.stringify({
        allowed_repos: [repoRoot],
        roles: router
          ? {
              code: { model, description: "writing or changing code and its tests" },
              docs: { model, description: "documentation only: README and docs, no code" },
            }
          : { code: { model } },
        default_role: router ? "docs" : "code",
        ...(router ? { router: { smart: true, system_one: { preset: "9router" } } } : {}),
        pi: { extensions },
        limits: { max_task_minutes: 15, max_task_usd: 0.5 },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, ".env"),
      (keyVar && key ? `${keyVar}=${key}\n` : "") +
        (routerKey ? `${ROUTER_KEY}=${routerKey}\n` : ""),
      { mode: 0o600 },
    );

    step("pi-hub doctor");
    const doctorEnv = { ...process.env, PI_HUB_HOME: home };
    console.log(
      execFileSync(process.execPath, [join(HUB_DIST, "cli/main.js"), "doctor"], {
        env: doctorEnv,
        encoding: "utf8",
      }),
    );

    step("connect through pi-hub-shim (starts the daemon)");
    client = new Client({ name: "pi-hub-e2e", version: "0" });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PI_HUB_HOME: home,
      PI_HUB_PROJECT_DIR: repoRoot,
      PI_HUB_SERVE_COMMAND: JSON.stringify([
        process.execPath,
        join(HUB_DIST, "cli/main.js"),
        "serve",
      ]),
    };
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SHIM, "--client", "claude-code"],
        env,
      }),
    );
    /** The JSON of a tool response; later text items (the pending questions line) go to `pending`. */
    let pending: string[] = [];
    const call = async (name: string, a: Record<string, unknown> = {}) => {
      const res = (await client?.callTool({ name, arguments: a }, undefined, {
        timeout: 1_600_000,
        resetTimeoutOnProgress: true,
        onprogress: (p) => console.log(`  … ${p.message ?? p.progress}`),
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      if (res.isError) throw new Error(`${name}: ${res.content.map((c) => c.text).join(" ")}`);
      pending = res.content.slice(1).map((c) => c.text);
      return JSON.parse(res.content[0]?.text ?? "null") as Record<string, unknown>;
    };
    const waitUntil = async (taskId: string, stop: (status: string) => boolean) => {
      let w: Record<string, unknown> = {};
      for (let i = 0; i < 6; i++) {
        w = await call("wait", { task_id: taskId, timeout: 600 });
        console.log(`  ${taskId}: ${String(w.status)}`);
        if (stop(w.status as string)) break;
      }
      return w;
    };
    const check = (cond: unknown, message: string) => {
      if (!cond) throw new Error(message);
      console.log(`  ✓ ${message}`);
    };

    const before = (await client.listTools()).tools.map((t) => t.name);
    console.log(`  tools while off: ${before.join(", ")}`);
    console.log(`  ${JSON.stringify(await call("architect_mode", { mode: "on" }))}`);

    if (scenario === "ask") {
      step("start (the worker must ask)");
      const started = await call("start", {
        task:
          "Create a text file containing the line `hello` and commit it. Before creating it you " +
          "MUST call the `ask` tool to ask the architect what to name the file (offer options " +
          "a.txt and b.txt). Use the answer. Do not change anything else.",
        repo: repoRoot,
        base_branch: "main",
      });
      const taskId = started.task_id as string;
      console.log(`  ${JSON.stringify(started)}`);

      step("wait -> needs_input");
      const w = await waitUntil(taskId, (st) => st !== "running" && st !== "queued");
      console.log(`  ${JSON.stringify(w.question)}`);
      check(w.status === "needs_input", "wait returned needs_input");
      check(
        (w.question as { question?: string } | undefined)?.question,
        "wait carries the question",
      );
      await call("status");
      check(pending[0]?.startsWith(`ожидают ответа: ${taskId}`), `pending line: ${pending[0]}`);

      step("send the answer");
      console.log(
        `  ${JSON.stringify(await call("send", { task_id: taskId, message: "Name the file answer.txt" }))}`,
      );
      const done = await waitUntil(
        taskId,
        (st) => st !== "running" && st !== "checking" && st !== "queued",
      );
      console.log(`  cost: ${String(done.cost_line)}`);
      check(done.status === "done", "task done after the answer");
      check(pending.length === 0, "no pending line after the answer");

      step("result");
      const result = await call("result", { task_id: taskId });
      console.log(JSON.stringify(result, null, 2));
      const quality = result.quality as { status: string };
      check(quality.status === "PASS", `quality ${quality.status} from .pi-hub.toml`);
      check(
        JSON.stringify(result.questions) === JSON.stringify({ asked: 1, answered: 1 }),
        "one question asked and answered",
      );
      const branch = result.branch as string;
      check(git(repoRoot, "show", `${branch}:answer.txt`) === "hello", "answer.txt on the branch");
      const unknown = (result.usage as { unknown_price_steps?: number }).unknown_price_steps;
      console.log(
        unknown
          ? `  cost line says the price is unknown (${unknown} steps): ${String(done.cost_line)}`
          : `  the provider or Pi's catalog priced every step: ${String(done.cost_line)}`,
      );

      step("second task with a manual price in prices.yaml");
      writeFileSync(
        join(home, "prices.yaml"),
        `- { provider: ${provider}, model: "${model.slice(provider.length + 1)}", input: 0.3, output: 1.2 }\n`,
      );
      const second = await call("start", {
        task: "Create a file second.txt containing exactly the line `second` and commit it.",
        repo: repoRoot,
        base_branch: "main",
      });
      const w2 = await waitUntil(
        second.task_id as string,
        (st) => st === "done" || st === "failed",
      );
      console.log(`  cost: ${String(w2.cost_line)}`);
      check(w2.status === "done", "second task done");
      check(!/^цена неизвестна/.test(String(w2.cost_line)), "the second task has a price");
    } else {
      step("start");
      const started = await call("start", {
        task:
          "Create a file hello.txt containing exactly the line `hello from pi-hub` and commit it. " +
          "Do not change anything else.",
        repo: repoRoot,
        base_branch: "main",
      });
      const taskId = started.task_id as string;
      console.log(`  ${JSON.stringify(started)}`);
      if (router) {
        // default_role is docs: only System One can route this task to code
        check(
          String(started.route_reason).startsWith("system_one: role code"),
          `smart router: ${String(started.route_reason)}`,
        );
      }

      step("wait");
      let status = "";
      for (let i = 0; i < 6; i++) {
        const w = await call("wait", { task_id: taskId, timeout: 600 });
        status = w.status as string;
        console.log(`  ${taskId}: ${status}`);
        if (status !== "running" && status !== "queued" && status !== "planning") break;
      }

      step("result");
      const result = await call("result", { task_id: taskId });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "done") throw new Error(`task ended ${String(result.status)}`);

      step("git merge");
      const branch = result.branch as string;
      git(repoRoot, "merge", "--no-ff", "-q", "-m", `merge ${branch}`, branch);
      const hello = readFileSync(join(repoRoot, "hello.txt"), "utf8").trim();
      console.log(`  hello.txt: ${hello}`);
      if (hello !== "hello from pi-hub") throw new Error("hello.txt has unexpected content");
      if (router) {
        step("usage_report: the router step");
        const report = await call("usage_report", { scope: "session", period: "day" });
        console.log(JSON.stringify(report, null, 2));
        const rows = report.by_model as { name: string }[];
        check(
          rows.some((r) => r.name.startsWith("9router/jev-")),
          "System One request is a step with the actual model",
        );
      }
    }

    for (const [name, value] of [
      [keyVar, key],
      [ROUTER_KEY, routerKey],
    ] as const) {
      if (!value) continue;
      step(`key leak check (${name})`);
      const hits = [
        ...filesContaining(home, value, [join(home, ".env")]),
        ...filesContaining(repoRoot, value, []),
        ...filesContaining(ROOT, value, [join(ROOT, "node_modules"), join(ROOT, ".git")]),
      ];
      if (hits.length) throw new Error(`key found in: ${hits.join(", ")}`);
      console.log("  not found outside the temp .env");
    }
    ok = true;
    console.log("\n✓ e2e passed");
  } finally {
    await client?.close().catch(() => {});
    const lock = join(home, "hub.lock");
    if (existsSync(lock)) {
      const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 50 && existsSync(lock); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (keep || !ok) console.log(`kept for inspection: ${tmp} (logs: ${home}/logs)`);
    else rmSync(tmp, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`\n✗ e2e failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
