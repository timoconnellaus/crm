// The slice of @crm/core this eval uses: the in-app "Describe a widget" prompt and parser, the
// widget types and the Overview dashboard's filters. Loaded at runtime by a non-literal specifier,
// as evals/mcp's tests do, so tsc does not type-check core's Workers-typed sources under this
// Node-typed package. Core uses TypeScript parameter properties, which Node's default type
// stripping refuses: the runner and smoke script run with --experimental-transform-types.

export type WidgetType =
  | "kpi"
  | "bar"
  | "line"
  | "donut"
  | "funnel"
  | "table"
  | "leaderboard"
  | "markdown";

export interface WidgetMapping {
  x?: string;
  y?: string | string[];
  series?: string;
  label?: string;
  value?: string;
  columns?: string[];
}

/** A widget spec as the model writes it (validated by the server, not here). */
export interface WidgetSpec {
  id?: string;
  type?: string;
  title?: string;
  sql?: string | null;
  mapping?: WidgetMapping;
  options?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** A dashboard filter definition (dateRange, user, select, field, text). */
export interface DashboardFilter {
  type: string;
  id: string;
  label: string;
  default?: unknown;
  [extra: string]: unknown;
}

export interface CoreMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DashboardsCore {
  describePrompt(prompt: string, filters: readonly DashboardFilter[]): CoreMessage[];
  extractJson(text: string): unknown;
  WIDGET_TYPES: readonly WidgetType[];
  OVERVIEW_DASHBOARD: { spec: { filters: DashboardFilter[] } };
}

const coreSpecifier = "@crm/core";

/** Imports @crm/core, with a clear message when Node runs without type transforms. */
export async function loadCore(): Promise<DashboardsCore> {
  try {
    return (await import(coreSpecifier)) as DashboardsCore;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/strip-only|not supported in strip/i.test(message)) {
      throw new Error(
        "@crm/core needs Node's TypeScript transforms: run with " +
          "`node --experimental-transform-types evals/dashboards/runner.ts` " +
          "(or `pnpm --filter @crm/evals-dashboards eval`).",
      );
    }
    throw error;
  }
}
