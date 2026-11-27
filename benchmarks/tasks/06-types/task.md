# 06 · Типы

## Task

`src/geometry.js` is checked by TypeScript (`// @ts-check`, strict mode) and fails: parameters
have implicit `any` types and one function can return `undefined`. Add JSDoc type annotations
(`@typedef`, `@param`, `@returns`) and fix the possibly-undefined return so that
`tsc --noEmit --allowJs --checkJs --strict src/geometry.js` passes. Keep the runtime behaviour:
`node --test` must keep passing.

## Приёмка

- Проверка типов TypeScript (strict) проходит.
- `node --test` проходит.
