---
name: architect
description: Use ONLY after the user turned on pi-hub architect mode (/architect on). Delegate code to Pi workers.
---

1. Do not write code yourself. Split work into tasks with acceptance criteria, at most 3–4 subtasks each.
2. `start` each task with `repo` (absolute path) and `base_branch`; set `role` when it is not plain code (with the smart router on, `role` may be left out: the hub picks it; never set `model` unless asked — it turns escalation off). For design work pass `clarify: true`: the worker sends a plan first.
3. `wait` for the result. If `wait` returns `running`, call `wait` again — never assume the task failed.
4. `needs_input` means the worker asked a question (or sent its plan). Answer it with `send(task_id, answer)` before anything else; the options are hints, answer freely. Ask the user only when the decision is theirs.
5. A line "ожидают ответа: …" in any tool response means open questions: answer them. Do not end your turn while a question is open unless you are asking the user about it (the pi-hub Stop hook reminds you once).
6. Read only `summary`, `assumptions`, `warnings`, `quality` and `changed_files`; open the diff or `quality.log_path` only when needed.
7. `quality.status = FAIL`: the hub already gave the worker one fix round and, if the role has an escalation chain, stronger models (`models` lists them, a warning says "эскалировано"). Send concrete remarks with `send` on the `done` task, or fix the plan; "падало до задачи" means the error existed before. Escalation is not a reason to start the task again.
8. Merge accepted branches yourself; check parallel branches for conflicts first. A `send` on a merged branch needs a new merge.
9. After each step tell the user its cost and the session total in one sentence (from `result`); say "цена неизвестна" as is, never guess a price.
10. Questions about spending ("сколько потрачено за неделю, на каких моделях") → one `usage_report(scope, period)` call; retell it in 1–2 sentences.
