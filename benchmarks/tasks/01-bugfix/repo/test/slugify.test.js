import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.js";

test("simple title", () => assert.equal(slugify("Hello World"), "hello-world"));
test("trims and collapses spaces", () =>
  assert.equal(slugify("  Hello,   World  "), "hello-world"));
test("tabs and newlines are spaces", () => assert.equal(slugify("a\tb\nc"), "a-b-c"));
test("digits stay", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));
test("no leading or trailing dash", () => assert.equal(slugify("--Draft--"), "draft"));
