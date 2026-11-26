# pi-hub

Демон, через который старший агент (Codex, Claude Code или любой MCP-клиент) поручает работу младшим агентам [Pi](https://github.com/earendil-works/pi) на дешёвых моделях. Старший планирует и принимает результат, младшие пишут код в изолированных ветках; старший получает короткую сводку и стоимость вместо полного хода работы.

**Статус:** проектирование. Код — заготовки модулей.

## Документы

- [Спецификация](docs/spec/pi-hub-spec.md)
- [Бриф](docs/brief/PROJECT-BRIEF.md) · [решения](docs/brief/decisions.md) · [открытые вопросы](docs/brief/open-questions.md)
- [Архитектура](docs/architecture/overview.md) · [стек](docs/architecture/stack.md) · [жизненный цикл задачи](docs/architecture/task-lifecycle.md) · [ADR](docs/adr/)

## Структура

```
packages/
  protocol/      общие типы: версия протокола, статусы, конверт, схемы инструментов
  hub/           демон: facade, sessions, pi-rpc, workspaces, quality, router, accounting, storage
  shim/          stdio MCP ↔ хаб
  pi-extension/  расширение воркера Pi: ask, report_assumption
  fake-worker/   фейковый воркер для тестов
plugins/
  claude-code/   плагин: MCP-сервер, хуки, /architect, /workers, скил
  codex/         профиль архитектора, хуки, промпты, скил
apps/panel/      веб-панель (поздний этап)
config/          примеры конфигов хаба, ролей, цен, проекта
benchmarks/      эталонные задачи
docs/            спецификация, бриф, архитектура, ADR, specs/, plans/
```

## Разработка

```bash
pnpm install
pnpm build
pnpm test
```

Инструкции для агентов — [AGENTS.md](AGENTS.md). Процесс: `/create-spec` → `/create-spec-plan` → `/create-spec-implement` → `/create-spec-review`, задачи — `/tasks`.
