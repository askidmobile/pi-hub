import { z } from "zod";

/** Pi version the hub is tested against (ADR-0004). Upgrade only after adapter tests pass. */
export const PINNED_PI_VERSION = "1.6.1";

/** `<pi provider>/<model id>`, as in Pi's model catalog, e.g. `deepseek/deepseek-flash`. */
const ModelRef = z.string().regex(/^[^/\s]+\/\S+$/, "expected <provider>/<model id>");

export const RoleRule = z.object({
  model: ModelRef,
  fallback: z.array(ModelRef).optional(),
  escalate: z.array(ModelRef).optional(),
});

const ClientRule = z.object({
  tool_list: z.enum(["dynamic", "static"]),
  max_wait_sec: z.number().int().positive(),
  progress_every_sec: z.number().int().positive().optional(),
  delegation_on_connect: z.boolean().default(false),
});

/**
 * ~/.pi-hub/config.yaml. Every section has defaults so an empty file is valid.
 * `prefault` (not `default`) makes zod parse the default and apply nested defaults.
 * Filesystem locations come from HubPaths (config/paths.ts), not from this file,
 * except the overridable socket path.
 */
export const HubConfig = z
  .object({
    delegation_default: z.enum(["on", "off"]).default("off"),
    allowed_repos: z.array(z.string()).default([]),
    pi: z
      .object({
        version: z.string().default(PINNED_PI_VERSION),
        bin: z.string().default("pi"),
        /** Override the worker extension location (defaults to the bundled @pi-hub/pi-extension). */
        extension_path: z.string().optional(),
      })
      .prefault({}),
    transport: z
      .object({
        /** Keep short: macOS limits unix socket paths to ~104 bytes. Defaults to <home>/hub.sock. */
        unix_socket: z.string().max(100).optional(),
        http: z.object({ host: z.literal("127.0.0.1"), port: z.number() }).optional(),
      })
      .prefault({}),
    limits: z
      .object({
        max_workers_hub: z.number().int().positive().default(2),
        max_workers_project: z.number().int().positive().default(2),
        max_workers_session: z.number().int().positive().default(2),
        max_task_minutes: z.number().int().positive().default(60),
        max_task_usd: z.number().positive().default(2),
      })
      .prefault({}),
    clients: z.partialRecord(z.enum(["claude-code", "codex", "mcp"]), ClientRule).default({}),
    orphan_after_minutes: z.number().default(30),
    notify_user_after_minutes: z.number().default(15),
    retention_days: z.number().default(30),
    roles: z.record(z.string(), RoleRule).default({}),
    default_role: z.string().default("code"),
    router: z
      .object({
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
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    if (Object.keys(cfg.roles).length > 0 && !cfg.roles[cfg.default_role]) {
      ctx.addIssue({
        code: "custom",
        path: ["default_role"],
        message: `default_role "${cfg.default_role}" is not defined in roles`,
      });
    }
  });
export type HubConfig = z.infer<typeof HubConfig>;

/** Per-client defaults (ADR-0006, ADR-0010); config.yaml `clients` overrides them. */
export const CLIENT_DEFAULTS: Record<
  "claude-code" | "codex" | "mcp",
  z.infer<typeof ClientRule>
> = {
  "claude-code": {
    tool_list: "dynamic",
    max_wait_sec: 1500,
    progress_every_sec: 60,
    delegation_on_connect: false,
  },
  codex: { tool_list: "static", max_wait_sec: 870, delegation_on_connect: true },
  mcp: { tool_list: "static", max_wait_sec: 50, delegation_on_connect: false },
};

/** `.pi-hub.toml` in a repository root. */
export const ProjectConfig = z.object({
  delegation: z.enum(["on", "off"]).optional(),
  daily_budget_usd: z.number().positive().optional(),
  /** Runs in a fresh worktree before the worker starts (spec FR-024). */
  setup: z.string().min(1).optional(),
  quality: z
    .object({
      test: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
