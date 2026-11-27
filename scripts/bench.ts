#!/usr/bin/env node
/**
 * Reference task run (stage 3 FR-211, FR-212; D-210, D-214; plan PD-202, PD-203): the same
 * tasks on several models through the real shim and daemon, 2 runs each, escalation off
 * (`start(model=…)` is the architect's model). Not in CI: it costs model calls.
 *
 *   pnpm build && pnpm bench --models 9router/a,9router/b [--runs 2] [--tasks 01,04]
 *     [--parallel 2] [--extension <path>]... [--out benchmarks/results/<date>] [--timeout-min 15]
 *
 * Every task of `benchmarks/tasks/NN-name/` (task.md, repo/, pi-hub.toml, answers.json,
 * accept/) becomes one temp git repo; runs start from its `main` in their own worktrees.
 * Questions get the prepared answer through `send`. Each finished run is a line in
 * `<out>/raw.jsonl`; a second start with the same `--out` skips runs already there.
 * Provider errors (429, 5xx, dropped connections) are retried 3 times with a pause and
 * otherwise recorded as `provider_error`, not as a model FAIL. The table is `<out>.md`.
 *
 * Erasable TypeScript only: Node runs it directly.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HUB_DIST = join(ROOT, "packages/hub/dist");
const SHIM = join(ROOT, "packages/shim/dist/index.js");
const TASKS_DIR = join(ROOT, "benchmarks/tasks");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const requireFromHub = createRequire(join(ROOT, "packages/hub/package.json"));

async function fromHub<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(requireFromHub.resolve(specifier)).href)) as T;
}

const PROVIDER_ERROR_RE =
  /\b(429|5\d\d)\b|rate.?limit|too many requests|overloaded|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|connection (reset|closed|error)|terminated|upstream/i;
const RETRIES = 3;
const RETRY_PAUSE_MS = 20_000;

type Outcome = "first_pass" | "pass_after_fix" | "fail" | "error" | "provider_error";

interface RunRecord {
  task: string;
  model: string;
  run: number;
  outcome: Outcome;
  quality?: string;
  minutes?: number;
  input?: number;
  output?: number;
  cost_usd?: number;
  unknown_price_steps?: number;
  questions?: number;
  retries: number;
  reason?: string;
  task_id?: string;
}

interface Args {
  models: string[];
  runs: number;
  tasks: string[] | null;
  parallel: number;
  extensions: string[];
  out: string;
  timeoutMin: number;
}

function args(): Args {
  const argv = process.argv.slice(2);
  const a: Args = {
    models: [],
    runs: 2,
    tasks: null,
    parallel: 2,
    extensions: [],
    out: join(ROOT, "benchmarks/results", new Date().toISOString().slice(0, 10)),
    timeoutMin: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? "";
    switch (argv[i]) {
      case "--models":
        a.models = v.split(",").filter(Boolean);
        i++;
        break;
      case "--runs":
        a.runs = Number(v);
        i++;
        break;
      case "--tasks":
        a.tasks = v.split(",").filter(Boolean);
        i++;
        break;
      case "--parallel":
        a.parallel = Number(v);
        i++;
        break;
      case "--extension":
        a.extensions.push(resolve(v));
        i++;
        break;
      case "--out":
        a.out = resolve(v);
        i++;
        break;
      case "--timeout-min":
        a.timeoutMin = Number(v);
        i++;
        break;
    }
  }
  if (!a.models.length || a.models.some((m) => !/^[^/\s]+\/\S+$/.test(m))) {
    console.error(
      "usage: pnpm bench --models <provider>/<id>,… [--runs 2] [--tasks 01,04] [--parallel 2] [--extension <path>]… [--out <dir>]",
    );
    process.exit(2);
  }
  return a;
}

function git(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TaskDef {
  id: string;
  dir: string;
  text: string;
  answers: Record<string, string>;
}

/** The `## Task` section of task.md is what the worker gets. */
function loadTasks(filter: string[] | null): TaskDef[] {
  return readdirSync(TASKS_DIR)
    .filter((n) => /^\d\d-/.test(n))
    .filter((n) => !filter || filter.some((f) => n.startsWith(f)))
    .sort()
    .map((n) => {
      const dir = join(TASKS_DIR, n);
      const md = readFileSync(join(dir, "task.md"), "utf8");
      const text = /## Task\n([\s\S]*?)(\n## |$)/.exec(md)?.[1]?.trim() ?? md;
      const answers = existsSync(join(dir, "answers.json"))
        ? (JSON.parse(readFileSync(join(dir, "answers.json"), "utf8")) as Record<string, string>)
        : {};
      return { id: n, dir, text, answers };
    });
}

