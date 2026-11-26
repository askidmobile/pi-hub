import { z } from "zod";

export const RoleRule = z.object({
  model: z.string(),
  fallback: z.array(z.string()).optional(),
  escalate: z.array(z.string()).optional(),
});

export const HubConfig = z.object({
  data_dir: z.string().default("~/.pi-hub"),
  delegation_default: z.enum(["on", "off"]).default("off"),
  allowed_repos: z.array(z.string()).default([]),
  pi: z.object({ version: z.string(), bin: z.string().default("pi") }),
  transport: z.object({
    // Keep short: macOS limits unix socket paths to ~104 bytes.
    unix_socket: z.string().max(100).default("~/.pi-hub/hub.sock"),
    http: z.object({ host: z.literal("127.0.0.1"), port: z.number() }).optional(),
  }),
  limits: z.object({
    max_workers_hub: z.number().int().positive().default(4),
    max_workers_project: z.number().int().positive().default(2),
    max_workers_session: z.number().int().positive().default(2),
  }),
  clients: z
    .partialRecord(
      z.enum(["claude-code", "codex", "mcp"]),
      z.object({
        tool_list: z.enum(["dynamic", "static"]),
        max_wait_sec: z.number().int().positive(),
        progress_every_sec: z.number().int().positive().optional(),
        delegation_on_connect: z.boolean().default(false),
      }),
    )
    .default({}),
  orphan_after_minutes: z.number().default(30),
  notify_user_after_minutes: z.number().default(15),
  retention_days: z.number().default(30),
  roles: z.record(z.string(), RoleRule),
  default_role: z.string().default("code"),
  router: z.object({
    smart: z.boolean().default(false),
    system_one: z
      .object({
        preset: z.string(),
        url: z.string().url(),
        api_key_env: z.string().optional(),
        model: z.string(),
        timeout_ms: z.number().int().positive().default(3000),
        min_confidence: z.number().min(0).max(1).default(0.75),
      })
      .optional(),
  }),
});
export type HubConfig = z.infer<typeof HubConfig>;
