import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";

export const MASK = "***";
/** Shorter values are too likely to collide with ordinary text; they are not secrets worth masking. */
const MIN_SECRET_LENGTH = 6;

/**
 * Replaces every occurrence of every secret value. Longest first, so a secret that
 * contains another secret is masked whole.
 */
export function createMasker(secrets: Iterable<string>): (text: string) => string {
  const values = [...new Set([...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK);
    return out;
  };
}

/** Deep-masks strings inside plain objects and arrays (log fields, Pi events). */
export function maskDeep<T>(value: T, mask: (s: string) => string): T {
  if (typeof value === "string") return mask(value) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask)) as T;
  if (value instanceof Error) {
    // message and stack are not enumerable: copy them explicitly or they vanish from logs.
    const extra = maskDeep({ ...value } as Record<string, unknown>, mask);
    return Object.assign(extra, {
      type: value.name,
      message: mask(value.message),
      stack: value.stack ? mask(value.stack) : undefined,
    }) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, mask);
    return out as T;
  }
  return value;
}

export interface LoggerOptions {
  file: string;
  level?: string;
  secrets?: Iterable<string>;
}

/**
 * Hub logger: JSON lines into a file, secrets masked in the message and in every field.
 * Use `logger.child({ task_id, senior_session_id })` so each record carries the end-to-end ids.
 */
export function createLogger(opts: LoggerOptions): Logger {
  mkdirSync(dirname(opts.file), { recursive: true });
  const mask = createMasker(opts.secrets ?? []);
  return pino(
    {
      level: opts.level ?? "info",
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (obj) => maskDeep(obj, mask),
      },
      hooks: {
        logMethod(args, method) {
          const masked = args.map((a) => (typeof a === "string" ? mask(a) : a)) as Parameters<
            typeof method
          >;
          method.apply(this, masked);
        },
      },
    },
    pino.destination({ dest: opts.file, sync: true, mkdir: true }),
  );
}
