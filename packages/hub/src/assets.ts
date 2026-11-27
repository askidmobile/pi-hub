import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Directory of the bundled @pi-hub/pi-extension package. */
export function piExtensionDir(): string {
  return dirname(require.resolve("@pi-hub/pi-extension/package.json"));
}

/** Extension entry Pi loads with `-e` (TypeScript source, loaded by Pi via jiti; plan PD-004). */
export function defaultExtensionPath(): string {
  return join(piExtensionDir(), "src", "index.ts");
}

export function workerPromptTemplatePath(): string {
  return join(piExtensionDir(), "src", "worker-prompt.md");
}

/** The Claude Code plugin of this repository (`plugins/claude-code`). */
export function claudePluginDir(): string {
  return join(piExtensionDir(), "..", "..", "plugins", "claude-code");
}

/** The Codex integration of this repository (`plugins/codex`). */
export function codexPluginDir(): string {
  return join(piExtensionDir(), "..", "..", "plugins", "codex");
}
