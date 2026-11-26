import type { QualityStatus } from "@pi-hub/protocol";

/** Runs tests / lint / typecheck on changed files under a per-project build lock. */
export interface QualityGate {
  check(
    taskId: string,
    changedFiles: string[],
  ): Promise<{ status: QualityStatus; issues: string[]; logPath: string }>;
}
