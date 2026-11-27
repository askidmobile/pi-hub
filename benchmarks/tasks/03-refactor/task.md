# 03 · Рефакторинг

## Task

`src/report.js` formats money the same way in three functions. Extract that formatting into
`formatMoney(cents, currency)` exported from a new file `src/format.js` and use it in all three
functions of `src/report.js`. Behaviour must not change: the existing tests must pass
unchanged. Add a test for `formatMoney` in `test/format.test.js`.

## Приёмка

- `node --test` проходит; тесты `report` не менялись.
- В `src/report.js` нет собственного форматирования (`toFixed`), он импортирует `formatMoney`.
