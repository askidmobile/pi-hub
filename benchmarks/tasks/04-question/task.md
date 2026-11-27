# 04 · Задача с обязательным вопросом

## Task

Create `src/config.js` exporting `DEFAULT_PORT` (a number) and `DEFAULT_HOST` (a string) for
our HTTP service, and a test `test/config.test.js` that checks both are set. The port and the
host are a product decision that is NOT written anywhere in the repository: before writing
the file you must ask the architect with the `ask` tool which port and host to use, and use
exactly the answer.

## Приёмка

- Воркер спросил через `ask`; ответ — заготовленный (`answers.json`).
- Скрытый тест: `DEFAULT_PORT === 8443`, `DEFAULT_HOST === "0.0.0.0"`; `node --test` проходит.
