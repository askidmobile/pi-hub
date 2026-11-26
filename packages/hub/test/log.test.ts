import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, createMasker, MASK, maskDeep } from "../src/log.js";
import { tempDir } from "./helpers.js";

describe("secret masking", () => {
  it("masks every occurrence, longest secret first, ignores short values", () => {
    const mask = createMasker(["sk-abcdef123", "sk-abcdef123456", "ab"]);
    expect(mask("key sk-abcdef123456 and sk-abcdef123 ab")).toBe(`key ${MASK} and ${MASK} ab`);
    expect(maskDeep({ a: ["x sk-abcdef123"], b: { c: "sk-abcdef123" }, n: 1 }, mask)).toEqual({
      a: [`x ${MASK}`],
      b: { c: MASK },
      n: 1,
    });
  });
});

describe("logger", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("writes JSON lines with ids and masked secrets", () => {
    const file = join(dir.path, "logs", "hub.log");
    const log = createLogger({ file, secrets: ["sk-live-SECRET-999"] });
    log
      .child({ task_id: "t_0001", senior_session_id: "s_1" })
      .info({ env: { KEY: "sk-live-SECRET-999" } }, "started with sk-live-SECRET-999");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk-live-SECRET-999");
    const rec = JSON.parse(text.trim().split("\n").at(-1) as string);
    expect(rec.task_id).toBe("t_0001");
    expect(rec.senior_session_id).toBe("s_1");
    expect(rec.msg).toBe(`started with ${MASK}`);
    expect(rec.env.KEY).toBe(MASK);
  });

  it("keeps error message and stack, masked", () => {
    const file = join(dir.path, "logs", "err.log");
    const log = createLogger({ file, secrets: ["sk-live-SECRET-999"] });
    log.error({ err: new Error("provider rejected sk-live-SECRET-999") }, "worker failed");
    const rec = JSON.parse(readFileSync(file, "utf8").trim());
    expect(rec.err.message).toBe(`provider rejected ${MASK}`);
    expect(rec.err.stack).toContain("Error: provider rejected ***");
  });
});
