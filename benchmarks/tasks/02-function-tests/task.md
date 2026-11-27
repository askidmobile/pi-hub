# 02 · Функция с тестами

## Task

Add `parseDuration(text)` to a new file `src/duration.js` (ES module, named export). It
converts strings like `"1h30m"`, `"45s"`, `"2h"`, `"1h2m3s"` into a number of seconds. Units
`h`, `m`, `s` appear at most once each, in this order; spaces are not allowed. Anything else
(empty string, unknown unit, wrong order, `"1.5h"`) throws an `Error`. Add unit tests in
`test/duration.test.js` (node:test) covering valid and invalid input.

## Приёмка

- `node --test` проходит; в `test/` есть тесты `parseDuration`.
- Скрытые тесты приёмки (`accept/`) проходят.
