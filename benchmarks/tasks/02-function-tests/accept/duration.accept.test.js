import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { parseDuration } = await import(pathToFileURL(join(process.cwd(), "src/duration.js")).href);

test("valid durations", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("1h2m3s"), 3723);
  assert.equal(parseDuration("90m"), 5400);
});
test("invalid durations throw", () => {
  for (const bad of ["", "5", "1x", "30m1h", "1.5h", "1h 30m", "h", "1h1h"]) {
    assert.throws(() => parseDuration(bad), Error, bad);
  }
});
