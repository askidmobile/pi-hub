import type { RoutedBy } from "@pi-hub/protocol";
import type { HubConfig } from "../config/schema.js";

/**
 * Stage 1 model selection (spec FR-009, D-002): explicit model -> role table -> default_role.
 * System One is layered on top by `RoleRouter`, escalation by `escalation.ts` (stage 3).
 */
export interface ModelChoice {
  provider: string;
  modelId: string;
  /** `<provider>/<model id>` as stored in tasks.model. */
  ref: string;
  role: string | null;
  routedBy: Extract<RoutedBy, "architect" | "rules" | "system_one">;
  reason: string;
}

export class ModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1 || /\s/.test(ref)) {
    throw new ModelSelectionError(`model must be <provider>/<model id>, got "${ref}"`);
  }
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

export function resolveModel(
  request: { model?: string | undefined; role?: string | undefined },
  config: Pick<HubConfig, "roles" | "default_role">,
): ModelChoice {
  if (request.model) {
    const { provider, modelId } = parseModelRef(request.model);
    return {
      provider,
      modelId,
      ref: request.model,
      role: request.role ?? null,
      routedBy: "architect",
      reason: `model set by architect: ${request.model}`,
    };
  }
  if (request.role && config.roles[request.role]) {
    const ref = (config.roles[request.role] as { model: string }).model;
    return {
      ...parseModelRef(ref),
      ref,
      role: request.role,
      routedBy: "rules",
      reason: `role ${request.role} -> ${ref}`,
    };
  }
  const fallback = config.roles[config.default_role];
  if (!fallback) {
    throw new ModelSelectionError(
      `no model configured: pass "model" or define roles.${config.default_role} in ~/.pi-hub/config.yaml (pi-hub init)`,
    );
  }
  const why = request.role
    ? `unknown role ${request.role}, default_role ${config.default_role} -> ${fallback.model}`
    : `default_role ${config.default_role} -> ${fallback.model}`;
  return {
    ...parseModelRef(fallback.model),
    ref: fallback.model,
    role: config.default_role,
    routedBy: "rules",
    reason: why,
  };
}
