import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Manual model prices, `~/.pi-hub/prices.yaml` (stage 2 FR-116, plan PD-109): only for models
 * whose cost neither the provider nor Pi's catalog reports (providers from extensions,
 * System One, custom deals). USD per 1M tokens. The file is re-read when its mtime changes.
 */
export const PriceEntry = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().nullable().optional(),
  cache_write: z.number().nonnegative().nullable().optional(),
  /** Informational: when the price was taken from the provider's page. */
  valid_from: z.union([z.string(), z.date()]).optional(),
});
export type PriceEntry = z.infer<typeof PriceEntry>;

/** The price stored with a step (`steps.price_json`). */
export interface Price {
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
}

export class PricesError extends Error {
  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "PricesError";
  }
}

export function parsePrices(text: string, file = "prices.yaml"): Map<string, Price> {
  let raw: unknown;
  try {
    raw = parse(text) ?? [];
  } catch (e) {
    throw new PricesError(file, (e as Error).message);
  }
  const r = z.array(PriceEntry).safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new PricesError(
      file,
      `${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const out = new Map<string, Price>();
  for (const e of r.data) {
    out.set(`${e.provider}/${e.model}`, {
      input: e.input,
      output: e.output,
      cache_read: e.cache_read ?? null,
      cache_write: e.cache_write ?? null,
    });
  }
  return out;
}

/** Looks prices up by `provider/model`; a missing file means no manual prices. */
export class PriceBook {
  private mtimeMs = -1;
  private prices = new Map<string, Price>();

  constructor(
    private readonly file: string,
    private readonly onError: (e: Error) => void = () => {},
  ) {}

  lookup(provider: string, model: string): Price | undefined {
    this.refresh();
    return this.prices.get(`${provider}/${model}`);
  }

  private refresh(): void {
    const st = statSync(this.file, { throwIfNoEntry: false });
    const mtime = st?.mtimeMs ?? 0;
    if (mtime === this.mtimeMs) return;
    this.mtimeMs = mtime;
    if (!st) {
      this.prices = new Map();
      return;
    }
    try {
      this.prices = parsePrices(readFileSync(this.file, "utf8"), this.file);
    } catch (e) {
      // A broken file must not break accounting: keep no manual prices and report once.
      this.prices = new Map();
      this.onError(e as Error);
    }
  }
}
