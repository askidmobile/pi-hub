import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PriceBook, PricesError, parsePrices } from "../src/config/prices.js";
import { tempDir } from "./helpers.js";

/** Stage 2 FR-116: manual prices in ~/.pi-hub/prices.yaml. */
describe("prices.yaml", () => {
  let dir: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = join(dir.path, "prices.yaml");
  });
  afterEach(() => dir.cleanup());

  it("parses entries keyed by provider/model; cache prices are optional", () => {
    const m = parsePrices(
      [
        "- { provider: 9router, model: Deepseek-v4.1-flash, input: 0.07, output: 0.28, cache_read: 0.007 }",
        "- { provider: typesafe, model: jev-1.14.0, input: 0.042, output: 0, valid_from: 2026-11-26 }",
      ].join("\n"),
    );
    expect(m.get("9router/Deepseek-v4.1-flash")).toEqual({
      input: 0.07,
      output: 0.28,
      cache_read: 0.007,
      cache_write: null,
    });
    expect(m.get("typesafe/jev-1.14.0")?.cache_read).toBeNull();
    expect(parsePrices("").size).toBe(0);
  });

  it("rejects malformed files with the path of the bad field", () => {
    expect(() => parsePrices("- { provider: x, model: y, input: -1, output: 0 }")).toThrow(
      /0\.input/,
    );
    expect(() => parsePrices("- [unclosed")).toThrow(PricesError);
  });

  it("PriceBook: missing file means no prices; re-reads after a change; broken file reports and yields none", () => {
    const errors: Error[] = [];
    const book = new PriceBook(file, (e) => errors.push(e));
    expect(book.lookup("9router", "m")).toBeUndefined();

    writeFileSync(file, "- { provider: 9router, model: m, input: 1, output: 2 }\n");
    expect(book.lookup("9router", "m")?.output).toBe(2);

    writeFileSync(file, "- { provider: 9router, model: m, input: 1, output: 3 }\n");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000)); // a distinct mtime
    expect(book.lookup("9router", "m")?.output).toBe(3);

    writeFileSync(file, "- { provider: 9router }\n");
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(book.lookup("9router", "m")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(book.lookup("9router", "m")).toBeUndefined();
    expect(errors).toHaveLength(1); // reported once per change, not on every lookup
  });
});
