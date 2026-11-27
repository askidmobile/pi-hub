Scenarios are implemented in `../index.ts` and selected by the model id: `--model fake/<scenario>`.
See `SCENARIOS` there for the list.

- Stage 1: success, no-summary, no-commit, empty-diff, incomplete, assumption, ai-attribution,
  expensive, crash, hang.
- Stage 2 questions: `ask` (one `ask` dialog, the answer is written to `answer.txt`),
  `ask-twice`, `clarify` (plan as `ask` when the prompt starts with `PLAN PHASE`),
  `clarify-edit` (same, but edits a file during the plan), `text-question` (first turn ends
  with a question in text, the next prompt is the answer), `foreign-dialog` (a `confirm`
  dialog that is not a pi-hub question; the hub must refuse it).
- Stage 2 quality (the project check fails while `broken.txt` exists): `quality-fix` (adds
  `broken.txt`, removes it after the fix message), `quality-broken` (never fixes),
  `skip-test` (commits a test with `it.skip`).
