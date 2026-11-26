/**
 * Single adapter for System One decision models (choice / noul / score).
 * Provider, URL, key env var and model come from config written by `pi-hub init` (ADR-0008).
 * On error / timeout / invalid answer the router falls back to rules (routed_by = "rules").
 */
export type SystemOneQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface SystemOneResult {
  answers: Record<string, SystemOneAnswer>;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  latencyMs: number;
}

export interface SystemOneAdapter {
  decide(state: unknown, questions: Record<string, SystemOneQuestion>): Promise<SystemOneResult>;
}
