import { z } from "zod";
import type { SystemOneConfig } from "../../config/schema.js";
import { findPreset } from "./presets.js";

/**
 * Single adapter for System One decision models (choice / noul / score), dialect
 * `systemone`: `POST {model, state, questions}` → `{model, answers, usage}` (ADR-0008,
 * stage 3 FR-220, PD-210). Every failure — network, timeout, HTTP error, a body that does not
 * match — is a `SystemOneError`; the router then falls back to rules.
 */
export type SystemOneQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

const Probabilities = z.record(z.string(), z.number());
const Answer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities: Probabilities.optional(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: z.number().min(0).max(1),
    probabilities: Probabilities.optional(),
  }),
]);
export type SystemOneAnswer = z.infer<typeof Answer>;

const ResponseBody = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), Answer),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});

export interface SystemOneResult {
  /** The model that answered (`jev-1.14.0` for `typesafe/jev-latest`). */
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  latencyMs: number;
}

export interface SystemOneAdapter {
  decide(state: string, questions: Record<string, SystemOneQuestion>): Promise<SystemOneResult>;
}

export class SystemOneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemOneError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class HttpSystemOne implements SystemOneAdapter {
  constructor(
    private readonly cfg: SystemOneConfig,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async decide(
    state: string,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneResult> {
    const dialect = findPreset(this.cfg.preset)?.dialect ?? "systemone";
    if (dialect !== "systemone") {
      throw new SystemOneError(`диалект ${dialect} не поддерживается`);
    }
    if (this.cfg.api_key_env && !this.apiKey) {
      throw new SystemOneError(`нет ключа ${this.cfg.api_key_env} в ~/.pi-hub/.env`);
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, state, questions }),
        signal: AbortSignal.timeout(this.cfg.timeout_ms),
      });
    } catch (e) {
      const err = e as Error;
      throw new SystemOneError(
        err.name === "TimeoutError" || err.name === "AbortError"
          ? `таймаут ${this.cfg.timeout_ms} мс`
          : `сеть: ${err.message}`,
      );
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new SystemOneError(`HTTP ${res.status}: ${errorMessage(text)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SystemOneError("ответ не JSON");
    }
    const parsed = ResponseBody.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SystemOneError(
        `неверный ответ: ${issue?.path.join(".") || "тело"} — ${issue?.message ?? ""}`,
      );
    }
    const u = parsed.data.usage;
    return {
      model: parsed.data.model,
      answers: parsed.data.answers,
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        ...(u?.cost !== undefined ? { costUsd: u.cost } : {}),
      },
      latencyMs: Date.now() - started,
    };
  }
}

/** `{"error":{"message":…}}` or the first 200 characters of the body. */
function errorMessage(text: string): string {
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string") return m.slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || "(пустой ответ)";
}
