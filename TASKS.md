# Project tasks

> Managed by the `task-tracker` skill via `tasks.py`. Don't edit by hand.
> CLI commands: `/tasks`, `/tasks active`, `/tasks add "..."`.
>
> Keep this file small — it's read into context every session. Finished tasks
> leave via `/tasks archive T-XXX` (or `archive-done`) into `TASKS_ARCHIVE.md`,
> past years via `/tasks rotate-archive`. A backlog that outgrows the file
> moves out with `/tasks split-backlog`.

## 🚀 Active tasks

| ID    | Date       | Task                                       | Plan                                                | Status      |
| ----- | ---------- | ------------------------------------------ | --------------------------------------------------- | ----------- |
| T-001 | 2026-11-26 | Решить OQ-12 (AGENTS.md) и OQ-14 (этапы) | [`open-questions.md`](docs/brief/open-questions.md) | ✅ Done |
| T-002 | 2026-11-26 | Закрыть открытые вопросы OQ-04,06-11,13,15 | [`open-questions.md`](docs/brief/open-questions.md) | ✅ Done |
| T-003 | 2026-11-26 | Спека этапа 1: ядро на одной машине | [``](docs/specs/) | ✅ Done (docs/specs/2026-11-26-stage-1-core.md) |
| T-004 | 2026-11-26 | План этапа 1: /create-spec-plan | [`2026-11-26-stage-1-core.md`](docs/specs/2026-11-26-stage-1-core.md) | ✅ Done (docs/plans/2026-11-26-stage-1-core.md) |
| T-005 | 2026-11-26 | Реализация этапа 1: ядро на одной машине | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | ✅ Done (ретроспектива в плане) |
| T-006 | 2026-11-27 | TD-001: типизировать тесты (tsconfig.test.json, шаг в typecheck/CI) | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | ✅ Done |
| T-007 | 2026-11-27 | TD-005: проверить автоподключение плагина через claude plugin в init | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | ✅ Done |
| T-011 | 2026-11-27 | Спека этапа 2: вопросы и качество | [`2026-11-27-stage-2-questions-quality.md`](docs/specs/2026-11-27-stage-2-questions-quality.md) | ✅ Done |
| T-012 | 2026-11-27 | Реализация этапа 2: вопросы и качество | [`2026-11-27-stage-2-questions-quality.md`](docs/plans/2026-11-27-stage-2-questions-quality.md) | ✅ Done |
| T-016 | 2026-11-27 | Спека этапа 3: роутинг, эскалация, Codex, usage_report | [`2026-11-27-stage-3-routing-codex.md`](docs/specs/2026-11-27-stage-3-routing-codex.md) | ✅ Done |
| T-017 | 2026-11-27 | Реализация этапа 3: роутинг, эскалация, Codex, usage_report | [`2026-11-27-stage-3-routing-codex.md`](docs/plans/2026-11-27-stage-3-routing-codex.md) | 🔄 Фаза 5 из 7 |

## 📦 Backlog

| ID  | Date | Task | Plan | Note |
| --- | ---- | ---- | ---- | ---- |
| T-008 | 2026-11-27 | TD-002: очистить таймер ensureSummary в finally | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | Low |
| T-009 | 2026-11-27 | TD-003: убрать as never в регистрации инструментов фасада | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | Low |
| T-010 | 2026-11-27 | TD-004: сокет без окна до chmod 0600 (каталог 0700 или umask) | [`2026-11-26-stage-1-core.md`](docs/plans/2026-11-26-stage-1-core.md) | Low |
| T-013 | 2026-11-27 | TD-101: флаг clarify хранить в tasks (переживает рестарт хаба в queued) | [`2026-11-27-stage-2-questions-quality.md`](docs/plans/2026-11-27-stage-2-questions-quality.md) | Low |
| T-014 | 2026-11-27 | TD-102: кэш проверки базы привязать к тексту команды, а не к имени | [`2026-11-27-stage-2-questions-quality.md`](docs/plans/2026-11-27-stage-2-questions-quality.md) | Low |
| T-015 | 2026-11-27 | TD-103: cancel останавливает запущенную команду проверки качества | [`2026-11-27-stage-2-questions-quality.md`](docs/plans/2026-11-27-stage-2-questions-quality.md) | Low |
