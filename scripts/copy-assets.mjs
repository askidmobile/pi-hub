// Copies non-TS assets into dist after `tsc -b` (plan PD-007).
import { cpSync, existsSync } from "node:fs";

const assets = [["packages/hub/src/storage/migrations", "packages/hub/dist/storage/migrations"]];

for (const [from, to] of assets) {
  if (!existsSync(from)) throw new Error(`asset source missing: ${from}`);
  cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".ts") });
}
