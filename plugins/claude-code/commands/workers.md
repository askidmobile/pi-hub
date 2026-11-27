---
description: Show this session's pi-hub workers and their questions, or check the setup (doctor).
argument-hint: "[doctor]"
---

- no args: call `status` of the `pi-hub` MCP server and show a short table: task, status, model, cost, minutes. For tasks in `needs_input` call `wait` with `timeout: 1` and show the question with its options under the table.
- `doctor`: run `pi-hub doctor` in the shell and show its output as is.
