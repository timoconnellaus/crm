// Record page panels from plugins (ADR 0347): a saved card, run for the record in view. No plugin
// panels for this object: nothing renders.
import { Card as Surface, CardContent, CardHeader, CardTitle } from "@relationship-os/ui/components/card";
import { Card } from "#/components/assistant/cards";
import { useOp } from "#/lib/query";

function Panel({
  label,
  producer,
  input,
}: {
  label: string;
  producer: string;
  input: Record<string, unknown>;
}) {
  const card = useOp("a2ui.produce", { producer, input });
  if (!card.data) return null;
  return (
    <Surface data-testid="plugin-record-panel">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <Card part={card.data.part} />
      </CardContent>
    </Surface>
  );
}

export function PluginRecordPanels({ object, id }: { object: string; id: string }) {
  const contributions = useOp("plugin.contributions", { object });
  return (
    <>
      {contributions.data?.recordPanels.map((panel) => (
        <Panel
          key={panel.key}
          label={panel.label}
          producer={panel.producer}
          input={{ ...panel.input, recordId: id }}
        />
      ))}
    </>
  );
}
