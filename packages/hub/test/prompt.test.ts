import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultExtensionPath } from "../src/assets.js";
import { renderTemplate, writeWorkerPrompt } from "../src/tasks/prompt.js";
import { tempDir } from "./helpers.js";

describe("worker prompt", () => {
  it("renders branch and base into <prompts>/<task>.md with the stage 1 rules", () => {
    const dir = tempDir();
    try {
      const file = writeWorkerPrompt(dir.path, "t_0007", {
        branch: "pi/t_0007",
        base_branch: "main",
      });
      const text = readFileSync(file, "utf8");
      expect(text).toContain("`pi/t_0007`");
      expect(text).toContain("`main`");
      expect(text).toContain("report_assumption");
      expect(text).toContain("SUMMARY:");
      expect(text).not.toMatch(/\{\{/);
    } finally {
      dir.cleanup();
    }
  });

  it("fails on unknown placeholders", () => {
    expect(() => renderTemplate("{{nope}}", {})).toThrow(/nope/);
  });

  it("resolves the bundled extension entry", () => {
    expect(defaultExtensionPath()).toMatch(/pi-extension\/src\/index\.ts$/);
  });
});
