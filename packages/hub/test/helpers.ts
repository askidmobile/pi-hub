import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Short temp dirs: unix socket paths under them must stay below ~100 bytes. */
export function tempDir(prefix = "pihub-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A git repo with a committed README on `main` and a local identity. */
export function initRepo(path: string): string {
  const run = (args: string[]) => execFileSync("git", args, { cwd: path, stdio: "ignore" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(path, "README.md"), "# demo\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return path;
}

export const FAKE_WORKER = fileURLToPath(
  new URL("../../fake-worker/src/index.ts", import.meta.url),
);
export const FIXTURE_SUCCESS = fileURLToPath(
  new URL("./fixtures/pi-session-success.jsonl", import.meta.url),
);
