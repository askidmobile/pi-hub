import type { UsageReport, UsageReportRow } from "@pi-hub/protocol";
import { cachedShare, totalInput } from "../accounting/accounting.js";
import type { Repos, UsageCostRow, UsageFilter, UsageTaskRow } from "../storage/repos.js";

/**
 * `usage_report` (stage 3 FR-206, D-209, D-215): totals plus breakdowns by model and by
 * role, at most 2 KB. Periods are rolling windows ending now.
 */
export const MAX_REPORT_BYTES = 2048;
const PERIOD_MS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
/** Pi thinking levels: `provider/model:high` is the same model in the report. */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh)$/;

export type ReportScope = UsageReport["scope"];
export type ReportPeriod = UsageReport["period"];

export function periodStart(period: ReportPeriod, now = Date.now()): string | null {
  return period === "all" ? null : new Date(now - PERIOD_MS[period]).toISOString();
}

export function buildUsageReport(
  repos: Repos,
  input: { scope: ReportScope; period: ReportPeriod; filter: UsageFilter },
): UsageReport {
  const { filter } = input;
  const t = repos.usageTotals(filter);
  const report: UsageReport = {
    scope: input.scope,
    period: input.period,
    since: filter.since,
    total: {
      cost_usd: round(t.cost, 4),
      ...(t.unknown_steps ? { unknown_price_steps: t.unknown_steps } : {}),
      input: totalInput(t),
      output: t.output,
      cached_share: round(cachedShare(t), 2),
      tasks: t.tasks,
      unchecked_tasks: t.unchecked_tasks,
    },
    by_model: mergeRows(
      repos.usageCostBy("model", filter),
      repos.usageTasksBy("model", filter),
      (k) => k.replace(THINKING_SUFFIX, ""),
    ),
    by_role: mergeRows(
      repos.usageCostBy("role", filter),
      repos.usageTasksBy("role", filter),
      (k) => k || "(без роли)",
    ),
  };
  return fitReport(report);
}

/** Cost rows (steps) and task rows (runs / tasks) of one dimension joined by name. */
export function mergeRows(
  cost: UsageCostRow[],
  tasks: UsageTaskRow[],
  name: (key: string) => string,
): UsageReportRow[] {
  type Acc = { c: Omit<UsageCostRow, "key">; t: Omit<UsageTaskRow, "key"> };
  const zeroC = { steps: 0, unknown_steps: 0, cost: 0, input: 0, output: 0, cache_read: 0 };
  const zeroT = { tasks: 0, first_try_checked: 0, first_try_pass: 0, pass_tasks: 0, pass_cost: 0 };
  const acc = new Map<string, Acc>();
  const get = (k: string) => {
    const n = name(k);
    let a = acc.get(n);
    if (!a) {
      a = { c: { ...zeroC }, t: { ...zeroT } };
      acc.set(n, a);
    }
    return a;
  };
  for (const r of cost) {
    const a = get(r.key);
    for (const f of Object.keys(zeroC) as (keyof typeof zeroC)[]) a.c[f] += r[f];
  }
  for (const r of tasks) {
    const a = get(r.key);
    for (const f of Object.keys(zeroT) as (keyof typeof zeroT)[]) a.t[f] += r[f];
  }
  const rows = [...acc].map(([n, { c, t }]) => {
    const row: UsageReportRow = {
      name: n,
      tasks: t.tasks,
      cost_usd: c.steps > 0 && c.unknown_steps >= c.steps ? "unknown" : round(c.cost, 4),
      first_try_pass_share: t.first_try_checked
        ? round(t.first_try_pass / t.first_try_checked, 2)
        : null,
      avg_cost_pass: t.pass_tasks ? round(t.pass_cost / t.pass_tasks, 4) : null,
    };
    if (c.unknown_steps && row.cost_usd !== "unknown") row.unknown_price_steps = c.unknown_steps;
    return { row, cost: c.cost, steps: c.steps };
  });
  // most expensive first; unknown prices by step count
  rows.sort((a, b) => b.cost - a.cost || b.steps - a.steps || b.row.tasks - a.row.tasks);
  return rows.map((r) => r.row);
}

/** Cuts the cheapest lines, the longer list first, until the report fits 2 KB. */
export function fitReport(report: UsageReport, max = MAX_REPORT_BYTES): UsageReport {
  const size = (r: UsageReport) => Buffer.byteLength(JSON.stringify(r));
  if (size(report) <= max) return report;
  const out: UsageReport = {
    ...report,
    by_model: [...report.by_model],
    by_role: [...report.by_role],
  };
  let models = 0;
  let roles = 0;
  while (size(out) > max && out.by_model.length + out.by_role.length > 2) {
    if (out.by_model.length >= out.by_role.length && out.by_model.length > 1) {
      out.by_model.pop();
      models++;
    } else {
      out.by_role.pop();
      roles++;
    }
    out.more = { ...(models ? { models } : {}), ...(roles ? { roles } : {}) };
  }
  return out;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
