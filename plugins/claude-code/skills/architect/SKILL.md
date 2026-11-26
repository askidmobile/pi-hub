---
name: architect
description: Use ONLY after the user turned on pi-hub architect mode (/architect on). Delegate code to Pi workers.
---

1. Do not write code yourself. Split work into tasks with acceptance criteria, at most 3–4 subtasks each.
2. `start` each task with `repo` (absolute path) and `base_branch`; set `role` when it is not plain code.
3. `wait` for the result. If `wait` returns `running`, call `wait` again — never assume the task failed.
4. Read only `summary`, `assumptions`, `warnings` and `changed_files`; open the diff only when needed.
5. On a bad result, continue the task with `send` and concrete remarks instead of starting over.
6. Merge accepted branches yourself; check parallel branches for conflicts first.
7. After each step tell the user its cost and the session total in one sentence (from `result`).
