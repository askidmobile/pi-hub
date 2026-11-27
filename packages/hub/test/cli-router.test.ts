import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routerChecks } from "../src/cli/doctor.js";
import {
  failuresInRow,
  formatRouterStatus,
  formatRouterTest,
  routerState,
  routerTest,
  writeRouterConfig,
} from "../src/cli/router.js";
import { loadHubConfig } from "../src/config/load.js";
import { HubConfig } from "../src/config/schema.js";
import type { FetchLike } from "../src/router/system-one/adapter.js";
import { tempDir } from "./helpers.js";

/** Stage 3 FR-223, FR-224: router config in place, status, test, doctor. */
describe("pi-hub router", () => {
  let dir: ReturnType<typeof tempDir>;
  let env: NodeJS.ProcessEnv;
  let config: string;
  beforeEach(() => {
    dir = tempDir();
    env = { PI_HUB_HOME: join(dir.path, "h") };
    mkdirSync(join(dir.path, "h"), { recursive: true });
    config = join(dir.path, "h", "config.yaml");
    writeFileSync(
      config,
      [
        "# my comment stays",
        "roles:",
        "  code: { model: a/b, description: code } # inline note",
        "  docs: { model: a/d }",
        "default_role: code",
        "router:",
        "  smart: false",
        "",
      ].join("\n"),
    );
  });
  afterEach(() => dir.cleanup());

  it("writes the router block, keeps comments; off keeps the System One settings", () => {
    expect(
      writeRouterConfig(config, {
        smart: true,
        preset: "9router",
        api_key_env: "NINEROUTER_API_KEY",
      }),
    ).toBe(true);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("# my comment stays");
    expect(text).toContain("# inline note");
    expect(loadHubConfig(config).router).toMatchObject({
      smart: true,
      system_one: { preset: "9router", model: "typesafe/jev-latest" },
    });
    expect(writeRouterConfig(config, { smart: false })).toBe(true);
    expect(writeRouterConfig(config, { smart: false })).toBe(false);
    expect(loadHubConfig(config).router).toMatchObject({
      smart: false,
      system_one: { preset: "9router" },
    });
  });

  it("status names the key, the roles without description and failures in a row", () => {
    writeRouterConfig(config, { smart: true, preset: "9router" });
    mkdirSync(join(dir.path, "h", "logs"));
    const log = join(dir.path, "h", "logs", "router.log");
    writeFileSync(
      log,
      ['{"ok":false}', '{"ok":true}', '{"ok":false}', '{"ok":false}', '{"ok":false}'].join("\n"),
    );
    expect(failuresInRow(log)).toBe(3);
    const s = routerState(env);
    expect(s).toMatchObject({ on: true, keySet: false, roles: 2, failuresInRow: 3 });
    expect(s.rolesWithoutDescription).toEqual(["docs"]);
    const text = formatRouterStatus(s);
    expect(text).toContain("NINEROUTER_API_KEY не задан");
    expect(text).toContain("без описания: docs");
    expect(text).toContain("сбоев подряд: 3");
  });

  it("router test asks one question and prints model, latency, answer and cost", async () => {
    writeRouterConfig(config, { smart: true, preset: "9router" });
    writeFileSync(join(dir.path, "h", ".env"), "NINEROUTER_API_KEY=k-test\n", { mode: 0o600 });
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_u, init) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: { role: { type: "choice", choice: "code", confidence: 0.97 } },
          usage: { input_tokens: 300, output_tokens: 10 },
        }),
      );
    };
    const r = await routerTest(env, fetchImpl);
    expect(body).toMatchObject({
      model: "typesafe/jev-latest",
      questions: { role: { criteria: { code: "code", docs: "docs" } } },
    });
    expect(formatRouterTest(r)).toMatch(
      /^System One jev-1\.14\.0: code \(уверенность 0\.97\) · \d+ мс · цена неизвестна$/,
    );
  });

  it("doctor: not set up, off, missing key, one role, no descriptions, failures", () => {
    const cfg = (o: Record<string, unknown>) => HubConfig.parse(o);
    const log = join(dir.path, "none.log");
    expect(routerChecks(cfg({}), {}, log)[0]).toMatchObject({ level: "ok" });
    const s1 = { preset: "9router" };
    expect(
      routerChecks(cfg({ router: { smart: false, system_one: s1 } }), {}, log)[0]?.detail,
    ).toMatch(/^выключен/);
    const one = routerChecks(
      cfg({ roles: { code: { model: "a/b" } }, router: { smart: true, system_one: s1 } }),
      {},
      log,
    );
    expect(one.map((c) => c.level)).toEqual(["warn", "warn"]);
    expect(one[1]?.detail).toContain("одна роль");
    const bare = routerChecks(
      cfg({
        roles: { code: { model: "a/b" }, docs: { model: "a/d", description: "docs" } },
        default_role: "code",
        router: { smart: true, system_one: s1 },
      }),
      { NINEROUTER_API_KEY: "k" },
      log,
    );
    expect(bare.map((c) => [c.level, c.detail])).toEqual([
      ["ok", "9router · typesafe/jev-latest"],
      ["warn", "роли без описания (description): code"],
    ]);
  });
});
