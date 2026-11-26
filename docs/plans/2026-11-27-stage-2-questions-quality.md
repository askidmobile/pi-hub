# Plan: Этап 2 — вопросы воркера и проверка качества

**Date:** 2026-11-27
**Status:** 🔄 Implementing
**Priority:** P1
**Specification:** [docs/specs/2026-11-27-stage-2-questions-quality.md](../specs/2026-11-27-stage-2-questions-quality.md)

## Goal

Вопрос воркера доходит до старшего тремя путями (`wait`, строка в ответах инструментов, хук Stop), ответ через `send` продолжает ту же сессию Pi. Каждый результат приходит с вердиктом проверки качества, мелкие ошибки воркер исправляет сам за один авто-круг. Стоимость — справка с честной пометкой «цена неизвестна».

## Current state

- **Запуск воркера** `packages/hub/src/tasks/worker-runner.ts` (`WorkerRun`): один проход `prompt → agent_settled → checking → finalize → done`, после чего Pi останавливается. События `ui_request` распознаются (`pi-rpc/events.ts`), но не обрабатываются; запись ответа без команды есть в `PiRpcClient`.
- **Сервис задач** `tasks/task-service.ts`: `start`, `waitFor`, `send` (только `interrupted`/`failed`, режим `continue` с `switch_session`), `pump()` считает слоты по живым запускам, `recover()`.
- **Финализация** `tasks/finalize.ts`: `ensureSummary` (один `follow_up` без `SUMMARY:`), авто-коммит, атрибуция, предупреждения; `quality_status` всегда `SKIPPED`.
- **Проверка качества**: интерфейс `quality/quality-gate.ts`; команды `quality.test/lint/typecheck` в схеме `.pi-hub.toml` (`config/schema.ts`). Запуск команды с таймаутом и убийством группы процессов уже есть в `WorkspaceManager.runSetup`.
- **Учёт** `accounting/accounting.ts`: `record()` из `message_end`, `cost_source` = `provider|pi_event`; `steps.cost_source` ограничен `CHECK` без значения `unknown` (`001_init.sql`).
- **Протокол** `packages/protocol`: переход `done → running` отсутствует; в `hub-wire.ts` есть заготовка `PendingQuestionsQuery`, но сервер (`transport/unix-server.ts`) принимает только `hello`. `PROTOCOL_VERSION = 0.1.0`.
- **Фасад** `facade/mcp-facade.ts`: `waitWithProgress`, регистрация инструментов, строки об ожидающих вопросах нет.
- **Shim** `packages/shim/src/index.ts`: только MCP-труба и заглушка; подкоманд нет.
- **Плагин** `plugins/claude-code`: хуков нет; скил без правил о вопросах и FAIL.
- **Расширение** `packages/pi-extension/src/index.ts`: только `report_assumption`; промпт запрещает вопросы.
- **Фейковый воркер** `packages/fake-worker/src/index.ts`: сценарии этапа 1, диалогов расширения не умеет.
- **Пределы** `limits.max_task_usd`/`max_task_minutes` с значениями по умолчанию 2 $ / 60 мин.

## Solution architecture

```mermaid
graph TD
    subgraph Pi воркер
      EXT[расширение pi-hub: ask, report_assumption]
    end
    EXT -- extension_ui_request --> WR[WorkerRun]
    WR -- extension_ui_response --> EXT
    WR --> QS[QuestionService: запись, ответ, доставка хуком]
    QS --> DB[(questions)]
    WR -- checking --> QG[QualityGate]
    QG --> BL[(quality_baselines)]
    QG -- команды .pi-hub.toml --> WT[worktree задачи / временный worktree базы]
    QG -- FAIL: 1 авто-круг --> WR
    WR --> ACC[Accounting: provider → pi_event → prices.yaml → unknown]
    TS[TaskService: send, waitFor, pump] --> WR
    F[MCP-фасад + строка вопросов] --> TS
    F --> QS
    US[unix-server: hello | hook_query] --> F
    US -- hook_query --> HR[HookResolver: предки процесса → сессия, запасной путь по проекту]
    HR --> QS
    SH[pi-hub-shim hook stop] -- сокет --> US
    CC[Claude Code: хук Stop плагина] --> SH
```

