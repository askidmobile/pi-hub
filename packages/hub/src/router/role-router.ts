import type { HubConfig } from "../config/schema.js";
import { type ModelChoice, parseModelRef, resolveModel } from "./model-resolver.js";
import type { SystemOneAdapter, SystemOneResult } from "./system-one/adapter.js";

/**
 * Role selection for `start` (stage 3 FR-220, D-204): the architect's `model` → its `role` →
 * System One (smart router on, more than one role, adapter ready) → `default_role`.
 * System One only picks the role; every failure falls back to rules with the reason
 * `system_one_unavailable`. The request is returned so the caller records it as a step.
 */
export const UNAVAILABLE = "system_one_unavailable";
const MAX_STATE_CHARS = 4000;

export interface RouteResult {
  choice: ModelChoice;
  /** The System One request when one was made (successful or not, with a model). */
  request?: SystemOneResult;
}

export class RoleRouter {
  constructor(
    private readonly config: Pick<HubConfig, "roles" | "default_role" | "router">,
    private readonly adapter: SystemOneAdapter | null,
  ) {}

  /** Whether `start` without role and model asks System One. */
  get smart(): boolean {
    return (
      this.config.router.smart &&
      !!this.config.router.system_one &&
      !!this.adapter &&
      Object.keys(this.config.roles).length > 1
    );
  }

  /** Provider name of router steps: the System One preset (`9router`, `custom`, …). */
  get provider(): string {
    return this.config.router.system_one?.preset ?? "system_one";
  }

  async route(input: {
    task: string;
    model?: string | undefined;
    role?: string | undefined;
  }): Promise<RouteResult> {
    const rules = () => resolveModel({ model: input.model, role: input.role }, this.config);
    if (input.model || input.role || !this.smart) return { choice: rules() };
    const s1 = this.config.router.system_one as NonNullable<HubConfig["router"]["system_one"]>;
    const criteria = Object.fromEntries(
      Object.entries(this.config.roles).map(([name, r]) => [name, r.description ?? name]),
    );
    let res: SystemOneResult;
    try {
      res = await (this.adapter as SystemOneAdapter).decide(
        `Task: ${input.task.slice(0, MAX_STATE_CHARS)}`,
        {
          role: {
            type: "choice",
            instructions: "Which role should handle this coding task?",
            criteria,
          },
        },
      );
    } catch (e) {
      return { choice: fallback(rules(), `${UNAVAILABLE}: ${(e as Error).message}`) };
    }
    const answer = res.answers.role;
    if (answer?.type !== "choice" || !this.config.roles[answer.choice]) {
      const got = answer?.type === "choice" ? `роль ${answer.choice} не из таблицы` : "нет ответа";
      return { choice: fallback(rules(), `${UNAVAILABLE}: ${got}`), request: res };
    }
    const conf = answer.confidence.toFixed(2);
    if (answer.confidence < s1.min_confidence) {
      return {
        choice: fallback(
          rules(),
          `system_one: ${answer.choice} с уверенностью ${conf} < ${s1.min_confidence}`,
        ),
        request: res,
      };
    }
    const ref = (this.config.roles[answer.choice] as { model: string }).model;
    return {
      choice: {
        ...parseModelRef(ref),
        ref,
        role: answer.choice,
        routedBy: "system_one",
        reason: `system_one: role ${answer.choice} (${conf}, ${res.model}) -> ${ref}`,
      },
      request: res,
    };
  }
}

function fallback(choice: ModelChoice, why: string): ModelChoice {
  return { ...choice, reason: `${why}; ${choice.reason}` };
}
