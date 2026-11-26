import { TASK_STATUSES, TRANSITIONS } from "@pi-hub/protocol";
import { describe, expect, it } from "vitest";

describe("task status machine", () => {
  it("defines transitions for every status", () => {
    for (const s of TASK_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
  });
  it("needs_input returns to planning or running", () => {
    expect(TRANSITIONS.needs_input).toEqual(expect.arrayContaining(["planning", "running"]));
  });
});