Ключевое изменение: `WorkerRun` перестаёт быть одним проходом. Процесс Pi живёт, пока задача в `running`, `needs_input` или в авто-круге проверки, и останавливается только после итогового `done`/`failed` или по `cancel`/остановке хаба. Ответ на `ask` — запись `extension_ui_response` в живой процесс; ответ на вопрос текстом и авто-круг — новый `prompt` в тот же процесс.

## Solution

### Protocol (`packages/protocol/src`)

- [x] `status.ts` — переход `done → running` (D-102); комментарий о смысле `done` = «готово к слиянию».
- [x] `envelope.ts` — `QualityResult { status, issues: string[], log_path? }`; поля `attempt`, `questions: { asked, answered }`; тип `OpenQuestion { task_id, round, kind, question, options? }`; `WaitResult` с `question?`.
- [x] `tools.ts` — `StartInput.clarify?: boolean`; описание `send` — «ответ на вопрос, доработка или продолжение»; описания по одной фразе.
- [x] `hub-wire.ts` — `HookQuery { type: "hook_query", protocol_version, event: "stop", pid, cwd, stop_hook_active? }` и `HookReply { block: boolean, reason?: string }` с zod-схемами; заготовка `PendingQuestionsQuery` заменяется ими.
- [x] `version.ts` — `PROTOCOL_VERSION = 0.2.0` (новый тип первой строки; старый shim совместим — его сообщения не меняются).

### Hub (`packages/hub/src`)

#### Files:
- [x] `storage/migrations/004_questions_quality.sql` — новые поля `questions` (`kind`, `pi_dialog_id`, `resume_status`, `hook_delivered_at`); `tasks.quality_issues_json`, `tasks.quality_log_path`; таблица `quality_baselines`; пересборка `steps` с `cost_source` ∈ `provider|pi_event|tokens_x_price|unknown` и полем `price_json`.
- [x] `storage/repos.ts` — вопросы: `insertQuestion`, `openQuestion(taskId)`, `answerQuestion`, `closeQuestion`, `openQuestionsForSession(sessionId)`, `markHookDelivered`, `countQuestions(taskId)`; базовые проверки: `getBaseline(projectId, commit)`, `putBaseline`; сессии: `sessionsByParentPids(pids)`, `connectedSessionsForProject(projectId, client)`.
- [x] `config/schema.ts` — `limits.max_task_usd` и `limits.max_task_minutes` необязательные, без значений по умолчанию (D-105); в `ProjectConfig.quality` — `timeout_minutes` (по умолчанию 15).
- [x] `config/prices.ts` — загрузка `~/.pi-hub/prices.yaml` (zod-схема по `config/prices.example.yaml`), перечитывание по `mtime`, поиск цены по `provider/model`.
- [ ] `pi-rpc/pi-rpc-client.ts` — `respondUi(id, value | cancelled)`; ожидание `agent_settled` можно запускать повторно (несколько `prompt` в одном процессе).
- [ ] `tasks/questions.ts` (новый) — `QuestionService`: разбор диалога pi-hub (маркер в `title`), запись вопроса, ответ, отказ на чужие диалоги, текст для хука и строки вопросов.
- [ ] `tasks/worker-runner.ts` — жизненный цикл с живым Pi: обработка `ui_request` (→ `needs_input`, пауза таймера), `answer(text)`; `clarify` (`planning`); вопрос текстом (FR-120) до `ensureSummary`; финализация → проверка качества → авто-круг → итог; остановка Pi только в конце; пределы — только если заданы.
- [ ] `tasks/finalize.ts` — `detectTextQuestion(finalText)`; `detectTestTampering(diff)` (удалённые файлы тестов, пометки пропуска); предупреждение о файлах, изменённых в фазе плана.
- [ ] `tasks/prompt.ts` + `packages/pi-extension/src/worker-prompt.md` — правила `ask` (FR-115), запрет трогать тесты ради проверки (FR-121), отдельный блок для фазы плана (`clarify`).
- [ ] `tasks/task-service.ts` — `send`: `needs_input` (живой процесс → ответ; `interrupted` с открытым вопросом → продолжение с текстом «вопрос/ответ»), `done` (доработка, `attempt+1`, предупреждение о слитой ветке); `waitFor` возвращает вопрос; `pump()` не считает задачи в `needs_input`; `start(clarify)`; `recover()` сохраняет открытый вопрос.
- [ ] `quality/quality-gate.ts` — реализация `QualityGate`: команды по очереди в worktree, окружение по белому списку, таймаут с убийством группы, полный вывод в `logs/<task_id>.quality.log`, `issues` ≤ 10 × 200; проверка базы во временном worktree (с `setup`) и кэш в `quality_baselines`; блокировка на проект.
- [ ] `workspaces/workspace-manager.ts` — общий запуск команды (`runCommand`) для `setup` и проверки; временный worktree базы (`createBaselineWorktree`/удаление); `diffNameStatus(base)`; `isMergedInto(branch, base)`.
- [ ] `accounting/accounting.ts` — цепочка источников (FR-116), `unknown`, цена на момент шага, итог по сессии с числом неизвестных шагов; `formatCostLine` с «цена неизвестна».
- [ ] `tasks/envelope.ts` — `quality.issues`, `quality.log_path`, `questions`, `attempt`; контроль 2 КБ.
- [ ] `facade/mcp-facade.ts` — `start.clarify`; `wait` с вопросом; строка ожидающих вопросов, добавляемая ко всем ответам сессии (≤ 300 байт); новый текст `send`.
- [ ] `sessions/hook-resolver.ts` (новый) — предки PID через `ps -o ppid= -p` (до 10 уровней, кэш на запрос), сопоставление с `parent_pid` сессий; запасной путь — единственная подключённая сессия Claude Code проекта по `cwd`.
- [ ] `transport/unix-server.ts` — разбор первой строки: `hello` (как раньше) или `hook_query` → одна строка `HookReply` и закрытие соединения; бюджет ответа 50 мс.
- [ ] `daemon.ts` — обработчик `hook_query`: режим сессии, открытый вопрос без `hook_delivered_at` → `block` с текстом, отметка доставки; лог в `logs/hooks.log`.
- [ ] `cli/doctor.ts` — проверка хука (команда из `hooks.json` плагина есть в PATH, `pi-hub-shim hook stop` отвечает за ≤ 100 мс на пустом вводе); источник цены для моделей ролей.
- [ ] `cli/status.ts` — для `needs_input` текст вопроса (80 символов) и время ожидания.

