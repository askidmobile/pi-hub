#!/usr/bin/env node
/**
 * Fake worker speaking the Pi RPC JSONL protocol subset that pi-hub uses.
 * Scenario via `--scenario <name>`: success | question | crash | hang | protocol-violation.
 */
export const SCENARIOS = ["success", "question", "crash", "hang", "protocol-violation"] as const;
export type Scenario = (typeof SCENARIOS)[number];
