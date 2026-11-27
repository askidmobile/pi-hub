import type { HubConfig } from "../config/schema.js";
import type { ModelRunRow } from "../storage/repos.js";

/**
 * Next model of the task's escalation chain (stage 3 FR-202, FR-203; D-201, D-211):
 * the first model of the role's `escalate` list that has not run on the task yet.
 * `null` when the architect chose the model, the role is unknown or the chain is used up.
 */
export function nextModel(
  task: { role: string | null },
  runs: readonly Pick<ModelRunRow, "model" | "routed_by">[],
  config: Pick<HubConfig, "roles">,
): string | null {
  if (!runs.length || runs[0]?.routed_by === "architect") return null;
  const role = task.role ? config.roles[task.role] : undefined;
  if (!role?.escalate?.length) return null;
  const tried = new Set(runs.map((r) => r.model));
  return role.escalate.find((m) => !tried.has(m)) ?? null;
}

export function escalationWarning(from: string, to: string): string {
  return `эскалировано: ${from} → ${to} (FAIL после авто-круга)`;
}