/** One temp repo per task: repo/ + .pi-hub.toml with absolute paths, committed on main. */
function makeRepo(t: TaskDef, root: string): string {
  const repo = join(root, t.id);
  cpSync(join(t.dir, "repo"), repo, { recursive: true });
  const accept = join(root, `${t.id}-accept`);
  if (existsSync(join(t.dir, "accept"))) cpSync(join(t.dir, "accept"), accept, { recursive: true });
  const toml = readFileSync(join(t.dir, "pi-hub.toml"), "utf8")
    .replaceAll("{{ACCEPT}}", accept)
    .replaceAll("{{TSC}}", TSC);
  writeFileSync(join(repo, ".pi-hub.toml"), toml);
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "config", "user.name", "pi-hub bench");
  git(repo, "config", "user.email", "bench@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return git(repo, "rev-parse", "--show-toplevel");
}

function readRaw(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunRecord);
}

const key = (r: { task: string; model: string; run: number }) => `${r.task}|${r.model}|${r.run}`;

async function main(): Promise<void> {
  const a = args();
  if (!existsSync(SHIM) || !existsSync(join(HUB_DIST, "cli/main.js"))) {
    console.error("build first: pnpm build");
    process.exit(2);
  }
  const { Client } = await fromHub<typeof import("@modelcontextprotocol/sdk/client/index.js")>(
    "@modelcontextprotocol/sdk/client/index.js",
  );
  const { StdioClientTransport } = await fromHub<
    typeof import("@modelcontextprotocol/sdk/client/stdio.js")
  >("@modelcontextprotocol/sdk/client/stdio.js");
  const { loadSecrets } =
    await fromHub<typeof import("../packages/hub/src/config/load.ts")>("./dist/config/load.js");
  const { providerKeyEnv } = await fromHub<
    typeof import("../packages/hub/src/pi-rpc/provider-env.ts")
  >("./dist/pi-rpc/provider-env.js");

  const tasks = loadTasks(a.tasks);
  mkdirSync(a.out, { recursive: true });
  const rawFile = join(a.out, "raw.jsonl");
  const done = new Set(readRaw(rawFile).map(key));
  // Alternate models so a slow provider does not hold both slots (PD-203).
  const queue: { task: TaskDef; model: string; run: number }[] = [];
  for (let run = 1; run <= a.runs; run++)
    for (const task of tasks)
      for (const model of a.models)
        if (!done.has(key({ task: task.id, model, run }))) queue.push({ task, model, run });
  const total = tasks.length * a.models.length * a.runs;
  console.log(`${queue.length} of ${total} runs left; results in ${a.out}`);

  if (queue.length) {
    const tmp = mkdtempSync(join(tmpdir(), "pihub-bench-"));
    const home = join(tmp, "h");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const repos = new Map(tasks.map((t) => [t.id, makeRepo(t, tmp)]));
    // keys of the providers of the models, from the environment or ~/.pi-hub/.env
    const userEnv = loadSecrets(join(homedir(), ".pi-hub/.env")).values;
    const envLines = [...new Set(a.models.map((m) => providerKeyEnv(m.split("/")[0] ?? "")))]
      .filter((v): v is string => !!v)
      .map((v) => {
        const value = process.env[v] ?? userEnv[v];
        if (!value) throw new Error(`no ${v} in the environment or ~/.pi-hub/.env`);
        return `${v}=${value}\n`;
      });
    writeFileSync(join(home, ".env"), envLines.join(""), { mode: 0o600 });
    writeFileSync(
      join(home, "config.yaml"),
      JSON.stringify({
        allowed_repos: [...repos.values()],
        roles: { code: { model: a.models[0] } },
        default_role: "code",
        pi: { extensions: a.extensions },
        limits: { max_workers_hub: a.parallel, max_task_minutes: a.timeoutMin },
      }),
      { mode: 0o600 },
    );

    const client = new Client({ name: "pi-hub-bench", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SHIM, "--client", "mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PI_HUB_HOME: home,
          PI_HUB_PROJECT_DIR: [...repos.values()][0] as string,
          PI_HUB_SERVE_COMMAND: JSON.stringify([
            process.execPath,
            join(HUB_DIST, "cli/main.js"),
            "serve",
          ]),
        },
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      const text = res.content[0]?.text ?? "";
      if (res.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    await call("architect_mode", { mode: "on" });

    const once = async (job: (typeof queue)[number]): Promise<Omit<RunRecord, "retries">> => {
      const base = { task: job.task.id, model: job.model, run: job.run };
      const started = await call("start", {
        task: job.task.text,
        model: job.model,
        repo: repos.get(job.task.id),
        base_branch: "main",
      });
      const id = started.task_id as string;
      const deadline = Date.now() + a.timeoutMin * 60_000 + 60_000;
      let status = String(started.status);
      let questions = 0;
      while (Date.now() < deadline) {
        // `mcp` clients cap wait at 50 s (ADR-0006)
        const w = await call("wait", { task_id: id, timeout: 50 });
        status = String(w.status);
        if (status === "needs_input") {
          questions++;
          const q = String((w.question as { question?: string } | undefined)?.question ?? "");
          const answer =
            Object.entries(job.task.answers).find(
              ([k]) => k !== "default" && q.toLowerCase().includes(k.toLowerCase()),
            )?.[1] ??
            job.task.answers.default ??
            "No preference: choose the simplest option and continue.";
          await call("send", { task_id: id, message: answer });
          continue;
        }
        if (!["queued", "planning", "running", "checking"].includes(status)) break;
      }
      if (!["done", "failed", "cancelled", "interrupted"].includes(status)) {
        await call("cancel", { task_id: id }).catch(() => undefined);
        return { ...base, outcome: "error", reason: "таймаут прогона", task_id: id, questions };
      }
      const env = await call("result", { task_id: id });
      const usage = env.usage as {
        cost_usd: number;
        input: number;
        output: number;
        minutes: number;
        unknown_price_steps?: number;
      };
      const quality = (env.quality as { status: string }).status;
      const warnings = (env.warnings as string[]) ?? [];
      const measures = {
        quality,
        minutes: usage.minutes,
        input: usage.input,
        output: usage.output,
        cost_usd: usage.cost_usd,
        ...(usage.unknown_price_steps ? { unknown_price_steps: usage.unknown_price_steps } : {}),
        questions: (env.questions as { asked: number }).asked,
        task_id: id,
      };
      if (env.status !== "done") {
        const reason = warnings.find((w) => w.startsWith("причина:")) ?? String(env.status);
        let log = "";
        try {
          log = readFileSync(String(env.log_path), "utf8").slice(-20_000);
        } catch {
          // no log
        }
        const provider = PROVIDER_ERROR_RE.test(reason) || PROVIDER_ERROR_RE.test(log);
        return { ...base, ...measures, outcome: provider ? "provider_error" : "error", reason };
      }
      const outcome: Outcome =
        quality === "PASS"
          ? warnings.includes("проверка прошла со второй попытки")
            ? "pass_after_fix"
            : "first_pass"
          : "fail";
      return { ...base, ...measures, outcome };
    };

    const runJob = async (job: (typeof queue)[number]) => {
      let retries = 0;
      for (;;) {
        let r: Omit<RunRecord, "retries">;
        try {
          r = await once(job);
        } catch (e) {
          const msg = (e as Error).message;
          r = {
            task: job.task.id,
            model: job.model,
            run: job.run,
            outcome: PROVIDER_ERROR_RE.test(msg) ? "provider_error" : "error",
            reason: msg.slice(0, 300),
          };
        }
        if (r.outcome === "provider_error" && retries < RETRIES) {
          retries++;
          console.log(`  ↻ ${key(r)}: ${r.reason ?? "provider error"} (retry ${retries})`);
          await sleep(RETRY_PAUSE_MS * retries);
          continue;
        }
        const rec: RunRecord = { ...r, retries };
        appendFileSync(rawFile, `${JSON.stringify(rec)}\n`);
        console.log(
          `  ${rec.outcome.padEnd(14)} ${rec.task} · ${rec.model} · run ${rec.run}` +
            (rec.minutes !== undefined ? ` · ${rec.minutes} min` : "") +
            (rec.reason ? ` · ${rec.reason}` : ""),
        );
        return;
      }
    };

    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(a.parallel, queue.length) }, async () => {
          while (next < queue.length) await runJob(queue[next++] as (typeof queue)[number]);
        }),
      );
    } finally {
      await client.close().catch(() => undefined);
      const lock = join(home, "hub.lock");
      if (existsSync(lock)) {
        try {
          process.kill(Number.parseInt(readFileSync(lock, "utf8"), 10), "SIGTERM");
        } catch {
          // already gone
        }
      }
      console.log(`temp hub and repos: ${tmp}`);
    }
  }

  const table = renderTable(readRaw(rawFile), tasks, a.models, a.runs);
  writeFileSync(`${a.out}.md`, table);
  console.log(`\n${table}`);
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const kTok = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(Math.round(n));
const CELL: Record<Outcome, string> = {
  first_pass: "✓",
  pass_after_fix: "◐",
  fail: "✗",
  error: "!",
  provider_error: "~",
};

