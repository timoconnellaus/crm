// Charts and numbers. These reuse the dashboard widget renderers, so a chart in chat is a widget
// (ADR 0346): the card's props become a widget spec and rows, and WidgetBody draws them.
import type { RendererProps } from "@relationship-os/agent-a2ui/react";
import type { WidgetSpec } from "@relationship-os/core/client";
import { useMemo } from "react";
import { type Row, WidgetBody, type WidgetData } from "../../dashboards/widget-renderers.tsx";
import { Body, Footer, Frame, Header, LinkButton } from "./parts.tsx";

type Spec = Pick<WidgetSpec, "type" | "title" | "mapping" | "options">;

/** A widget spec for a card: no SQL, because the rows came with it. */
function widget(spec: Spec): WidgetSpec {
  return { ...spec, layout: { w: 12, h: 2 } } as WidgetSpec;
}

const data = (rows: Row[], previous: Row[] | null = null): WidgetData => ({
  columns: Object.keys(rows[0] ?? {}),
  rows,
  previous: previous ? { rows: previous } : null,
});

const options = (format?: string, currency?: string) =>
  ({
    ...(format ? { format } : {}),
    ...(currency ? { currency } : {}),
  }) as WidgetSpec["options"];

export function KpiComponent({ props }: RendererProps<"kpi">) {
  const spec = useMemo(
    () =>
      widget({
        type: "kpi",
        title: props.title,
        mapping: { value: "value" },
        options: options(props.format, props.currency),
      }),
    [props.title, props.format, props.currency],
  );
  return (
    <Frame type="kpi">
      <Header title={props.title} />
      <Body>
        <WidgetBody
          widget={spec}
          data={data(
            [{ value: props.value }],
            props.previous === undefined ? null : [{ value: props.previous }],
          )}
        />
      </Body>
      {props.open && (
        <Footer>
          <LinkButton href={props.open} label="Open in dashboard" />
        </Footer>
      )}
    </Frame>
  );
}

export function ChartComponent({ props }: RendererProps<"chart">) {
  const spec = useMemo(() => {
    const y = Array.isArray(props.y) ? props.y : [props.y];
    const ranked = props.chart === "donut" || props.chart === "funnel";
    return widget({
      type: props.chart,
      title: props.title,
      mapping: ranked ? { label: props.x, value: y[0] as string } : { x: props.x, y },
      options: {
        ...options(props.format, props.currency),
        ...(props.orientation ? { orientation: props.orientation } : {}),
        ...(props.stacked ? { stacked: true } : {}),
      },
    });
  }, [props]);
  return (
    <Frame type="chart">
      <Header title={props.title} />
      <Body>
        <div className="h-44 min-w-0" role="img" aria-label={`${props.title}, ${props.chart} chart`}>
          <WidgetBody widget={spec} data={data(props.rows)} />
        </div>
      </Body>
      {props.open && (
        <Footer>
          <LinkButton href={props.open} label="Open in dashboard" />
        </Footer>
      )}
    </Frame>
  );
}

export function LeaderboardComponent({ props }: RendererProps<"leaderboard">) {
  const spec = useMemo(
    () =>
      widget({
        type: "leaderboard",
        title: props.title,
        mapping: { label: "label", value: "value" },
        options: options(props.format, props.currency),
      }),
    [props.title, props.format, props.currency],
  );
  return (
    <Frame type="leaderboard">
      <Header title={props.title} />
      <Body>
        <WidgetBody widget={spec} data={data(props.rows)} />
      </Body>
    </Frame>
  );
}
