import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const cfg = await import(pathToFileURL(join(process.cwd(), "src/config.js")).href);

test("the architect's answer is used", () => {
  assert.equal(cfg.DEFAULT_PORT, 8443);
  assert.equal(cfg.DEFAULT_HOST, "0.0.0.0");
});
