import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubConfig, SystemOneConfig } from "../src/config/schema.js";
import { RoleRouter } from "../src/router/role-router.js";
import {
  type FetchLike,
  HttpSystemOne,
  type SystemOneAdapter,
  SystemOneError,
} from "../src/router/system-one/adapter.js";
import { tempDir } from "./helpers.js";
import { connect, type Harness, makeHarness } from "./task-harness.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", `system-one-${name}.json`), "utf8"),
  ) as { status: number; request: Record<string, unknown>; response: unknown };

const s1 = (over: Record<string, unknown> = {}) =>
  SystemOneConfig.parse({ preset: "9router", timeout_ms: 300, ...over });

/** A fetch that answers with a recorded fixture and keeps the request. */
function replay(name: string) {
  const f = fixture(name);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(f.response), { status: f.status });
  };
  return { f, calls, fetchImpl };
}

describe("System One adapter (contract, phase 0 fixtures)", () => {
  it("sends {model, state, questions} with the key and reads the jev-latest answer", async () => {
    const { f, calls, fetchImpl } = replay("jev-latest");
    const a = new HttpSystemOne(s1(), "k-test", fetchImpl);
    const req = f.request as { state: string; questions: never };
    const r = await a.decide(req.state, req.questions);
    expect(calls[0]?.url).toBe("https://omni-fr.archteam.org/v1/systemone");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(f.request);
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe("Bearer k-test");
    expect(r.model).toBe("jev-1.14.0");
    expect(r.answers.role).toMatchObject({ type: "choice", choice: "code", confidence: 1 });
    expect(r.usage).toEqual({ inputTokens: 398, outputTokens: 45 });
  });

  it("reads the clef-flash answer (no output tokens)", async () => {
    const { f, fetchImpl } = replay("clef-flash");
    const a = new HttpSystemOne(s1({ model: "ollama/clef-flash" }), "k", fetchImpl);
    const req = f.request as { state: string; questions: never };
    const r = await a.decide(req.state, req.questions);
    expect(r).toMatchObject({ model: "clef-flash", usage: { inputTokens: 219, outputTokens: 0 } });
  });

  it("HTTP 400, garbage, a wrong shape, a timeout and a missing key are SystemOneError", async () => {
    const q = { role: { type: "choice" as const, instructions: "x", criteria: { a: "a" } } };
    await expect(
      new HttpSystemOne(s1(), "k", replay("error-400").fetchImpl).decide("s", q),
    ).rejects.toThrow("HTTP 400: Missing required field: questions");
    const body =
      (b: string): FetchLike =>
      async () =>
        new Response(b, { status: 200 });
    await expect(new HttpSystemOne(s1(), "k", body("<html>")).decide("s", q)).rejects.toThrow(
      "ответ не JSON",
    );
    await expect(
      new HttpSystemOne(
        s1(),
        "k",
        body('{"model":"m","answers":{"role":{"type":"choice"}}}'),
      ).decide("s", q),
    ).rejects.toThrow(/неверный ответ: answers\.role/);
    const slow: FetchLike = (_u, init) =>
      new Promise((_r, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const t0 = Date.now();
    await expect(new HttpSystemOne(s1(), "k", slow).decide("s", q)).rejects.toThrow(
      "таймаут 300 мс",
    );
    expect(Date.now() - t0).toBeLessThan(1300);
    await expect(new HttpSystemOne(s1(), undefined, body("{}")).decide("s", q)).rejects.toThrow(
      "нет ключа NINEROUTER_API_KEY",
    );
  });
});

describe("RoleRouter (stage 3 FR-220)", () => {
  const config = (over: Record<string, unknown> = {}) =>
    HubConfig.parse({
      roles: {
        code: { model: "p/code-model", description: "writing code and tests" },
        docs: { model: "p/docs-model", description: "documentation only" },
      },
      default_role: "code",
      router: { smart: true, system_one: { preset: "9router" } },
      ...over,
    });
  const answer = (choice: string, confidence: number): SystemOneAdapter => ({
    decide: async () => ({
      model: "jev-1.14.0",
      answers: { role: { type: "choice", choice, confidence } },
      usage: { inputTokens: 300, outputTokens: 20 },
      latencyMs: 5,
    }),
  });
  let calls = 0;
  const counting = (inner: SystemOneAdapter): SystemOneAdapter => ({
    decide: (s, q) => {
      calls++;
      return inner.decide(s, q);
    },
  });

  it("takes the role at or above the threshold; the criteria are the role descriptions", async () => {
    let seen: unknown;
    const r = await new RoleRouter(config(), {
      decide: async (state, q) => {
        seen = { state, q };
        return answer("docs", 0.75).decide(state, q);
      },
    }).route({ task: "Update the README" });
    expect(r.choice).toMatchObject({ role: "docs", ref: "p/docs-model", routedBy: "system_one" });
    expect(r.choice.reason).toBe("system_one: role docs (0.75, jev-1.14.0) -> p/docs-model");
    expect(r.request?.model).toBe("jev-1.14.0");
    expect(seen).toMatchObject({
      state: "Task: Update the README",
      q: {
        role: {
          type: "choice",
          criteria: { code: "writing code and tests", docs: "documentation only" },
        },
      },
    });
  });

  it("below the threshold: default_role, the reason names confidence and threshold", async () => {
    const r = await new RoleRouter(config(), answer("docs", 0.6)).route({ task: "x" });
    expect(r.choice).toMatchObject({ role: "code", routedBy: "rules" });
    expect(r.choice.reason).toMatch(
      /^system_one: docs с уверенностью 0\.60 < 0\.75; default_role code/,
    );
    expect(r.request).toBeDefined();
  });

  it("errors and unknown roles fall back to rules with system_one_unavailable", async () => {
    const failing: SystemOneAdapter = {
      decide: async () => {
        throw new SystemOneError("таймаут 3000 мс");
      },
    };
    const a = await new RoleRouter(config(), failing).route({ task: "x" });
    expect(a.choice).toMatchObject({ role: "code", routedBy: "rules" });
    expect(a.choice.reason).toMatch(/^system_one_unavailable: таймаут 3000 мс; default_role code/);
    expect(a.request).toBeUndefined();
    const b = await new RoleRouter(config(), answer("design", 0.99)).route({ task: "x" });
    expect(b.choice.reason).toMatch(/^system_one_unavailable: роль design не из таблицы/);
  });

  it("no request with role or model, one role, or the smart router off", async () => {
    calls = 0;
    const a = counting(answer("docs", 1));
    expect((await new RoleRouter(config(), a).route({ task: "x", role: "code" })).choice.role).toBe(
      "code",
    );
    expect(
      (await new RoleRouter(config(), a).route({ task: "x", model: "p/m" })).choice.routedBy,
    ).toBe("architect");
    const one = config({ roles: { code: { model: "p/c" } } });
    expect(new RoleRouter(one, a).smart).toBe(false);
    await new RoleRouter(one, a).route({ task: "x" });
    const off = config({ router: { smart: false, system_one: { preset: "9router" } } });
    await new RoleRouter(off, a).route({ task: "x" });
    expect(calls).toBe(0);
  });
});

describe("start with the smart router (fake worker)", () => {
  let dir: ReturnType<typeof tempDir> | undefined;
  let h: Harness;
  afterEach(async () => {
    await h?.service.shutdown();
    dir?.cleanup();
  });

  it("records the request as a router step with the actual model; the route reason reaches start", async () => {
    dir = tempDir();
    const config = HubConfig.parse({
      roles: {
        code: { model: "fake/success", description: "code" },
        docs: { model: "fake/empty-diff", description: "docs" },
      },
      default_role: "code",
      router: { smart: true, system_one: { preset: "9router" } },
    });
    const adapter: SystemOneAdapter = {
      decide: async () => ({
        model: "jev-1.14.0",
        answers: { role: { type: "choice", choice: "docs", confidence: 0.9 } },
        usage: { inputTokens: 398, outputTokens: 45 },
        latencyMs: 7,
      }),
    };
    h = makeHarness(dir.path, { router: new RoleRouter(config, adapter), roles: config.roles });
    await connect(h);
    const s = await h.service.start(h.sessionId, {
      task: "Fix a typo in the README",
      repo: h.repo,
      base_branch: "main",
    });
    expect(s).toMatchObject({ model: "fake/empty-diff" });
    expect(s.route_reason).toContain("system_one: role docs (0.90, jev-1.14.0)");
    await h.service.waitFor(h.sessionId, s.task_id, 15_000);
    const router = h.repos
      .usageCostBy("model", { since: null })
      .find((r) => r.key === "9router/jev-1.14.0");
    expect(router).toMatchObject({ steps: 1, unknown_steps: 1, input: 398, output: 45 });
    expect(h.repos.getTask(s.task_id)).toMatchObject({ role: "docs", routed_by: "system_one" });
    const log = readFileSync(join(h.home, "logs", "router.log"), "utf8");
    expect(JSON.parse(log.trim())).toMatchObject({ task_id: s.task_id, ok: true, role: "docs" });
  });
});
