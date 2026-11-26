/** Records every model call into `steps`, enforces budgets (80% warn, 100% refuse), builds reports. */
export interface Accounting {
  recordStep(step: {
    taskId: string;
    model: string;
    provider: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: number;
    costSource: "provider" | "tokens_x_price" | "pi_event";
    latencyMs?: number;
    toolName?: string;
  }): void;
  budgetState(projectId: string, seniorSessionId: string): { usedShare: number; blocked: boolean };
  formatLine(taskId: string): string; // "0,043 $ · 182k вход (71% из кэша) · 9k выход · 6 мин · PASS · по сессии 0,31 $"
}
