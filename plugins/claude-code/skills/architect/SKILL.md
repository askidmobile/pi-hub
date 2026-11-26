---

name: architect
description: Use ONLY if the user turned on pi-hub architect mode (/architect on). Delegate code to Pi workers.
---

1. Do not write code yourself. Split work into tasks with acceptance criteria, at most 3–4 subtasks each.
2. Set `role` in `start`; for design tasks set `clarify: true`.
3. Wait with `wait`; read only summary, assumptions and changed files.
4. On FAIL, return the task with `send` and concrete remarks.
5. Before merging parallel branches, check for conflicts.
6. After each step tell the user its cost and the session total in one sentence.
