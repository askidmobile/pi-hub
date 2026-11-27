# pi-hub plugin for Claude Code

Thin plugin: MCP server (runs `pi-hub-shim`), Stop hook (`pi-hub-shim hook stop`),
`/architect on|off`, `/workers`, architect skill. No logic and no provider keys here —
everything lives in the hub.

Install: `pi-hub init` connects it, or by hand from the pi-hub repository root:

```bash
claude plugin marketplace add <path-to-pi-hub>
claude plugin install pi-hub@pi-hub-local --scope user
```

## Worker questions

A worker asks with its `ask` tool; the task goes to `needs_input`. The architect learns it
three ways: `wait` returns the question at once, every pi-hub tool response carries the line
«ожидают ответа: …», and the Stop hook does not let Claude end the turn once per question.
The answer goes back with `send(task_id, answer)`. The hook never blocks when the hub is down,
the mode is `off` or the question was already shown; its decisions are in
`~/.pi-hub/logs/hooks.log`.

## Quality gate

Put the project's checks into `.pi-hub.toml` in the repository root:

```toml
setup = "pnpm install --frozen-lockfile"

[quality]
test = "pnpm test"
lint = "pnpm lint"
typecheck = "pnpm typecheck"
timeout_minutes = 15
```

After the worker finishes, the hub runs them in the task worktree, gives the worker one
automatic fix round for new errors and returns `PASS`, `FAIL` or `SKIPPED` with short issues;
the full output is in `quality.log_path`. Errors that also fail on the base commit are marked
«падало до задачи».

## Cost

Cost is information, not a limit. When neither the provider nor Pi's catalog knows the price,
the cost line says «цена неизвестна»; add the price to `~/.pi-hub/prices.yaml`
(example: `config/prices.example.yaml`), and `pi-hub doctor` shows where each role model's
price comes from.