#### API / Commands:

| Инструмент / запрос | Вход | Выход | Изменение |
|---|---|---|---|
| `start` | `+ clarify?: boolean` | как раньше | задача начинается в `planning` |
| `wait` | как раньше | `+ question?: OpenQuestion` | возвращается сразу на `needs_input` |
| `send` | `task_id, message` | `{ status, warnings? }` | `needs_input` — ответ; `done` — доработка; `interrupted`/`failed` — как раньше |
| `result` | как раньше | `ResultEnvelope` с `quality.issues`, `attempt`, `questions` | — |
| все инструменты | — | `+` строка «ожидают ответа: …» | только при открытых вопросах сессии |
| `hook_query` (сокет, не MCP) | `{pid, cwd, event, stop_hook_active}` | `{block, reason?}` | одно соединение — один запрос |

#### Data structures (pseudocode):

```pseudo
OpenQuestion {
    task_id, round: Int,
    kind: "plan" | "question" | "text",
    question: String, options?: String[],
}

AskDialog (title расширения) {
    marker: "pi-hub:ask",          // чужие диалоги — отказ
    question: String, options?: String[], kind: "plan" | "question",
}

HookReply { block: Bool, reason?: String }   // reason — для старшего, ≤ 1 КБ

QualityRun {
    status: PASS | FAIL | SKIPPED,
    commands: [{ name, exitCode, timedOut, durationMs, failedOnBase?: Bool }],
    issues: String[],             // ≤ 10 × 200
    logPath: String,
}
```

#### Data schema (migration 004):

