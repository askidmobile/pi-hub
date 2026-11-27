#!/usr/bin/env node
/**
 * Puts `pi-hub` and `pi-hub-shim` into a bin directory on PATH as tiny wrapper scripts that run
 * this checkout's build (`pnpm build` first). pnpm 12 has no `pnpm link --global`, and
 * `pnpm add -g` cannot resolve the `workspace:*` dependencies.
 *
 *   pnpm link:bins [<bin dir>]     # default: ~/.local/bin
 *
 * Existing files are replaced only if this script wrote them (they carry a marker line).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARKER = "# pi-hub link:bins";
const BINS = {
  "pi-hub": join(ROOT, "packages/hub/dist/cli/main.js"),
  "pi-hub-shim": join(ROOT, "packages/shim/dist/index.js"),
};

const dir = resolve(process.argv[2] ?? join(homedir(), ".local", "bin"));
for (const target of Object.values(BINS)) {
  if (!existsSync(target)) {
    console.error(`${target} not found: run pnpm build first`);
    process.exit(1);
  }
}
mkdirSync(dir, { recursive: true });
for (const [name, target] of Object.entries(BINS)) {
  const file = join(dir, name);
  if (existsSync(file) && !readFileSync(file, "utf8").includes(MARKER)) {
    console.error(`${file} exists and was not written by link:bins; left as is`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, `#!/bin/sh\n${MARKER}\nexec node "${target}" "$@"\n`);
  chmodSync(file, 0o755);
  console.log(`${file} -> ${target}`);
}
const onPath = (process.env.PATH ?? "").split(delimiter).some((p) => p && resolve(p) === dir);
if (!onPath) console.warn(`warning: ${dir} is not on PATH`);
