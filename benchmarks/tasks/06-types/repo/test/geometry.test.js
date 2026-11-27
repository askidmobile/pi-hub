import assert from "node:assert/strict";
import { test } from "node:test";
import { area, largest, perimeter } from "../src/geometry.js";

test("area", () => {
  assert.equal(area({ kind: "rect", w: 2, h: 3 }), 6);
  assert.ok(Math.abs(area({ kind: "circle", r: 1 }) - Math.PI) < 1e-9);
});
test("perimeter", () => assert.equal(perimeter({ kind: "rect", w: 2, h: 3 }), 10));
test("largest", () => {
  const big = { kind: "rect", w: 10, h: 10 };
  assert.equal(largest([{ kind: "circle", r: 1 }, big]), big);
});
