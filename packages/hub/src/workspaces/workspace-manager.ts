/** git worktree + branch `pi/<task_id>` per task, changed files, cross-branch conflict check, cleanup. */
export interface WorkspaceManager {
  create(
    taskId: string,
    repoRoot: string,
    baseBranch: string,
  ): Promise<{ path: string; branch: string }>;
  changedFiles(taskId: string): Promise<string[]>;
  conflicts(taskIds: string[]): Promise<{ a: string; b: string; files: string[] }[]>;
  cleanup(taskId: string): Promise<void>;
}