/** Table by model and a task × model grid (spec scenario 5). */
export function renderTable(
  records: RunRecord[],
  tasks: { id: string }[],
  models: string[],
  runs: number,
): string {
  const lines = [
    `# Эталонный прогон ${new Date().toISOString().slice(0, 10)}`,
    "",
    `${tasks.length} задач × ${runs} запуска × ${models.length} моделей; эскалация выключена (модель от старшего).`,
    "Ошибки провайдера (429, 5xx, обрыв) — отдельная колонка, в долю PASS не входят.",
    "",
    "| Модель | Запусков | PASS с первого раза | PASS итого | FAIL | Ошибка | Ошибка провайдера | Время, мин (ср.) | Вход / выход (ср.) | Стоимость | Вопросов |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of models) {
    const rs = records.filter((r) => r.model === m);
    const counted = rs.filter((r) => r.outcome !== "provider_error");
    const n = (o: Outcome) => rs.filter((r) => r.outcome === o).length;
    const measured = rs.filter((r) => r.minutes !== undefined);
    const avg = (f: (r: RunRecord) => number) =>
      measured.length ? measured.reduce((s, r) => s + f(r), 0) / measured.length : 0;
    const unknown = measured.some((r) => r.unknown_price_steps);
    const cost = measured.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    lines.push(
      `| ${m} | ${rs.length} | ${pct(n("first_pass"), counted.length)} | ${pct(n("first_pass") + n("pass_after_fix"), counted.length)} | ${n("fail")} | ${n("error")} | ${n("provider_error")} | ${avg((r) => r.minutes ?? 0).toFixed(1)} | ${kTok(avg((r) => r.input ?? 0))} / ${kTok(avg((r) => r.output ?? 0))} | ${unknown && cost === 0 ? "цена неизвестна" : `${cost.toFixed(3)} $${unknown ? " (не все шаги)" : ""}`} | ${measured.reduce((s, r) => s + (r.questions ?? 0), 0)} |`,
    );
  }
  lines.push(
    "",
    "## По задачам",
    "",
    "✓ PASS с первого раза · ◐ PASS после авто-круга · ✗ FAIL · ! ошибка · ~ ошибка провайдера",
    "",
    `| Задача | ${models.map((m) => basename(m)).join(" | ")} |`,
    `|---|${models.map(() => "---").join("|")}|`,
  );
  for (const t of tasks) {
    const cells = models.map((m) =>
      Array.from({ length: runs }, (_, i) => {
        const r = records.find((x) => x.task === t.id && x.model === m && x.run === i + 1);
        return r ? CELL[r.outcome] : "·";
      }).join(""),
    );
    lines.push(`| ${t.id} | ${cells.join(" | ")} |`);
  }
  const notes = records.filter((r) => r.reason && r.outcome !== "fail");
  if (notes.length) {
    lines.push("", "## Ошибки", "");
    for (const r of notes)
      lines.push(`- ${r.task} · ${r.model} · run ${r.run}: ${r.outcome} — ${r.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

main().catch((e: unknown) => {
  console.error(`\n✗ bench failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
