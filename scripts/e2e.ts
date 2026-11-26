#!/usr/bin/env node
/**
 * Stage 1 gate on a real Pi and a real model (plan PD-002): run by hand before closing the
 * stage and after a Pi upgrade. Not in CI: it needs a provider and costs a few cents.
 *
 *   pnpm build && pnpm e2e --model <provider>/<id> [--extension <path>]... [--keep]
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

function args(): { model: string; extensions: string[]; keep: boolean } {
  const argv = process.argv.slice(2);
  const extensions: string[] = [];
  let model = process.env.PI_HUB_E2E_MODEL ?? "";
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") model = argv[++i] ?? "";
    else if (a === "--extension") extensions.push(resolve(argv[++i] ?? ""));
    else if (a === "--keep") keep = true;
  }
  if (!/^[^/\s]+\/\S+$/.test(model)) {
    console.error("usage: pnpm e2e --model <provider>/<id> [--extension <path>]... [--keep]");
    process.exit(2);
  }
  return { model, extensions, keep };
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
  const { model, extensions, keep } = args();
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
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const repoRoot = git(repo, "rev-parse", "--show-toplevel");

    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "config.yaml"),
      JSON.stringify({
        allowed_repos: [repoRoot],
        roles: { code: { model } },
        default_role: "code",
        pi: { extensions },
        limits: { max_task_minutes: 15, max_task_usd: 0.5 },
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(home, ".env"), keyVar && key ? `${keyVar}=${key}\n` : "", { mode: 0o600 });

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
    const call = async (name: string, a: Record<string, unknown> = {}) => {
      const res = (await client?.callTool({ name, arguments: a }, undefined, {
        timeout: 1_600_000,
        resetTimeoutOnProgress: true,
        onprogress: (p) => console.log(`  … ${p.message ?? p.progress}`),
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      const text = res.content.map((c) => c.text).join("");
      if (res.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const before = (await client.listTools()).tools.map((t) => t.name);
    console.log(`  tools while off: ${before.join(", ")}`);
    console.log(`  ${JSON.stringify(await call("architect_mode", { mode: "on" }))}`);

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

    if (key) {
      step(`key leak check (${keyVar})`);
      const hits = [
        ...filesContaining(home, key, [join(home, ".env")]),
        ...filesContaining(repoRoot, key, []),
        ...filesContaining(ROOT, key, [join(ROOT, "node_modules"), join(ROOT, ".git")]),
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
