# pi-hub plugin for Claude Code

Thin plugin: MCP server (runs `pi-hub-shim`), `/architect on|off`, `/workers`, architect skill.
No logic and no provider keys here — everything lives in the hub. Hooks arrive in later stages.

Install: `pi-hub init` connects it, or by hand from the pi-hub repository root:

```bash
claude plugin marketplace add <path-to-pi-hub>
claude plugin install pi-hub@pi-hub-local --scope user
```
