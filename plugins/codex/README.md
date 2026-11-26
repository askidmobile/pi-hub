# pi-hub integration for Codex

- `pi-hub.config.toml` — architect profile: copy to `~/.codex/pi-hub.config.toml`, start with `codex --profile pi-hub` (alias `codex-arch`). Contains `[mcp_servers.pi-hub]` and the SessionStart / Stop hooks.
- `hooks/hooks.json` — fallback if profile hooks turn out not to load: put into `~/.codex/hooks.json`; hooks exit in < 100 ms when the session has no pi-hub shim.
- `prompts/`, `skills/architect` — commands and architect rules.

## First run

1. Copy `pi-hub.config.toml` to `~/.codex/` (or let `pi-hub init` do it).
2. Run `codex --profile pi-hub` once in the project folder.
3. When Codex asks, trust the project folder and the two pi-hub hooks.
4. From then on use `codex --profile pi-hub` (alias `codex-arch`).

Codex stores this trust inside the profile file (`[hooks.state…]`, `[projects…]`), so never overwrite the file wholesale: update only pi-hub keys. Untrusted hooks are skipped silently; changing a hook command requires trusting it again.

Plain `codex` (no profile) does not see pi-hub at all: zero cost for the senior (level 1 in the spec).
Stop hook semantics: `{"decision":"block","reason":…}` → Codex continues with `reason` as the next prompt.