```pseudo
ALTER TABLE questions ADD kind TEXT NOT NULL DEFAULT 'question'   -- plan | question | text
ALTER TABLE questions ADD pi_dialog_id TEXT                        -- для extension_ui_response
ALTER TABLE questions ADD resume_status TEXT                       -- planning | running
ALTER TABLE questions ADD hook_delivered_at TEXT

ALTER TABLE tasks ADD quality_issues_json TEXT
ALTER TABLE tasks ADD quality_log_path TEXT

TABLE quality_baselines (
    project_id, base_commit, command TEXT, exit_code INT, timed_out INT,
    checked_at TEXT, PRIMARY KEY (project_id, base_commit, command)
)

steps: пересборка (CREATE steps_new … INSERT SELECT … DROP … RENAME) —
    cost_source CHECK IN ('provider','pi_event','tokens_x_price','unknown'),
    + price_json TEXT    -- цена на момент шага при tokens_x_price
```

### Shim (`packages/shim/src`)

- [ ] `index.ts` — разбор подкоманды: `pi-hub-shim hook stop` уходит в `hook.ts`, иначе MCP-труба как раньше.
- [ ] `hook.ts` (новый, ~60 строк) — читает JSON хука из stdin (`cwd`, `stop_hook_active`), шлёт `hook_query` в сокет с таймаутом 80 мс, печатает `{"decision":"block","reason":…}` при `block`; при любой ошибке — пустой вывод и код 0. Без зависимостей кроме `@pi-hub/protocol`.

### Pi extension (`packages/pi-extension/src`)

- [ ] `index.ts` — инструмент `ask(question, options?)`: `ctx.ui.input` с `title` = маркер + JSON вопроса (без таймаута); возвращает модели текст ответа или «ответа нет: решай сам и запиши допущение» при отмене.
- [ ] `worker-prompt.md` — FR-115, FR-121, блок фазы плана.

### Fake worker (`packages/fake-worker/src/index.ts`)

- [ ] Сценарии `ask`, `ask-twice`, `clarify`, `text-question`, `quality-fix`, `quality-broken`, `skip-test`; поддержка `extension_ui_request` → ожидание `extension_ui_response` и повторных `prompt` в одном процессе.

### Claude Code plugin (`plugins/claude-code`)

- [ ] `hooks/hooks.json` — `Stop` → `pi-hub-shim hook stop`, таймаут 2 с (ответ shim — ≤ 100 мс).
- [ ] `skills/architect/SKILL.md` — FR-126: вопросы, FAIL, не заканчивать ход с открытым вопросом, стоимость.
- [ ] `commands/workers.md` — показывать вопросы задач.
- [ ] `README.md` — вопросы, проверка качества, `.pi-hub.toml`, `prices.yaml`.

### Scripts and docs

- [ ] `scripts/e2e.ts` — режим `--scenario ask`: задача, где воркер обязан спросить (инструкция в тексте задачи), ответ через `send`, `.pi-hub.toml` с командой проверки во временном репозитории, проверка вердикта.
- [ ] `config/hub.example.yaml`, `config/pi-hub.project.example.toml`, `config/prices.example.yaml` — пределы закомментированы, `quality.timeout_minutes`, пример цены для провайдера из расширения.
- [ ] `docs/adr/0005-worker-questions-via-extension-ui.md` — дополнение: маркер диалога, живой процесс на `needs_input`, вопрос текстом.
- [ ] `docs/adr/0012-quality-gate.md` (новый) — проверка базы, авто-круг, блокировка на проект.
- [ ] `docs/architecture/task-lifecycle.md` — `done → running`, `planning`, авто-круг.

## Implementation phases

### Phase 0: Проверка допущений (estimate: 2 h)
- [x] Хук Stop в настоящем Claude Code (CLI из приложения, отдельный `CLAUDE_CONFIG_DIR`, тестовый плагин): какие поля приходят в stdin (`cwd`, `stop_hook_active`, `session_id`), формат блокировки, и является ли процесс Claude Code, запустивший MCP-сервер (родитель shim), предком процесса хука → записать в «Plan decisions»; если CLI без входа не запускает ход — пользователь делает один прогон по инструкции.
- [x] Записать реальный обмен `ask` на Pi 1.6.1 (`9router/Deepseek-v4.1-flash`): `extension_ui_request` (метод `input`, `title`), ответ, `tool_execution_end` → `packages/hub/test/fixtures/pi-session-ask.jsonl` без секретов.
- [x] Проверить, что после ответа на `ask` и `agent_settled` тот же процесс Pi принимает новый `prompt` (нужно для авто-круга и вопроса текстом).
- deviated: ход модели в Claude Code без входа не запускается, поэтому событие Stop целиком не вызывалось; дерево процессов проверено на SessionStart (тот же механизм запуска хуков), а формат входа и ответа Stop — по коду Claude Code 2.1.331 (PD-110, PD-111).
- deviated: фикстура содержит строки `{"__sent": …}` — команды клиента в порядке отправки, чтобы контрактный тест воспроизводил обмен целиком; пути заменены на `/tmp/pihub-fixture` и `/home/user`.
- **Independent check:** факты в «Plan decisions»; фикстура в репозитории, поиск ключа по ней пустой.

