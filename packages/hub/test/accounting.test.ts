import { describe, expect, it } from "vitest";
import {
  cachedShare,
  formatCostLine,
  formatTokens,
  formatUsd,
  stepFromMessage,
} from "../src/accounting/accounting.js";
import { ModelSelectionError, parseModelRef, resolveModel } from "../src/router/model-resolver.js";

describe("cost line (spec §8)", () => {
  it("matches the spec example", () => {
    const line = formatCostLine({
      usage: { cost: 0.043, input: 52_780, cache_read: 129_220, cache_write: 0, output: 9_000 },
      minutes: 6,
      quality: "SKIPPED",
      sessionTotalUsd: 0.31,
    });
    expect(line).toBe(
      "0,043 $ · 182k вход (71% из кэша) · 9k выход · 6 мин · SKIPPED · по сессии 0,31 $",
    );
  });

  it("formats edge values", () => {
    expect(formatUsd(0)).toBe("0,000 $");
    expect(formatUsd(1.234)).toBe("1,23 $");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_250_000)).toBe("1,3M");
    expect(cachedShare({ input: 0, cache_read: 0, cache_write: 0 })).toBe(0);
    expect(
      formatCostLine({
        usage: { cost: 0, input: 0, cache_read: 0, cache_write: 0, output: 0 },
        minutes: 0.2,
        quality: "SKIPPED",
        sessionTotalUsd: 0,
      }),
    ).toContain("<1 мин");
  });

  it("marks provider-reported cost as cost_source=provider", () => {
    const s = stepFromMessage("t_1", {
      role: "assistant",
      provider: "openrouter",
      model: "x",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.5, totalFromProvider: true },
      },
    });
    expect(s?.cost_source).toBe("provider");
    expect(stepFromMessage("t_1", { role: "assistant" })).toBeNull();
  });
});

describe("model resolver (FR-009, D-002)", () => {
  const config = {
    roles: { code: { model: "deepseek/deepseek-flash" }, design: { model: "moonshotai/kimi-k3" } },
    default_role: "code",
  };

  it("prefers the explicit model, then the role, then default_role", () => {
    expect(
      resolveModel({ model: "openrouter/deepseek/deepseek-v4-flash", role: "design" }, config),
    ).toMatchObject({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      routedBy: "architect",
    });
    expect(resolveModel({ role: "design" }, config)).toMatchObject({
      ref: "moonshotai/kimi-k3",
      routedBy: "rules",
      role: "design",
    });
    expect(resolveModel({}, config)).toMatchObject({
      ref: "deepseek/deepseek-flash",
      role: "code",
      reason: "default_role code -> deepseek/deepseek-flash",
    });
    expect(resolveModel({ role: "nope" }, config).reason).toContain("unknown role nope");
  });

  it("errors when nothing is configured or the reference is malformed", () => {
    expect(() => resolveModel({}, { roles: {}, default_role: "code" })).toThrow(
      ModelSelectionError,
    );
    expect(() => parseModelRef("no-provider")).toThrow(/provider/);
    expect(() => parseModelRef("a/")).toThrow();
  });
});
