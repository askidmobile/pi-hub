---

description: Show pi-hub workers. Subcommands - all, adopt <id>, doctor.
argument-hint: [all | adopt <id> | doctor]
---

- no args: call `status` and show this session's tasks with status and cost.
- `all`: call `status` with scope `all` (needs admin token).
- `adopt <id>`: take over an orphaned task.
- `doctor`: run `pi-hub doctor` and show the checks (config, key, Pi, router, Codex profile and hook trust, shim, daemon).