### Phase 1: Протокол, хранилище, конфиг (estimate: 4 h)
- [x] [P] Протокол: `done → running`, типы вопросов и качества, `clarify`, `HookQuery`/`HookReply`, `PROTOCOL_VERSION 0.2.0` → `packages/protocol/src/*`
- [x] Миграция `004_questions_quality.sql` (включая пересборку `steps`) и методы `repos.ts`
- [x] [P] Конфиг: необязательные пределы, `quality.timeout_minutes`, `config/prices.ts`; примеры в `config/`
- [x] Тесты: миграция на чистой БД и на БД с данными этапа 1 (шаги сохраняются); переходы статусов; загрузка `prices.yaml` (ошибки, перечитывание); конфиг без пределов
- deviated: `HookQuery` несёт и `client` (для хука Codex на этапе 3) — хаб ищет сессию только этого клиента.
- deviated: `paths.prices` (`~/.pi-hub/prices.yaml`) добавлен в `HubPaths`, чтобы путь был в одном месте с остальными.
- deviated: чтобы сборка не ломалась от новых полей протокола, в фазе 1 сделаны минимальные связки: `buildEnvelope` заполняет `quality.issues`/`log_path`, `attempt`, `questions` (полностью — фаза 3), а `WorkerRun` применяет пределы задачи, только если они заданы (пауза таймера в `needs_input` — фаза 2). `pi-hub init` больше не пишет пределы в конфиг.
- deviated: `prices.yaml` с ошибкой не ломает учёт: ручных цен нет, ошибка сообщается один раз на изменение файла.
- **Independent check:** `pnpm test` и `pnpm typecheck` зелёные; БД этапа 1 мигрирует без потери шагов.

### Phase 2: Вопросы без MCP (estimate: 10 h)
- [ ] Расширение: `ask` + промпт (FR-101, FR-115, FR-121) → `packages/pi-extension/src/*`
- [ ] `PiRpcClient.respondUi`, повторное ожидание `agent_settled`
- [ ] `tasks/questions.ts`: разбор маркера, запись, ответ, отказ чужим диалогам
- [ ] `WorkerRun`: живой процесс, `needs_input` с паузой таймера, `answer`, остановка только в конце; пределы только если заданы (FR-118)
- [ ] Вопрос текстом (FR-120) до `ensureSummary`; `clarify` и предупреждение о правках в фазе плана (FR-125)
- [ ] `TaskService`: `send` для `needs_input`/`done`/`interrupted` с открытым вопросом (FR-104…FR-106, FR-123); `pump()` без `needs_input` (PD-101); `waitFor` с вопросом; `recover()`
- [ ] Фейковый воркер: `ask`, `ask-twice`, `clarify`, `text-question`; контрактный тест на фикстуре фазы 0
- [ ] Тесты (на уровне `TaskService`): вопрос → `needs_input` ≤ 2 с → `send` → `done`; два вопроса подряд; рестарт в `needs_input` → `interrupted` → `send` → `done`; `cancel` в `needs_input`; вопрос текстом; `clarify` без правок и с правками; `send` на `done` с новой финализацией и предупреждением о слитой ветке; ожидающая задача не держит слот; без пределов задача не останавливается
- **Independent check:** интеграционные тесты сценариев 1 и 3 на уровне `TaskService` зелёные.

