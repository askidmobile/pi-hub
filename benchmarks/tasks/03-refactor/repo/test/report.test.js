import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceLine, refund, total } from "../src/report.js";

test("invoice line", () => {
  assert.equal(invoiceLine({ name: "Tea", cents: 350, currency: "EUR" }), "Tea: 3.50 EUR");
  assert.equal(invoiceLine({ name: "Fix", cents: -5, currency: "USD" }), "Fix: -0.05 USD");
});
test("total", () => {
  const items = [{ cents: 1999 }, { cents: 1 }];
  assert.equal(total(items, "EUR"), "Total: 20.00 EUR");
  assert.equal(total([], "EUR"), "Total: 0.00 EUR");
});
test("refund", () => assert.equal(refund(1250, "USD"), "Refund: -12.50 USD"));
