// An in-memory stand-in for the CRM's dashboard operations over MCP, following their contract:
// widget.preview (through call_operation) returns the columns the SELECT names and some rows, or
// an invalid_input error for SQL the server would refuse (a parameter no filter binds, a bad
// view); dashboard.create returns an id; dashboard.delete deletes it.
import { fakeSession, type Handler } from "@relationship-os/evals-mcp/test/fakes.ts";

const SYSTEM = ["now", "today", "me", "record_id"];

/** The result columns of a SELECT: each select-list item's alias, or its bare column name. */
export function selectColumns(sql: string): string[] {
  const list = /^\s*select\s+([\s\S]*?)\s+from\s/i.exec(sql)?.[1] ?? "";
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of list) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += c;
  }
  items.push(current);
  return items.map((item) => {
    const alias = /\bas\s+"?(\w+)"?\s*$/i.exec(item.trim())?.[1];
    return alias ?? item.trim().split(".").at(-1) ?? item.trim();
  });
}

const fail = (message: string) => ({
  isError: true,
  error: { code: "invalid_input", message },
});

function preview(input: Record<string, unknown>) {
  const widget = (input.widget ?? {}) as { sql?: string; type?: string };
  const sql = widget.sql ?? "";
  if (!sql.trim()) return fail(`widget: ${widget.type} widgets need sql`);
  if (!/^\s*(select|with)\b/i.test(sql)) return fail("Only SELECT queries are allowed");
  const view = /\bfrom\s+(\w+)/i.exec(sql)?.[1] ?? "";
  if (!view.startsWith("crm_")) return fail(`no such table: ${view}`);
  const filters = (input.dashboardFilters ?? []) as { type: string; id: string }[];
  const allowed = [
    ...SYSTEM,
    ...filters.flatMap((f) => (f.type === "dateRange" ? [`${f.id}_from`, `${f.id}_to`] : [f.id])),
  ];
  for (const [, name] of sql.matchAll(/:([a-z_]+)/g)) {
    if (!allowed.includes(name as string)) return fail(`unknown parameter :${name}`);
  }
  const columns = selectColumns(sql);
  const limit = Number(/\blimit\s+(\d+)/i.exec(sql)?.[1] ?? 0);
  const count = /\bunion\b/i.test(sql) ? 3 : widget.type === "kpi" ? 1 : limit || 7;
  const rows = Array.from({ length: count }, (_, i) =>
    Object.fromEntries(columns.map((c) => [c, i])),
  );
  return {
    widgetId: "w",
    columns,
    rows,
    rowCount: rows.length,
    truncated: false,
    cached: false,
    cachedAt: "2026-11-05T00:00:00.000Z",
    params: {},
    previous: null,
    views: [view],
  };
}

/** The CRM's handlers; every session shares the one dashboard store. */
export function fakeCrm() {
  const dashboards = new Set<string>();
  let next = 0;
  const operations: Record<string, Handler> = {
    "widget.preview": preview,
    "dashboard.create": () => {
      next += 1;
      const id = `dsh_${next}`;
      dashboards.add(id);
      return { id, title: "Made by the model" };
    },
    "dashboard.delete": (input) =>
      dashboards.delete(String(input.id))
        ? { id: input.id, deleted: true }
        : { isError: true, error: { code: "not_found", message: "no such dashboard" } },
  };
  const handlers: Record<string, Handler> = {
    query_sql: () => ({ columns: ["n"], rows: [{ n: 1 }] }),
    describe_operations: () => ({
      operations: Object.keys(operations).map((name) => ({ name, allowed: true })),
    }),
    call_operation: (args) => {
      const op = operations[String(args.name)];
      if (!op) return { isError: true, error: { code: "unknown_operation", message: "unknown" } };
      return op((args.input ?? {}) as Record<string, unknown>);
    },
  };
  return { handlers, dashboards, session: () => fakeSession(handlers, "CRM instructions") };
}
