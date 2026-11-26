import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlreadyRunningError, acquireLock } from "../src/daemon.js";
import { tempDir } from "./helpers.js";

describe("daemon lock file", () => {
  let dir: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = join(dir.path, "hub.lock");
  });
  afterEach(() => dir.cleanup());

  it("holds our PID from the moment it exists and leaves no temp files", () => {
    const release = acquireLock(file);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    expect(readdirSync(dir.path)).toEqual(["hub.lock"]);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses while a live process holds it", () => {
    writeFileSync(file, String(process.ppid));
    expect(() => acquireLock(file)).toThrow(AlreadyRunningError);
    expect(readFileSync(file, "utf8")).toBe(String(process.ppid));
  });

  it("takes over a lock of a dead process or an empty one", () => {
    for (const stale of ["999999", ""]) {
      writeFileSync(file, stale);
      const release = acquireLock(file);
      expect(readFileSync(file, "utf8")).toBe(String(process.pid));
      release();
    }
  });
});
