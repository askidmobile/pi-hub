import type { QualityStatus } from "@pi-hub/protocol";
import type { AssistantMessage } from "../pi-rpc/events.js";
import type { Repos, StepInput, UsageTotals } from "../storage/repos.js";

/**
 * Step accounting (spec FR-018, FR-025): every assistant `message_end` from Pi becomes a
 * row in `steps`; task and session totals are sums over `steps`.
 * Source of the cost (BD-016, plan PD-012): `provider` when Pi reports
 * `usage.cost.totalFromProvider`, otherwise Pi's own catalog price (`pi_event`).
 */

/** Builds a step from an assistant message; null when the message carries no usage. */
export function stepFromMessage(taskId: string, msg: AssistantMessage): StepInput | null {
  const u = msg.usage;
  if (!u) return null;
  return {
    task_id: taskId,
    model: msg.model ?? "unknown",
    provider: msg.provider ?? "unknown",
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_tokens: u.cacheRead,
    cache_write_tokens: u.cacheWrite,
    cost: u.cost?.total ?? 0,
    cost_source: u.cost?.totalFromProvider ? "provider" : "pi_event",
    latency_ms: msg.durationMs ?? null,
    tool_name: null,
  };
}

export class Accounting {
  constructor(private readonly repos: Repos) {}

  /** Records the step and refreshes the cached task total. Returns the new task total in USD. */
  record(taskId: string, msg: AssistantMessage): number | null {
    const step = stepFromMessage(taskId, msg);
    if (!step) return null;
    this.repos.insertStep(step);
    const total = this.repos.taskUsage(taskId).cost;
    this.repos.updateTask(taskId, { cost_usd: total });
    return total;
  }

  usage(taskId: string): UsageTotals {
    return this.repos.taskUsage(taskId);
  }

  sessionTotal(seniorSessionId: string): number {
    return this.repos.sessionCost(seniorSessionId);
  }
}

/** Total input = uncached input + cache reads + cache writes (Pi reports them separately). */
export function totalInput(u: Pick<UsageTotals, "input" | "cache_read" | "cache_write">): number {
  return u.input + u.cache_read + u.cache_write;
}

export function cachedShare(u: Pick<UsageTotals, "input" | "cache_read" | "cache_write">): number {
  const total = totalInput(u);
  return total === 0 ? 0 : u.cache_read / total;
}

/** `0,043 $`: 3 decimals below 0.1 $, else 2; decimal comma (Russian locale, as in the spec). */
export function formatUsd(usd: number): string {
  const digits = usd < 0.1 ? 3 : 2;
  return `${usd.toFixed(digits).replace(".", ",")} $`;
}

/** `182k`, `9k`, `950`, `1,2M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export interface CostLineInput {
  usage: Pick<UsageTotals, "cost" | "input" | "output" | "cache_read" | "cache_write">;
  minutes: number;
  quality: QualityStatus;
  sessionTotalUsd: number;
}

/** `0,043 $ · 182k вход (71% из кэша) · 9k выход · 6 мин · SKIPPED · по сессии 0,31 $` (spec §8). */
export function formatCostLine(i: CostLineInput): string {
  const share = Math.round(cachedShare(i.usage) * 100);
  const minutes = i.minutes < 1 ? "<1 мин" : `${Math.round(i.minutes)} мин`;
  return [
    formatUsd(i.usage.cost),
    `${formatTokens(totalInput(i.usage))} вход (${share}% из кэша)`,
    `${formatTokens(i.usage.output)} выход`,
    minutes,
    i.quality,
    `по сессии ${formatUsd(i.sessionTotalUsd)}`,
  ].join(" · ");
}
