# Исследование: Pi, Codex, Claude Code (2026-11-26)

Проверено по текущей документации. Закрывает часть вопросов из [open-questions](../brief/open-questions.md).

## Pi (`@earendil-works/pi-coding-agent` 1.6.1)

Репозиторий переехал: `badlogic/pi-mono` → `earendil-works/pi`, пакет `@mariozechner/pi-coding-agent` (0.73) заменён на `@earendil-works/pi-coding-agent` (1.6.x, Node ≥ 22.19, бинарник `pi`).

**Режим RPC:** `pi --mode rpc [--provider P --model M --session-dir D --name N]`, долгоживущий дочерний процесс, JSONL в stdin/stdout.

- Кадрирование строгое: делить **только по LF**. `node:readline` нельзя — он режет по U+2028/U+2029, которые допустимы в JSON.
- stdout надо читать непрерывно, иначе Pi встанет на backpressure. stderr — только диагностика.
- Команды несут необязательный `id`, ответ `{"type":"response","command":…,"success":…}` повторяет его. События сессии без `id`.
- Успех `prompt` = принят (`disposition: started|queued|handled`), а не выполнен. Конец работы — событие **`agent_settled`** (не `agent_end`: после него бывают ретраи и компакция).
- Завершение: закрыть stdin (упорядоченное), SIGTERM тоже упорядоченный, второй сигнал — немедленный выход.
- В пакете есть готовый `RpcClient` (корреляция, типизированные методы, `promptAndWait`) и типы `rpc-types.ts`, `JsonAgentSessionEvent`.

**Токены и стоимость (OQ-01 — закрыт):** `message_update.usage` и финальное `message_end.message` несут `{input, output, cacheRead, cacheWrite, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}`. Стоимость Pi считает по своей таблице моделей (USD за 1M токенов в объекте модели). `get_session_stats` даёт итоги по сессии и заполненность окна контекста. Фактическую стоимость от OpenRouter Pi отдельно не передаёт — источник `provider` возможен только если Pi пробросит её (проверить).

**Смена модели и рассуждения (OQ-02 — закрыт):** `set_model {provider, modelId}`, `set_thinking_level {level: off|minimal|low|medium|high|xhigh|max}`, `get_available_models`, `get_available_thinking_levels`; событие `thinking_level_changed`.

**Подтверждения (OQ-03 — закрыт):** встроенной системы разрешений нет, это делается расширениями (событие `tool_call` + диалог). В режиме RPC диалоги расширений (`select`, `confirm`, `input`, `editor`) приходят как `extension_ui_request` и **блокируют** расширение до `extension_ui_response` с тем же `id`; есть `timeout` с автоответом по умолчанию.

→ **Вывод для архитектуры:** инструмент воркера `ask` реализуется расширением Pi через `ctx.ui.select/input`. Вопрос сам приходит хабу по stdout того же процесса, воркер ждёт без трат токенов, отдельный канал расширение ↔ хаб не нужен (ADR-0005).

Прочее полезное: `steer` / `follow_up` (доставка сообщений во время работы), `abort`, `switch_session` (продолжение после `interrupted`), `get_entries {since}` (курсор по журналу сессии), `compact`, `set_auto_retry`.

**Подключение расширения (OQ-15 — закрыт):** `-e <путь>`, `-ne` отключает остальные расширения, `PI_CODING_AGENT_DIR` — свой каталог конфигурации; диалоги расширения проверены вживую (ADR-0011). ACP и pi-jev — см. [system-one.md](system-one.md).

## Claude Code

