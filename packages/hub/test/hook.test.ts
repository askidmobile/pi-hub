import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questionCell } from "../src/cli/status.js";
import { pendingLine } from "../src/facade/mcp-facade.js";
import { ancestors, HookResolver } from "../src/sessions/hook-resolver.js";
import { HookService, hookReason } from "../src/sessions/hook-service.js";
import { migrate, openDatabase } from "../src/storage/db.js";
import type { QuestionRow } from "../src/storage/repos.js";
import { Repos } from "../src/storage/repos.js";
import { gitTopLevel } from "../src/workspaces/repo.js";
import { initRepo, tempDir } from "./helpers.js";

describe("process ancestry", () => {
  it("walks up to 10 parents, stops at init and on cycles", () => {
    const table = new Map([
      [500, 400],
      [400, 300],
      [300, 1],
    ]);
    expect(ancestors(500, table)).toEqual([500, 400, 300]);
    expect(
      ancestors(
        7,
        new Map([
          [7, 8],
          [8, 7],
        ]),
      ),
    ).toEqual([7, 8]);
    const long = new Map(
      Array.from({ length: 30 }, (_, i) => [i + 100, i + 101] as [number, number]),
    );
    expect(ancestors(100, long)).toHaveLength(11);
  });
});

describe("HookResolver and HookService", () => {
  let dir: ReturnType<typeof tempDir>;
  let repos: Repos;
  let repo: string;
  let projectId: string;
  const connected = new Set<string>();
  // claude A (pid 100) -> sh 110 -> hook 111; claude B (pid 200) -> sh 210 -> hook 211
  const table = async () =>
    new Map([
      [111, 110],
      [110, 100],
      [100, 1],
      [211, 210],
      [210, 200],
      [200, 1],
      [311, 310],
      [310, 1],
    ]);
  const session = (parentPid: number) => {
    const s = repos.createSession({
      client: "claude-code",
      parent_pid: parentPid,
      project_id: projectId,
      mode: "on",
    });
    connected.add(s.id);
    return s;
  };
  const task = (owner: string) =>
    repos.insertTask({
      owner_session_id: owner,
      project_id: projectId,
      task_text: "x",
      base_branch: "main",
      role: "code",
      model: "fake/ask",
      routed_by: "rules",
      route_reason: "",
    });
  const ask = (taskId: string, text = "Redis or table?") =>
    repos.insertQuestion({
      task_id: taskId,
      kind: "question",
      text,
      options: ["Redis", "table"],
      resume_status: "running",
    });

  beforeEach(async () => {
    dir = tempDir();
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const db = openDatabase(join(dir.path, "hub.db"));
    migrate(db);
    repos = new Repos(db);
    // the hub keys projects by the git top level (a real path: /private/var on macOS)
    projectId = repos.upsertProject((await gitTopLevel(repo)) as string, null).id;
    connected.clear();
  });
  afterEach(() => dir.cleanup());

  const resolver = () => new HookResolver(repos, (id) => connected.has(id), table);
  const service = () => new HookService(repos, resolver(), join(dir.path, "logs", "hooks.log"));
  const q = (pid: number, extra: Record<string, unknown> = {}) => ({
    type: "hook_query" as const,
    protocol_version: "0.2.0",
    event: "stop" as const,
    client: "claude-code" as const,
    pid,
    cwd: repo,
    ...extra,
  });

  it("finds the session through the agent process; two sessions of one project stay apart", async () => {
    const a = session(100);
    const b = session(200);
    expect(await resolver().resolve(q(111))).toMatchObject({
      session: { id: a.id },
      via: "ancestors",
    });
    expect(await resolver().resolve(q(211))).toMatchObject({
      session: { id: b.id },
      via: "ancestors",
    });
    // the question of A's task is invisible to B's hook
    ask(task(a.id).id);
    expect(await service().decide(q(211))).toEqual({ block: false });
    const blocked = await service().decide(q(111));
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("Redis or table? Варианты: Redis; table.");
  });

  it("falls back to the only connected session of the project; two of them are ambiguous (FR-122)", async () => {
    const a = session(999);
    expect(await resolver().resolve(q(311))).toMatchObject({
      session: { id: a.id },
      via: "project",
    });
    session(998);
    expect(await resolver().resolve(q(311))).toMatchObject({
      session: null,
      reason: "сессия хука не определена (2 подключённых сессий проекта)",
    });
    connected.clear();
    expect((await resolver().resolve(q(311))).session).toBe(null);
  });

  it("blocks once per question, never with mode off or stop_hook_active (D-110, PD-111)", async () => {
    const a = session(100);
    const t = task(a.id);
    ask(t.id);
    expect(await service().decide(q(111, { stop_hook_active: true }))).toEqual({ block: false });
    repos.setSessionMode(a.id, "off");
    expect(await service().decide(q(111))).toEqual({ block: false });
    repos.setSessionMode(a.id, "on");
    expect((await service().decide(q(111))).block).toBe(true);
    expect(await service().decide(q(111))).toEqual({ block: false });
    expect(repos.openQuestion(t.id)?.hook_delivered_at).toBeTruthy();
  });

  it("the reason is at most 1000 chars", () => {
    const row = { task_id: "t_0001", text: "x".repeat(5000), options_json: null } as QuestionRow;
    expect(hookReason([row, row]).length).toBeLessThanOrEqual(1000);
  });
});

describe("pending questions line and status cell", () => {
  it("names tasks and counts, fits 300 bytes (FR-107)", () => {
    expect(pendingLine([])).toBe(null);
    expect(pendingLine([{ task_id: "t_0142", count: 1 }])).toBe(
      "ожидают ответа: t_0142 (1 вопрос) — ответьте через send",
    );
    expect(
      pendingLine([
        { task_id: "t_1", count: 2 },
        { task_id: "t_2", count: 5 },
      ]),
    ).toBe("ожидают ответа: t_1 (2 вопроса), t_2 (5 вопросов) — ответьте через send");
    const many = Array.from({ length: 40 }, (_, i) => ({ task_id: `t_${1000 + i}`, count: 1 }));
    const line = pendingLine(many) as string;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(300);
    expect(line).toMatch(/ и ещё \d+ — ответьте через send$/);
  });

  it("pi-hub status shows the question and the waiting time (FR-130)", () => {
    const now = Date.parse("2026-11-27T10:30:00Z");
    const row = {
      status: "needs_input",
      question_text: `Which storage?\n${"y".repeat(100)}`,
      question_asked_at: "2026-11-27T10:18:00Z",
    } as Parameters<typeof questionCell>[0];
    const cell = questionCell(row, now) as string;
    expect(cell).toMatch(/^\? Which storage\? y+… · ждёт 12 мин$/);
    expect(questionCell({ ...row, status: "running" }, now)).toBe(null);
  });
});