### Phase 3: Проверка качества (estimate: 10 h)
- [ ] `WorkspaceManager.runCommand` (общий для `setup`), временный worktree базы, `diffNameStatus`, `isMergedInto`
- [ ] `quality/quality-gate.ts`: команды, таймаут, лог, `issues`, `SKIPPED`; блокировка на проект (FR-111, FR-112, FR-114)
- [ ] Проверка базы с кэшем `quality_baselines` (FR-119)
- [ ] Авто-круг в `WorkerRun` (FR-113) и защита тестов (FR-121); итоговые поля задачи
- [ ] Конверт: `quality.issues`, `log_path`, `questions`, `attempt` (FR-127)
- [ ] Фейковый воркер: `quality-fix`, `quality-broken`, `skip-test`
- [ ] Тесты: PASS; FAIL → авто-круг → PASS с предупреждением; FAIL дважды; `SKIPPED` без команд; ошибка была на базе → без авто-круга, кэш базы переиспользован второй задачей; таймаут команды с дочерним процессом; две задачи одного проекта проверяются по очереди; отключённый тест → предупреждение при PASS; конверт ≤ 2 КБ
- **Independent check:** интеграционные тесты сценария 4 на уровне `TaskService` зелёные.

### Phase 4: Стоимость (estimate: 3 h)
- [ ] [P] `accounting.ts`: цепочка `provider → pi_event → tokens_x_price → unknown`, цена шага, итог с числом неизвестных; `formatCostLine` (FR-116, FR-117)
- [ ] `doctor`: источник цены для моделей ролей (FR-128, часть)
- [ ] Тесты: каждый источник; нулевая стоимость без ручной цены → `unknown`; строка «цена неизвестна»; итог по сессии с пометкой
- **Independent check:** модульные тесты учёта; шаги фейкового воркера с нулевой стоимостью и ручной ценой дают `tokens_x_price`.

### Phase 5: Фасад, строка вопросов, хук Stop (estimate: 8 h)
- [ ] Фасад: `start.clarify`, `wait` с вопросом, новый `send`, строка ожидающих вопросов во всех ответах (FR-103, FR-107)
- [ ] `sessions/hook-resolver.ts` и запасной путь по проекту (FR-108, FR-122)
- [ ] `unix-server.ts` + `daemon.ts`: `hook_query`, отметка доставки, `hooks.log` (FR-109, FR-110)
- [ ] Shim: `pi-hub-shim hook stop` → `packages/shim/src/hook.ts`
- [ ] Плагин: `hooks/hooks.json`, скил, `/workers`, README (FR-126)
- [ ] `doctor` (хук) и `status` (вопросы) (FR-128, FR-130)
- [ ] Тесты (MCP-клиент SDK → shim → демон, фейковый воркер): вопрос тремя путями — `wait`, строка в `status`, `hook stop` блокирует один раз и не блокирует повторно; вторая сессия того же проекта вопросов не видит; хук при остановленном демоне и при `off` — без блокировки; 20 вызовов хука, 95-й перцентиль ≤ 100 мс; запасной путь по проекту; несовместимая версия протокола
- **Independent check:** интеграционный тест «вопрос тремя путями» проходит через настоящий shim.

