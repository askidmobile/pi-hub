import type { QualityStatus } from "@pi-hub/protocol";
import type { Price } from "../config/prices.js";
import type { AssistantMessage } from "../pi-rpc/events.js";
import type { Repos, StepInput, UsageTotals } from "../storage/repos.js";

/**
 * Step accounting (spec FR-018, FR-025): every assistant `message_end` from Pi becomes a
 * row in `steps`; task and session totals are sums over `steps`.
 * Source of the cost, most accurate first (stage 2 FR-116, D-106): the provider's cost
 * (`usage.cost.totalFromProvider`), Pi's catalog price (`pi_event`), tokens x the manual price
 * from `~/.pi-hub/prices.yaml` (`tokens_x_price`), else `unknown`. A zero cost in the event
 * means unknown, not free (BD-016).
 */

export interface PriceLookup {
  lookup(provider: string, model: string): Price | undefined;
}

/** USD for the tokens at a price per 1M; cache prices default to the input price. */
export function priceTokens(
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
  p: Price,
): number {
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * (p.cache_read ?? p.input) +
      u.cacheWrite * (p.cache_write ?? p.input)) /
    1_000_000
  );
}

/** Builds a step from an assistant message; null when the message carries no usage. */
export function stepFromMessage(
  taskId: string,
  msg: AssistantMessage,
  prices?: PriceLookup,
): StepInput | null {
  const u = msg.usage;
  if (!u) return null;
  const model = msg.model ?? "unknown";
  const provider = msg.provider ?? "unknown";
  const base: StepInput = {
    task_id: taskId,
    model,
    provider,
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_tokens: u.cacheRead,
    cache_write_tokens: u.cacheWrite,
    cost: 0,
    cost_source: "unknown",
    latency_ms: msg.durationMs ?? null,
    tool_name: null,
  };
  const reported = u.cost?.total ?? 0;
  if (reported > 0) {
    return {
      ...base,
      cost: reported,
      cost_source: u.cost?.totalFromProvider ? "provider" : "pi_event",
    };
  }
  const price = prices?.lookup(provider, model);
  if (price) {
    return {
      ...base,
      cost: priceTokens(u, price),
      cost_source: "tokens_x_price",
      price_json: JSON.stringify(price),
    };
  }
  return base;
}

export class Accounting {
  constructor(
    private readonly repos: Repos,
    private readonly prices?: PriceLookup,
  ) {}

  /** Records the step and refreshes the cached task total. Returns the new task total in USD. */
  record(taskId: string, msg: AssistantMessage): number | null {
    const step = stepFromMessage(taskId, msg, this.prices);
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

  sessionUnknownSteps(seniorSessionId: string): number {
    return this.repos.sessionUnknownSteps(seniorSessionId);
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

export const UNKNOWN_PRICE = "цена неизвестна";

export interface CostLineInput {
  usage: Pick<UsageTotals, "cost" | "input" | "output" | "cache_read" | "cache_write"> &
    Partial<Pick<UsageTotals, "steps" | "unknown_steps">>;
  minutes: number;
  quality: QualityStatus;
  sessionTotalUsd: number;
  sessionUnknownSteps?: number;
}

/** The sum, or «цена неизвестна» when no step has a known price (FR-117). */
export function formatCost(usd: number, steps: number, unknownSteps: number): string {
  if (unknownSteps === 0) return formatUsd(usd);
  if (unknownSteps >= steps) return UNKNOWN_PRICE;
  return `${formatUsd(usd)} без учёта ${unknownSteps} ${stepsWord(unknownSteps)} с неизвестной ценой`;
}

function stepsWord(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return "шага";
  return "шагов";
}

/** `0,043 $ · 182k вход (71% из кэша) · 9k выход · 6 мин · SKIPPED · по сессии 0,31 $` (spec §8). */
export function formatCostLine(i: CostLineInput): string {
  const share = Math.round(cachedShare(i.usage) * 100);
  const minutes = i.minutes < 1 ? "<1 мин" : `${Math.round(i.minutes)} мин`;
  const unknown = i.usage.unknown_steps ?? 0;
  const sessionUnknown = i.sessionUnknownSteps ?? 0;
  const session =
    sessionUnknown > 0 && i.sessionTotalUsd === 0
      ? UNKNOWN_PRICE
      : formatCost(i.sessionTotalUsd, Number.POSITIVE_INFINITY, sessionUnknown);
  return [
    formatCost(i.usage.cost, i.usage.steps ?? unknown, unknown),
    `${formatTokens(totalInput(i.usage))} вход (${share}% из кэша)`,
    `${formatTokens(i.usage.output)} выход`,
    minutes,
    i.quality,
    `по сессии ${session}`,
  ].join(" · ");
}
