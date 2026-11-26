/**
 * Pi extension loaded into every worker via `pi -ne -e <this package>` (ADR-0011):
 *  - `ask(question, options?)` -> ctx.ui.select / ctx.ui.input; arrives at the hub as
 *    `extension_ui_request` over Pi RPC and blocks until `extension_ui_response` (ADR-0005);
 *  - `report_assumption(text)` -> non-critical decisions recorded into `assumptions`;
 *  - protocol rule: stop only on data schema, public API, deletions and similar.
 * Pi provides @earendil-works/pi-coding-agent, pi-ai and typebox at runtime:
 * do not list them in `dependencies`.
 */
export {};