### Phase 6: Сквозная проверка и закрытие (estimate: 4 h)
- [ ] `scripts/e2e.ts --scenario ask` на `9router/Deepseek-v4.1-flash`: вопрос через `wait`, ответ `send`, вердикт проверки по команде из `.pi-hub.toml`; строка стоимости «цена неизвестна» и с ручной ценой
- [ ] Ручной прогон в Claude Code: вопрос воркера, хук Stop, ответ, FAIL → `send` → PASS
- [ ] ADR-0005 (дополнение), ADR-0012 (проверка качества), `docs/architecture/task-lifecycle.md`
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm test`, CI зелёный
- **Independent check:** ворота этапа 2 из спецификации отмечены.

**Итого:** ~41 h.

## Traceability: Requirements → Tasks

| Requirement | Phase | Tasks |
|-------------|-------|-------|
| FR-101 | 2 | `pi-extension`: инструмент `ask` |
| FR-102 | 2 | `tasks/questions.ts`, обработка `ui_request` в `WorkerRun` |
| FR-103 | 2, 5 | `waitFor` с вопросом, фасад `wait` |
| FR-104 | 2 | `TaskService.send` для `needs_input`, `respondUi` |
| FR-105 🔶 | 1, 2 | `done → running`, `send` для `done` |
| FR-106 | 2 | `recover()`, продолжение с «вопрос/ответ» |
| FR-107 | 5 | строка ожидающих вопросов в фасаде |
| FR-108 🔶 | 1, 5 | `HookQuery`, `hook-resolver.ts`, `unix-server.ts` |
| FR-109 | 5 | `shim/hook.ts`, `hooks.json`, отметка доставки |
| FR-110 | 5 | таймауты shim и сервера, `hooks.log` |
| FR-111 | 3 | `quality-gate.ts`: команды, окружение, таймаут |
| FR-112 | 3 | вердикт, лог, `issues` |
| FR-113 | 3 | авто-круг в `WorkerRun` |
| FR-114 | 3 | блокировка на проект |
| FR-115 | 2 | `worker-prompt.md` |
| FR-116 🔶 | 1, 4 | `prices.ts`, цепочка источников, миграция `steps` |
| FR-117 | 4 | `formatCostLine`, итог по сессии |
| FR-118 🔶 | 1, 2 | необязательные пределы, пауза таймера в `needs_input` |
| FR-119 | 3 | проверка базы, `quality_baselines` |
| FR-120 | 2 | `detectTextQuestion` до `ensureSummary` |
| FR-121 | 2, 3 | промпт, `detectTestTampering` |
| FR-122 | 5 | запасной путь в `hook-resolver.ts` |
| FR-123 | 2, 3 | `isMergedInto`, предупреждение в `send` |
| FR-125 | 2 | `clarify`, фаза `planning` |
| FR-126 | 5 | скил архитектора |
| FR-127 | 3 | конверт |
| FR-128 | 4, 5 | `doctor`: цены и хук |
| FR-129 | 2, 3 | сценарии фейкового воркера |
| FR-130 | 5 | `pi-hub status` |

## Complexity & principle deviations

| Deviation | Principle / simpler alternative | Why justified |
|-----------|--------------------------------|---------------|
| Подкоманда `hook stop` в shim | «Shim — прозрачная труба» (ADR-0002) | Альтернатива — скрипт в плагине, который дублирует поиск сокета и протокол и нарушает принцип «плагин тонкий». В shim — один короткий запрос без логики: решение принимает хаб (PD-102) |
| Временный worktree базы для проверки | Сравнивать только с прошлым результатом задачи | Без базы нельзя отличить «тесты сломал воркер» от «тесты красные с утра» (D-112); цена — один прогон на коммит базы, кэш |

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Процесс хука не является потомком процесса Claude Code, запустившего shim (особенно в приложении) | Medium | High | Фаза 0 проверяет; запасной путь по проекту (FR-122); при неудаче — хук SessionStart с `session_id` (BD-008) как отдельное решение |
| Pi не принимает новый `prompt` после `agent_settled` в том же процессе | Low | High | Фаза 0; запасной путь — `switch_session` в новом процессе, как `send` этапа 1 |
| Запуск Node для хука не укладывается в 100 мс на холодном диске | Medium | Medium | shim без лишних импортов на пути хука; 95-й перцентиль в тесте; таймаут хука в `hooks.json` 2 с — Claude Code не ждёт дольше, а хук никогда не блокирует при ошибке |
| Модель злоупотребляет `ask` или игнорирует его | Medium | Medium | Строгие правила в промпте (FR-115), вопрос текстом (FR-120), число вопросов в конверте — материал для этапа 3 |
| Проверка базы долгая (полный `setup` + тесты) | Medium | Medium | Кэш на коммит базы; выполняется параллельно с работой воркера, а не после неё |
| Пересборка `steps` в миграции теряет данные | Low | High | Тест миграции на БД этапа 1 с шагами; миграция в транзакции |
| Живые процессы Pi в `needs_input` копятся | Low | Low | Ожидающий процесс не тратит токены и процессор; `status` показывает время ожидания; `cancel` останавливает |

## Dependencies

### Packages / Libraries
- Новых нет: `ps` — системная утилита (macOS, Linux), YAML уже есть (`yaml`).

### Related tasks
- T-011 (спецификация). Опирается на `TaskService`, `WorkerRun`, фасад и shim этапа 1. Хук Codex и `usage_report` — этап 3.

## Deferred questions

| Question | Why deferred | When the answer is needed | Who decides |
|----------|--------------|---------------------------|-------------|
| — | — | — | — |

## Plan decisions

| # | Question | Decision | Date |
|---|----------|----------|------|
| PD-101 | Держит ли задача в `needs_input` слот `max_workers_hub` | Нет: ожидающая задача освобождает слот, после ответа продолжает сразу, даже если на время активных станет больше лимита. Молчащий старший не останавливает очередь | 2026-11-27 |
| PD-102 | Чем сделать хук Stop | Подкоманда `pi-hub-shim hook stop`: shim уже в PATH, знает сокет и версию протокола; в плагине только строка в `hooks.json`; тот же код — для хука Codex на этапе 3 | 2026-11-27 |
| PD-103 | Что с процессом Pi на `needs_input`, при вопросе текстом и в авто-круге | Процесс живёт: ответ на `ask` — `extension_ui_response`, вопрос текстом и авто-круг — новый `prompt` в тот же процесс. Остановка Pi — только после итогового статуса, `cancel` или остановки хаба. Без висящего вызова `ask` в истории Pi | 2026-11-27 |
| PD-104 | Как отличить вопрос pi-hub от чужого диалога расширения | Маркер `pi-hub:ask` и JSON вопроса в `title` диалога `input`; остальные диалоги получают отказ (`cancelled`) и запись в журнал | 2026-11-27 |
| PD-105 | Новое значение `cost_source` при `CHECK` в SQLite | Пересборка таблицы `steps` в миграции 004 (в транзакции) с `unknown` и `price_json`; тест на БД этапа 1 | 2026-11-27 |
| PD-106 | Где проверять базу | Временный worktree на коммите базы с `setup`, удаляется после проверки; результат по командам в `quality_baselines` на пару «проект + коммит»; проверка базы стартует вместе с работой воркера | 2026-11-27 |
| PD-107 | Как хаб находит предков процесса хука | `ps -o ppid= -p <pid>` по цепочке до 10 уровней в хабе (macOS и Linux), без новых зависимостей; хук передаёт только свой PID и `cwd` | 2026-11-27 |
| PD-108 | Версия протокола при добавлении `hook_query` | `0.2.0`: новый тип первой строки, существующие сообщения не меняются — старый shim по-прежнему подключается (совместимость по старшей цифре) | 2026-11-27 |
| PD-109 | Где брать ручные цены | `~/.pi-hub/prices.yaml`, перечитывается по `mtime` при поиске цены; таблица `prices` БД на этом этапе не используется (D-107) | 2026-11-27 |
| PD-110 | Фаза 0: найдёт ли хаб сессию по предкам процесса хука | Да. Проверено в Claude Code 2.1.331 (CLI из приложения, отдельный `CLAUDE_CONFIG_DIR`, хук SessionStart и MCP-сервер через `--settings`/`--mcp-config`): процесс хука — `/bin/sh`, его родитель — тот же процесс `claude`, что запустил MCP-сервер (родитель shim). Цепочка «хук → sh → claude» укладывается в 2 шага `ps`; запасной путь по проекту (FR-122) остаётся страховкой | 2026-11-27 |
| PD-111 | Фаза 0: вход и ответ хука Stop | Вход: общие поля (`session_id`, `transcript_path`, `cwd`, `hook_event_name: "Stop"`) + `stop_hook_active`, `last_assistant_message`. Блокировка: JSON `{"decision":"block","reason":…}` на stdout с кодом 0. Claude Code сам ограничивает число блокировок подряд и советует не блокировать при `stop_hook_active = true` → shim при `stop_hook_active` не блокирует вовсе (вместе с D-110) | 2026-11-27 |
| PD-112 | Фаза 0: `ask` и повторный `prompt` на Pi 1.6.1 | Проверено на `9router/Deepseek-v4.1-flash`: `ctx.ui.input(title)` приходит как `extension_ui_request {id, method: "input", title, placeholder}`, ответ `extension_ui_response {id, value}` возвращается в инструмент; свободный ответ вне вариантов модель использует (D-111). После `agent_settled` тот же процесс принимает новый `prompt` с полным контекстом — авто-круг и вопрос текстом идут в живой процесс (PD-103). Фикстура `test/fixtures/pi-session-ask.jsonl` | 2026-11-27 |

## Tech Debt

| # | Description | Phase | Priority |
|---|-------------|-------|----------|
| — | — | — | — |
