/**
 * Minimal local declarations of the Pi extension API used by this package (plan PD-004).
 * At runtime Pi maps these imports to its own copies; no dependency on the Pi package.
 */
declare module "typebox" {
  export interface TSchema {
    readonly __schema?: unknown;
  }
  export const Type: {
    Object(properties: Record<string, TSchema>, options?: { description?: string }): TSchema;
    String(options?: { description?: string; minLength?: number; maxLength?: number }): TSchema;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  import type { TSchema } from "typebox";

  export interface ToolResult {
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  }

  export interface ToolDefinition<P> {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute(
      toolCallId: string,
      params: P,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<ToolResult>;
  }

  export interface ExtensionAPI {
    registerTool<P>(tool: ToolDefinition<P>): void;
  }
}
