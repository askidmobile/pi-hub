/**
 * One `pi --mode rpc` child process per task.
 * Notes from research (docs/research/pi-rpc.md):
 *  - strict JSONL framing, split ONLY on LF (do not use node:readline: it splits on U+2028/2029);
 *  - wait for `agent_settled`, not `agent_end`;
 *  - per-message usage incl. cost is in `message_update.usage` / `message_end.message`;
 *  - `set_model`, `set_thinking_level`, `get_session_stats`, `abort`, `switch_session` exist.
 * Consider reusing the exported RpcClient from @earendil-works/pi-coding-agent (ADR-0004).
 */
export interface PiRpcClient {
  start(opts: {
    cwd: string;
    provider: string;
    model: string;
    sessionDir: string;
    env: Record<string, string>;
  }): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<void>;
  abort(): Promise<void>;
  stop(): Promise<void>;
}
