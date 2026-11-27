import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatCost,
  formatCostLine,
  priceTokens,
  stepFromMessage,
  UNKNOWN_PRICE,
} from "../src/accounting/accounting.js";
import { priceSourceChecks, roleModelChecks } from "../src/cli/doctor.js";
import { type Price, PriceBook } from "../src/config/prices.js";
import type { AssistantMessage } from "../src/pi-rpc/events.js";
import { tempDir } from "./helpers.js";
import { connect, type Harness, makeHarness, start } from "./task-harness.js";

const msg = (cost: number, fromProvider = false): AssistantMessage => ({
  role: "assistant",
  provider: "9router",
  model: "Deepseek-v4.1-flash",
  usage: {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 500_000,
    cacheWrite: 0,
    cost: { total: cost, totalFromProvider: fromProvider },
  },
});
const price: Price = { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: null };
const book = {
  lookup: (p: string, m: string) =>
    p === "9router" && m === "Deepseek-v4.1-flash" ? price : undefined,
};

/** Stage 2 FR-116, FR-117: cost sources and the honest «цена неизвестна». */
describe("cost sources", () => {
  it("provider -> pi_event -> tokens_x_price -> unknown; zero cost is unknown", () => {
    expect(stepFromMessage("t", msg(0.5, true), book)).toMatchObject({
      cost: 0.5,
      cost_source: "provider",
    });
    expect(stepFromMessage("t", msg(0.4), book)).toMatchObject({
      cost: 0.4,
      cost_source: "pi_event",
    });
    const priced = stepFromMessage("t", msg(0, true), book);
    expect(priced?.cost_source).toBe("tokens_x_price");
    // 1M x 0.3 + 100k x 1.2 + 500k x 0.03 = 0.3 + 0.12 + 0.015
    expect(priced?.cost).toBeCloseTo(0.435, 6);
    expect(JSON.parse(priced?.price_json as string)).toEqual(price);
    expect(stepFromMessage("t", msg(0))).toMatchObject({ cost: 0, cost_source: "unknown" });
  });

  it("cache prices default to the input price", () => {
    expect(
      priceTokens(
        { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
        {
          input: 2,
          output: 8,
          cache_read: null,
          cache_write: null,
        },
      ),
    ).toBe(4);
  });
});

describe("cost line with unknown prices", () => {
  const usage = { cost: 0, input: 1000, output: 10, cache_read: 0, cache_write: 0 };
  it("says «цена неизвестна» instead of a sum; a partial sum names the unknown steps", () => {
    expect(formatCost(0, 3, 3)).toBe(UNKNOWN_PRICE);
    expect(formatCost(0.043, 3, 1)).toBe("0,043 $ без учёта 1 шага с неизвестной ценой");
    expect(formatCost(0.043, 9, 5)).toBe("0,043 $ без учёта 5 шагов с неизвестной ценой");
    expect(formatCost(0, 2, 0)).toBe("0,000 $");
    expect(
      formatCostLine({
        usage: { ...usage, steps: 2, unknown_steps: 2 },
        minutes: 1,
        quality: "PASS",
        sessionTotalUsd: 0.31,
        sessionUnknownSteps: 2,
      }),
    ).toBe(
      "цена неизвестна · 1k вход (0% из кэша) · 10 выход · 1 мин · PASS · " +
        "по сессии 0,31 $ без учёта 2 шагов с неизвестной ценой",
    );
    expect(
      formatCostLine({
        usage: { ...usage, steps: 1, unknown_steps: 1 },
        minutes: 1,
        quality: "PASS",
        sessionTotalUsd: 0,
        sessionUnknownSteps: 1,
      }),
    ).toMatch(/по сессии цена неизвестна$/);
  });
});

describe("doctor: price source of role models (FR-128)", () => {
  it("manual, catalog or unknown", () => {
    const dir = tempDir();
    try {
      const file = join(dir.path, "prices.yaml");
      writeFileSync(file, "- { provider: a, model: m1, input: 1, output: 2 }\n");
      const checks = priceSourceChecks(
        { roles: { code: { model: "a/m1" }, docs: { model: "b/m2" }, design: { model: "c/m3" } } },
        [
          { provider: "b", id: "m2", cost: { input: 0.5, output: 1 } },
          { provider: "c", id: "m3", cost: { input: 0, output: 0 } },
        ],
        file,
      );
      expect(checks.map((c) => [c.level, c.detail.split(":")[0], c.detail.split(": ")[1]])).toEqual(
        [
          ["ok", "a/m1", "ручная цена (prices.yaml)"],
          ["ok", "b/m2", "каталог Pi или стоимость от провайдера"],
          ["warn", "c/m3", expect.stringMatching(/^цена неизвестна/)],
        ],
      );
    } finally {
      dir.cleanup();
    }
  });
});

describe("doctor: role and chain models Pi does not list (stage 3 FR-201)", () => {
  const roles = {
    code: { model: "p/a", escalate: ["p/b", "p/c"] },
    docs: { model: "p/b" },
  };
  it("all visible: one ok line without the already probed default model", () => {
    const checks = roleModelChecks(
      { roles },
      ["a", "b", "c"].map((id) => ({ provider: "p", id })),
      "p/a",
    );
    expect(checks).toEqual([
      { level: "ok", name: "модели ролей", detail: "Pi видит все: p/b, p/c" },
    ]);
  });
  it("a missing chain model is a warning naming the role", () => {
    const checks = roleModelChecks(
      { roles },
      [
        { provider: "p", id: "a" },
        { provider: "p", id: "b" },
      ],
      "p/a",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.level).toBe("warn");
    expect(checks[0]?.detail).toMatch(/^p\/c нет среди моделей Pi: роль code \(эскалация\)/);
  });
  it("a missing role model that is also a chain model names both", () => {
    const checks = roleModelChecks({ roles }, [{ provider: "p", id: "c" }]);
    expect(checks.map((c) => c.detail.split(" нет")[0])).toEqual(["p/a", "p/b"]);
    expect(checks[1]?.detail).toContain("роль code (эскалация), docs");
  });
});

describe("cost on the TaskService level (fake worker)", () => {
  let dir: ReturnType<typeof tempDir>;
  let h: Harness | undefined;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(async () => {
    await h?.service.shutdown();
    dir.cleanup();
  });

  it("a zero-cost step without a manual price is «цена неизвестна» in the cost line and envelope", async () => {
    h = makeHarness(dir.path);
    await connect(h);
    const s = await start(h, "fake/zero-cost");
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    expect(w.cost_line).toMatch(/^цена неизвестна · /);
    expect(w.cost_line).toMatch(/по сессии цена неизвестна$/);
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.usage).toMatchObject({ cost_usd: 0, unknown_price_steps: 1 });
    expect(env.session_unknown_price_steps).toBe(1);
  });

  it("with a manual price the same step is tokens_x_price", async () => {
    const file = join(dir.path, "prices.yaml");
    writeFileSync(
      file,
      "- { provider: fake, model: zero-cost, input: 0.3, output: 1.2, cache_read: 0.03 }\n",
    );
    h = makeHarness(dir.path, { prices: new PriceBook(file) });
    await connect(h);
    const s = await start(h, "fake/zero-cost");
    const w = await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    // 1M x 0.3 + 100k x 1.2 + 600 cache reads x 0.03 = 0.42 + 0.000018
    expect(w.cost_line).toMatch(/^0,42 \$ · /);
    const env = await h.service.result(h.sessionId, s.task_id);
    expect(env.usage.unknown_price_steps).toBeUndefined();
    expect(h.repos.taskUsage(s.task_id)).toMatchObject({ steps: 1, unknown_steps: 0 });
  });
});
