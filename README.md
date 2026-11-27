# pi-hub

Демон, через который старший агент (Codex, Claude Code или любой MCP-клиент) поручает работу младшим агентам [Pi](https://github.com/earendil-works/pi) на дешёвых моделях. Старший планирует и принимает результат, младшие пишут код в изолированных ветках; старший получает короткую сводку и стоимость вместо полного хода работы.

**Статус:** этап 1 «Ядро на одной машине» — в работе. Работают демон, shim, делегирование через MCP, `init`, `doctor`, `status`; проверка качества и роутер — следующие этапы.

## Установка

Нужны Node.js ≥ 24, pnpm, git и [Pi](https://github.com/earendil-works/pi) 1.6.1 (`pi --version`).

```bash
git clone <url> pi-hub && cd pi-hub
pnpm install
pnpm build
pnpm link:bins              # обёртки pi-hub и pi-hub-shim в ~/.local/bin
```

## Первый запуск

```bash
pi-hub init
```

`init` спрашивает провайдера, модель по умолчанию (`<провайдер>/<id модели>`, как в каталоге Pi), ключ провайдера и разрешённые репозитории, затем:

- создаёт `~/.pi-hub/`: `config.yaml`, `.env` с правами 0600, `pi-agent/` — отдельную конфигурацию Pi для воркеров (личный `~/.pi/agent` не используется);
- ничего не перезаписывает: повторный запуск оставляет конфиг и `.env` как есть, только дописывает недостающий ключ;
- подключает плагин Claude Code из этого репозитория (`claude plugin marketplace add …`, `claude plugin install pi-hub@pi-hub-local --scope user`); если команды `claude` нет в PATH, печатает эти команды;
- в конце выполняет `pi-hub doctor`.

Без вопросов, например для сервера сборки:

```bash
DEEPSEEK_API_KEY=… pi-hub init --yes --model deepseek/deepseek-flash --repo ~/Projects/app
```

Ключ берётся из переменной провайдера в окружении, а не из аргументов, чтобы не попасть в историю оболочки.

Дальше откройте Claude Code в разрешённом репозитории и включите режим архитектора: `/architect on`. Демон запускать не нужно — shim поднимает его сам и оставляет работать после закрытия Claude Code.

## Команды

| Команда | Что делает |
| --- | --- |
| `pi-hub init` | Первичная настройка `~/.pi-hub` и подключение плагина |
| `pi-hub doctor` | Проверяет конфиг, ключ, версию Pi, расширение воркера, видит ли Pi модель, git, shim, демон |
| `pi-hub status` | Задачи всех сессий (только чтение) |
| `pi-hub serve` | Демон на переднем плане (обычно его запускает shim) |

В Claude Code: `/architect on\|off`, `/workers`, `/workers doctor`.

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
