---
description: Show this session's pi-hub workers, or check the setup (doctor).
argument-hint: "[doctor]"
---

- no args: call `status` of the `pi-hub` MCP server and show a short table: task, status, model, cost, minutes.
- `doctor`: run `pi-hub doctor` in the shell and show its output as is.