- Хук `Stop`: вход `session_id`, `transcript_path`, `cwd`, `permission_mode`, `stop_hook_active`, `last_assistant_message`. Блокировка: `{"decision":"block","reason":…}` или exit 2. Не более 8 продолжений подряд (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- `SessionStart` даёт `session_id` и `source`. В окружении хуков и MCP-серверов плагина **нет** id сессии — только `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`. Связка shim ↔ сессия: хук SessionStart регистрирует `session_id` в хабе вместе с PID родителя; shim присылает тот же PID родителя.
- `tools/list_changed` **поддерживается** (OQ-07, Claude Code — закрыт): в интерактивной сессии список обновляется без переподключения.
- Плагин: `.claude-plugin/plugin.json`, в корне `.mcp.json`, `hooks/hooks.json`, `commands/`, `skills/`; `${CLAUDE_PLUGIN_ROOT}` в `command/args/env`.
- Файлы инструкций: читает `CLAUDE.md`, а `AGENTS.md` — нативно (если нет `CLAUDE.md`). **`AGENT.md` не читает**, переименование файла настройкой не поддерживается. См. OQ-12.
- Атрибуция: `settings.json` → `"attribution": {"commit": "", "pr": ""}` (старый `includeCoAuthoredBy` устарел). Прописано в `.claude/settings.json`.

## Codex

- Хуки: `hooks.json` в `~/.codex/`, `/etc/codex/`, `.codex/` проекта (только доверенного) или `[hooks]` в `config.toml`. События включают `SessionStart`, `Stop`, `SessionEnd`, `PreToolUse` и др.
- `Stop`: вход `session_id`, `cwd`, `transcript_path`, `turn_id`, `stop_hook_active`, `last_assistant_message`. `decision:"block"` + `reason` (или exit 2) — Codex продолжает, используя `reason` как следующий промпт. То, что нужно для вопросов воркера (OQ-05 — закрыт).
- Таймаут хука по умолчанию 600 с, задаётся `timeout`.
- MCP: `[mcp_servers.<id>]` — stdio (`command`, `args`, `env`, `cwd`) или HTTP (`url`, `bearer_token_env_var`), плюс `tool_timeout_sec`, `startup_timeout_sec`, `enabled_tools`.
- Профили: отдельные файлы `$CODEX_HOME/<name>.config.toml` + `--profile`; проектный `.codex/config.toml` профили игнорирует. Проверено на codex-cli 0.171.0: файл профиля принимает `mcp_servers` (`codex --profile X mcp list`), `[hooks]` в нём разбирается; отдельный `CODEX_HOME` не нужен (OQ-06 — закрыт, ADR-0009).
- Инструкции: `AGENTS.md`, плюс `project_doc_fallback_filenames` — так Codex прочитает `AGENT.md` (не используется: проект перешёл на `AGENTS.md`, BD-012).
- Проверено на codex-cli 0.171.0 тестовым MCP-сервером (2026-11-26):
  - под `-s workspace-write` stdio MCP-процесс подключается к unix-сокету (`/tmp/…`) и к HTTP на 127.0.0.1 (OQ-08 — закрыт);
  - путь unix-сокета длиннее ~104 символов даёт `EINVAL` (лимит `sun_path` в macOS) — путь сокета хаба держим коротким;
  - вызовы MCP-инструментов по умолчанию требуют подтверждения; в `codex exec` с `approval: never` они отклоняются. Ключ `mcp_servers.<id>.default_tools_approval_mode`: `auto | prompt | writes | approve`;
  - после `notifications/tools/list_changed` новый инструмент недоступен ни в том же ходе, ни в следующем ходе интерактивной сессии — Codex фиксирует список при старте (OQ-07 — закрыт, ADR-0010).

## Следствие для `wait`

У клиентов есть таймаут вызова инструмента (в Codex `tool_timeout_sec`, у Claude Code свой). `wait(timeout)` хаб ограничивает сверху значением ниже таймаута клиента и возвращает `running`, если ничего не случилось, — старший просто вызывает `wait` снова. Это закладывается в протокол (ADR-0006).

## Источники

- https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs (`rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`)
- https://code.claude.com/docs/en/hooks, /mcp, /plugins-reference, /memory, /settings-reference
- https://learn.chatgpt.com/docs/hooks, /extend/mcp, /config-file/config-reference, /agent-configuration/agents-md
