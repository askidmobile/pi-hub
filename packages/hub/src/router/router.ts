import type { RoutedBy } from "@pi-hub/protocol";

/** Layers: architect role -> rules table -> System One -> escalation chain. */
export interface RouteDecision {
  role: string;
  model: string;
  routedBy: RoutedBy;
  reason: string;
  clarify: boolean;
  reviewBeforeMerge: boolean;
}

export interface Router {
  route(input: {
    task: string;
    role?: string;
    model?: string;
    repoSummary: string;
  }): Promise<RouteDecision>;
  escalate(taskId: string): Promise<RouteDecision | null>;
}
