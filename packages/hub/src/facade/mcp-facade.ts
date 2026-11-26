/**
 * MCP facade: per-connection tool list, chosen by client capability (ADR-0010):
 *  - dynamic (Claude Code): in `off` mode only `architect_mode`; switching sends notifications/tools/list_changed;
 *  - static (Codex, unknown clients): all tools listed from the start; delegation calls rejected while `off`. Every response gets a footer
 * with pending questions and budget warnings (see ResponseFooter in @pi-hub/protocol).
 */
export interface McpFacade {
  attach(connectionId: string, seniorSessionId: string): void;
  setMode(seniorSessionId: string, mode: "on" | "off"): Promise<void>;
}
