# pi-hub integration for Codex

- `pi-hub.config.toml` — the architect profile block. `pi-hub init` writes it into `~/.codex/pi-hub.config.toml` between `# >>> pi-hub` and `# <<< pi-hub` (a `.bak` copy first) and never touches the rest of the file. Contains `[mcp_servers.pi-hub]` and the Stop hook; no SessionStart hook is needed (the hub finds the session by process ancestry).
- `hooks/hooks.json` — fallback if profile hooks do not load: put into `~/.codex/hooks.json`; the hook exits in < 100 ms when the session has no pi-hub shim.
- `prompts/`, `skills/architect` — commands and architect rules.

## First run

1. `pi-hub init` (Codex in PATH) installs or updates the profile; `--no-codex` skips it.
2. Run `codex --profile pi-hub` in the project folder, type `/hooks` and trust the pi-hub Stop hook. Trust the project folder when asked.
3. `pi-hub doctor` shows `✓ хук Codex: доверен`.
4. From then on use `codex --profile pi-hub` (alias `codex-arch`). Turn delegation on with `/architect on`: like every client, it is off on connect and the hub refuses calls until then.

Codex stores trust inside the profile file (`[hooks.state…]`, `[projects…]`), so never overwrite the file wholesale. Untrusted hooks are skipped silently; a changed hook command needs trusting again.

Plain `codex` (no profile) does not see pi-hub at all: zero cost for the senior.
Stop hook semantics: `{"decision":"block","reason":…}` → Codex continues with `reason` as the next prompt; the hub blocks once per worker question.
