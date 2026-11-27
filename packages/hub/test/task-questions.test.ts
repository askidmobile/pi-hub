import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MERGED_BRANCH_WARNING } from "../src/tasks/task-service.js";
import { tempDir } from "./helpers.js";
import { connect, git, type Harness, makeHarness, start } from "./task-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stage 2, plan phase 2: worker questions without MCP, on the TaskService level. */
describe("TaskService questions (fake worker)", () => {
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

  const waitFor = (taskId: string, ms = 15_000) => h.service.waitFor(h.sessionId, taskId, ms);
  const fileOnBranch = (taskId: string, file: string) =>
    git(h.repo, "show", `pi/${taskId}:${file}`);

  it("scenario 1: ask -> needs_input within 2 s -> send -> running -> done", async () => {
    const s = await start(h, "fake/ask");
    const t0 = Date.now();
    const w = await waitFor(s.task_id);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(w).toMatchObject({
      status: "needs_input",
      question: {
        task_id: s.task_id,
        round: 1,
        kind: "question",
        question: "Which storage should sessions use?",
        options: ["A: Redis", "B: database table"],
      },
    });
    // a repeated wait returns the same question at once (FR-103)
    expect((await waitFor(s.task_id, 5_000)).question?.round).toBe(1);

    const sent = await h.service.send(h.sessionId, s.task_id, "B, but with a TTL of 1 hour");
    expect(sent).toEqual({ task_id: s.task_id, status: "running" });
    const done = await waitFor(s.task_id);
    expect(done.status).toBe("done");
    expect(done.summary).toContain("B, but with a TTL of 1 hour");
    expect(fileOnBranch(s.task_id, "answer.txt")).toBe("B, but with a TTL of 1 hour");
    const q = h.repos.getQuestion(`q_${s.task_id}_1`);
    expect(q).toMatchObject({ answer: "B, but with a TTL of 1 hour", answered_by: "senior" });
    expect(q?.answered_at).toBeTruthy();
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.questions).toEqual({ asked: 1, answered: 1 });
  });

  it("a foreign extension dialog is refused and the worker goes on (FR-102)", async () => {
    const s = await start(h, "fake/foreign-dialog");
    expect((await waitFor(s.task_id)).status).toBe("done");
    expect(fileOnBranch(s.task_id, "dialog.txt")).toBe("refused");
    expect(h.repos.countQuestions(s.task_id)).toEqual({ asked: 0, answered: 0 });
  });

  it("two questions in a row are two rounds", async () => {
    const s = await start(h, "fake/ask-twice");
    expect((await waitFor(s.task_id)).question?.question).toBe("First question?");
    await h.service.send(h.sessionId, s.task_id, "one");
    const w2 = await waitFor(s.task_id);
    expect(w2.question).toMatchObject({ round: 2, question: "Second question?" });
    await h.service.send(h.sessionId, s.task_id, "two");
    expect((await waitFor(s.task_id)).status).toBe("done");
    expect(fileOnBranch(s.task_id, "answer.txt")).toBe("one\ntwo");
  });

  it("cancel in needs_input closes the question without an answer", async () => {
    const s = await start(h, "fake/ask");
    expect((await waitFor(s.task_id)).status).toBe("needs_input");
    await h.service.cancel(h.sessionId, s.task_id);
    expect(h.repos.getTask(s.task_id)?.status).toBe("cancelled");
    const q = h.repos.getQuestion(`q_${s.task_id}_1`);
    expect(q?.answer).toBe(null);
    expect(q?.answered_at).toBeTruthy();
  });

  it("a question in the final text becomes needs_input; the answer goes as a prompt (FR-120)", async () => {
    const s = await start(h, "fake/text-question");
    const w = await waitFor(s.task_id);
    expect(w).toMatchObject({
      status: "needs_input",
      question: { kind: "text", question: "Should the file be named a.txt or b.txt?" },
    });
    await h.service.send(h.sessionId, s.task_id, "b.txt");
    const done = await waitFor(s.task_id);
    expect(done.status).toBe("done");
    expect(fileOnBranch(s.task_id, "named.txt")).toBe("b.txt");
    // the SUMMARY request (FR-026) was not sent for the question: two prompts, task + answer
    const log = readFileSync(h.repos.getTask(s.task_id)?.log_path as string, "utf8");
    expect(log.match(/"command":"prompt"/g)).toHaveLength(2);
  });

  it("clarify: plan as a question with no changes, send moves to running (FR-125)", async () => {
    const s = await start(h, "fake/clarify", { clarify: true });
    expect(["queued", "planning"]).toContain(s.status);
    const w = await waitFor(s.task_id);
    expect(w).toMatchObject({ status: "needs_input", question: { kind: "plan" } });
    expect(w.question?.question).toMatch(/^Plan:/);
    expect(w.question?.question).not.toContain("в фазе плана изменены файлы");
    const task = h.repos.getTask(s.task_id);
    expect(git(task?.worktree_path as string, "status", "--porcelain")).toBe("");
    expect(git(h.repo, "rev-parse", `pi/${s.task_id}`)).toBe(task?.base_commit);

    expect((await h.service.send(h.sessionId, s.task_id, "Hi there")).status).toBe("running");
    expect((await waitFor(s.task_id)).status).toBe("done");
    expect(fileOnBranch(s.task_id, "hello.txt")).toBe("Hi there");
  });

  it("clarify: files changed during the plan are reported with the plan", async () => {
    const s = await start(h, "fake/clarify-edit", { clarify: true });
    const w = await waitFor(s.task_id);
    expect(w.question?.question).toContain("⚠ в фазе плана изменены файлы: draft.txt");
    await h.service.cancel(h.sessionId, s.task_id);
  });

  it("clarify: a plan ended in text instead of ask is still the plan question", async () => {
    const s = await start(h, "fake/text-question", { clarify: true });
    const w = await waitFor(s.task_id);
    expect(w.question).toMatchObject({ kind: "plan" });
    expect(w.question?.question).toContain("Should the file be named a.txt or b.txt?");
    await h.service.send(h.sessionId, s.task_id, "a.txt");
    expect((await waitFor(s.task_id)).status).toBe("done");
  });

  it("send on done reworks in the same branch; a merged branch gets a warning (FR-105, FR-123)", async () => {
    const s = await start(h);
    expect((await waitFor(s.task_id)).status).toBe("done");
    git(h.repo, "merge", "-q", "--no-edit", `pi/${s.task_id}`);
    // the rework run needs a scenario that finishes without committing the same file again
    h.repos.updateTask(s.task_id, { model: "fake/empty-diff" });
    const sent = await h.service.send(h.sessionId, s.task_id, "also update the README");
    expect(sent).toEqual({
      task_id: s.task_id,
      status: "running",
      warnings: [MERGED_BRANCH_WARNING],
    });
    const done = await waitFor(s.task_id);
    expect(done.status).toBe("done");
    const task = h.repos.getTask(s.task_id);
    expect(task?.attempt).toBe(2);
    expect(task?.branch).toBe(`pi/${s.task_id}`);
    const log = readFileSync(task?.log_path as string, "utf8");
    expect(log).toContain('"command":"switch_session"');
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.warnings).toContain(MERGED_BRANCH_WARNING);
  });

  it("a waiting task does not hold a worker slot (PD-101)", async () => {
    await h.service.shutdown();
    h = makeHarness(dir.path, { maxWorkers: 1 });
    await connect(h);
    const a = await start(h, "fake/ask");
    const b = await start(h, "fake/success");
    expect(b.status).toBe("queued");
    expect((await waitFor(a.task_id)).status).toBe("needs_input");
    expect((await waitFor(b.task_id)).status).toBe("done");
    await h.service.send(h.sessionId, a.task_id, "B");
    expect((await waitFor(a.task_id)).status).toBe("done");
  });

  it("the time limit does not count time in needs_input (FR-118)", async () => {
    await h.service.shutdown();
    h = makeHarness(dir.path, { timeLimitMs: 400 });
    await connect(h);
    const s = await start(h, "fake/ask");
    expect((await waitFor(s.task_id)).status).toBe("needs_input");
    await sleep(800);
    expect(h.repos.getTask(s.task_id)?.status).toBe("needs_input");
    await h.service.send(h.sessionId, s.task_id, "B");
    expect((await waitFor(s.task_id)).status).toBe("done");
  });

  it("without limits an expensive task is not stopped (FR-118, D-105)", async () => {
    await h.service.shutdown();
    h = makeHarness(dir.path, { noLimits: true });
    await connect(h);
    const s = await start(h, "fake/expensive");
    const w = await waitFor(s.task_id);
    expect(w.status).toBe("done");
    expect(h.repos.taskUsage(s.task_id).cost).toBeGreaterThan(2);
  });
});

