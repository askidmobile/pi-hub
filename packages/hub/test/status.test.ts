import { TASK_STATUSES, TERMINAL_STATUSES, TRANSITIONS } from "@pi-hub/protocol";
import { describe, expect, it } from "vitest";

describe("task status machine", () => {
  it("defines transitions for every status, only to known statuses", () => {
    for (const s of TASK_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined();
      for (const to of TRANSITIONS[s]) expect(TASK_STATUSES).toContain(to);
    }
  });

  it("needs_input returns to planning or running", () => {
    expect(TRANSITIONS.needs_input).toEqual(expect.arrayContaining(["planning", "running"]));
  });

  it("interrupted and failed can continue in the same Pi session (spec D-007)", () => {
    expect(TRANSITIONS.interrupted).toContain("running");
    expect(TRANSITIONS.failed).toContain("running");
  });

  it("cancelled is final; done reopens only for rework via send (stage 2 D-102)", () => {
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.done).toEqual(["running"]);
    expect(TERMINAL_STATUSES.has("done")).toBe(true);
  });
});
