# Исследование: System One, Jev, ACP (2026-11-26)

## ACP-адаптеры для Pi (OQ-04)

Официального нет, есть независимые: `pi-acp` (svkozak, npm 0.0.35, в ACP Registry Zed), форки DxTa, victor-software-house, @geohar; `pi-acpinator` на Rust. Одни запускают `pi --mode rpc`, другие встраивают SDK. Ограничения основного: нет делегирования `fs/*` и `terminal/*`, MCP частично.
Вывод: хабу не нужен — всё нужное есть в RPC напрямую. Драйвер ACP имеет смысл только для воркеров не на Pi (после MVP).

## pi-jev (OQ-04)

`pi-jev` 0.8.0 (TheoOliveira) — расширение Pi для TypeSafe Jev: `jev_evaluate` (типизированные вопросы), `jev_find_tools`, `jev_find_skill`, авто-выбор модели и уровня рассуждения, `pi-jev-gate` (проверка диффа по критериям, выход 0/1). Эндпоинт настраивается: TypeSafe, OpenRouter (`~typesafe/jev-latest`), локальный совместимый (`PI_JEV_BASE_URL`, например `laya-serve`).
Вывод: в воркеров не ставим (маршрутизацией и учётом владеет хаб); берём как образец модели вопросов, формулы цены смены модели и gate-проверки.

Роутеры на Jev: `@caph42/pi-jev-router`, `pi-jev-router` (через Vercel AI Gateway), `@french-castle/jev-router`. Для хаба не нужны (OQ-09): выбор модели — наш `choice`-вопрос по своей таблице ролей.

## System One API (OQ-10)

Общий формат решающих моделей. Запрос: `{model, state, questions}`; `questions` — объект «имя → вопрос».

| Тип | Поля вопроса | Ответ |
|---|---|---|
| `noul` | `instructions`, необязательные `criteria: {true, false}` | `noul` — вероятность «да» |
| `choice` | `instructions`, `criteria: {ключ: описание}` (до 255) | `choice`, `probabilities`, `confidence` |
| `score` | `instructions`, `criteria: [уровни]` (2–10, от низшего) | `score`, `legend`, `probabilities`, `confidence` |

Ещё бывают `box` (только Jev, нужны изображения) и ответ `refusal`.

| Провайдер | Эндпоинт | Модели | Стоимость в ответе |
|---|---|---|---|
| TypeSafe (напрямую) | `https://api.typesafe.ai/v1/systemone`, список моделей `GET /v1/models` | `jev-latest` → `jev-1.14.0`, `jev-1.13.0`, `jev-preview` | нет, только токены; $0.042 за 1M входных, выход бесплатно |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13`, `jev-latest` | `usage.cost` |
| AIML API | `https://api.aimlapi.com/v1/decisions` | `typesafe/jev`, `typesafe/jev-1.14` | `meta.usage.usd_spent` |
| Ollama | `http://localhost:11434/v1/systemone`, облако `https://ollama.com` | `nimble`, `clef:cloud` | нет, только токены |
| Cloudflare Workers AI | REST `/ai/run`, binding `env.AI.run()` | `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` | не показана |
| LiteLLM-прокси | `/v1/systemone` | любая подключённая | — |

Модели: TypeSafe Jev (вышел 2026-09-15), Cloudflare Clef 27B и Clef-flash 9B (2026-10-01, Apache 2.0, совместимы с API Jev), Microsoft-Decision-1 в Foundry (совместимость с форматом не подтверждена).

TypeSafe: авторизация `Authorization: Bearer`, ключ из `console.typesafe.ai/keys`, переменная `TYPESAFE_API_KEY`; SDK `@typesafe-ai/sdk` (Node 22+), `typesafe-sdk` (Python). Контекст 64k токенов на запрос (до 262k с заголовком `TypeSafe-Danger-Zone-Long-Context: true`), лимиты — в консоли, превышение — 429 с `retry-after`. `box` — только Jev 1.14.

Не подтверждено: точная обёртка запроса у LiteLLM и Cloudflare (документация показывает фрагменты).

## Источники

- https://docs.typesafe.ai/introduction, /introduction/quickstart.md, /api/system-one.md, /models.md, /api/errors.md

- https://github.com/svkozak/pi-acp, https://zed.dev/acp/agent/pi
- https://github.com/TheoOliveira/pi-jev
- https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request
- https://docs.ollama.com/api/systemone.md
- https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/, https://blog.cloudflare.com/clef-decision-models/
- https://docs.aimlapi.com/api-references/decision-models/typesafe/jev
- https://thenewstack.io/microsoft-decision-model-foundry/