describe("TaskService questions across a hub restart (FR-106)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("needs_input -> interrupted keeps the question open; send answers it in the same Pi session", async () => {
    const dbFile = join(dir.path, "shared.db");
    const a = makeHarness(dir.path, { dbFile });
    await connect(a);
    const s = await start(a, "fake/ask");
    expect((await a.service.waitFor(a.sessionId, s.task_id, 15_000)).status).toBe("needs_input");
    await a.service.shutdown();
    expect(a.repos.getTask(s.task_id)?.status).toBe("interrupted");
    expect(a.repos.openQuestion(s.task_id)?.text).toBe("Which storage should sessions use?");

    const b = makeHarness(dir.path, { dbFile, repo: a.repo });
    b.sessionId = a.sessionId;
    expect(b.service.recover()).toEqual({ interrupted: [] });
    expect(b.service.waitResult(a.sessionId, s.task_id).status).toBe("interrupted");
    b.repos.updateTask(s.task_id, { model: "fake/success" });
    expect((await b.service.send(a.sessionId, s.task_id, "B")).status).toBe("running");
    expect((await b.service.waitFor(a.sessionId, s.task_id, 15_000)).status).toBe("done");
    expect(b.repos.getQuestion(`q_${s.task_id}_1`)).toMatchObject({
      answer: "B",
      answered_by: "senior",
    });
    const log = readFileSync(b.repos.getTask(s.task_id)?.log_path as string, "utf8");
    expect(log).toContain('"command":"switch_session"');
    await b.service.shutdown();
  });

  it("recover() turns a task left in needs_input by a dead hub into interrupted", async () => {
    const dbFile = join(dir.path, "shared.db");
    const a = makeHarness(dir.path, { dbFile });
    await connect(a);
    const s = await start(a, "fake/ask");
    expect((await a.service.waitFor(a.sessionId, s.task_id, 15_000)).status).toBe("needs_input");
    const b = makeHarness(dir.path, { dbFile, repo: a.repo });
    // `a` is still holding the worker: b sees a row in needs_input with no live run of its own
    expect(b.service.recover()).toEqual({ interrupted: [s.task_id] });
    expect(b.repos.openQuestion(s.task_id)).toBeTruthy();
    await a.service.shutdown();
  });
});
