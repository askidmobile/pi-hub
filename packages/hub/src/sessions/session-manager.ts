import type { TaskStatus } from "@pi-hub/protocol";

/** Task lifecycle, ownership, orphans and restart recovery. */
export interface SessionManager {
  transition(taskId: string, to: TaskStatus, reason?: string): void;
  recoverAfterRestart(): Promise<void>; // running -> interrupted
  sweepOrphans(now: Date): Promise<void>;
  adopt(taskId: string, seniorSessionId: string): Promise<void>;
}
