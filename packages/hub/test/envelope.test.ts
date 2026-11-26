import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/storage/repos.js";
import { buildEnvelope } from "../src/tasks/envelope.js";

/** Spec success criterion: the envelope stays within 2 KB for a task with 20 changed files. */
describe("result envelope size", () => {
  it("is at most 2 KB with 20 changed files, a full summary and assumptions", () => {
    const task: TaskRow = {
      id: "t_0042",
      owner_session_id: "s_0123456789ab",
      project_id: "p_0123456789ab",
      status: "done",
      role: "code",
      model: "deepseek/deepseek-flash",
      routed_by: "rules",
      route_reason: "default_role code -> deepseek/deepseek-flash",
      escalated_from_task_id: null,
      worktree_path: "/Users/u/.pi-hub/worktrees/p_0123456789ab/t_0042",
      branch: "pi/t_0042",
      pi_session_path: "/Users/u/.pi-hub/sessions/t_0042.jsonl",
      log_path: "/Users/u/.pi-hub/logs/t_0042.jsonl",
      summary: `- ${"x".repeat(496)}`,
      quality_status: "SKIPPED",
      pid: null,
      created_at: "2026-11-26T10:00:00.000Z",
      finished_at: "2026-11-26T10:06:00.000Z",
      task_text: "task",
      base_branch: "main",
      warnings_json: JSON.stringify(["незавершённость: TODO в итоге"]),
      assumptions_json: JSON.stringify(["used the existing logger", "kept the public API"]),
      failure_reason: null,
      cost_usd: 0.043,
      attempt: 1,
      started_at: "2026-11-26T10:00:01.000Z",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      quality_issues_json: "[]",
      quality_log_path: null,
    };
    const files = Array.from({ length: 20 }, (_, i) => `packages/app/src/feature/module-${i}.ts`);
    const env = buildEnvelope({
      task,
      usage: {
        steps: 12,
        cost: 0.043,
        input: 150_000,
        output: 9_000,
        cache_read: 120_000,
        cache_write: 0,
      },
      sessionTotalUsd: 0.31,
      changedFiles: files,
    });
    expect(env.changed_files).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThanOrEqual(2048);
  });
});
