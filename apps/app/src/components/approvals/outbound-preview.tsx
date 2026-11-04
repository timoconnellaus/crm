// An outbound item in the Approvals inbox (ADR 0051): what the gatekeeper says the action will do,
// which is what the reviewer approves. Its action kind (and whether an admin could let that kind
// auto-apply), the connection and resource it acts on, the gatekeeper's Markdown description, and
// its literal fields. Field values are shown verbatim: HTML is shown as escaped source in a
// scroll box, never rendered.
import type { CoreOutput } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { cn } from "@crm/ui/lib/utils";
import { SendIcon } from "lucide-react";
import { Markdown } from "../markdown.tsx";

export type Outbound = NonNullable<CoreOutput<"approval.get">["actions"][number]["outbound"]>;

export function OutboundPreview({ outbound }: { outbound: Outbound }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border p-2.5" data-testid="outbound-preview">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <SendIcon className="size-3.5 text-muted-foreground" aria-hidden />
        {outbound.actionKind && (
          <Badge
            variant="secondary"
            className="rounded-sm px-1.5 font-normal"
            data-testid="outbound-kind"
            title={outbound.actionKind.tag}
          >
            {outbound.actionKind.label}
          </Badge>
        )}
        <span className="min-w-0 break-words text-muted-foreground">
          via {outbound.connectionTitle || outbound.vendor}
          {outbound.resourceTitle ? ` · ${outbound.resourceTitle}` : ""}
        </span>
        {outbound.autoApprovable && (
          <span className="text-muted-foreground">
            · auto-approvable (an admin can let this kind apply without review)
          </span>
        )}
      </div>
      {outbound.description.trim() && <Markdown>{outbound.description}</Markdown>}
      {outbound.fields.length > 0 && (
        <dl
          className="grid min-w-0 gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]"
          data-testid="outbound-fields"
        >
          {outbound.fields.map((field, index) => (
            // Fields can repeat a label (two "To" lines); their order is the gatekeeper's.
            // biome-ignore lint/suspicious/noArrayIndexKey: fields have no ids and never reorder.
            <OutboundField key={index} field={field} />
          ))}
        </dl>
      )}
      {!outbound.implementsRevert && (
        <p className="text-xs text-muted-foreground">Once applied, this cannot be undone.</p>
      )}
    </div>
  );
}

function OutboundField({ field }: { field: Outbound["fields"][number] }) {
  const long = field.syntax !== undefined || field.value.length > 120 || field.value.includes("\n");
  return (
    <>
      <dt className="text-xs text-muted-foreground sm:pt-0.5">{field.label}</dt>
      <dd className="min-w-0">
        {long ? (
          <pre
            className={cn(
              "max-h-64 overflow-auto rounded bg-muted/60 p-2 text-xs whitespace-pre-wrap break-words",
              field.syntax === "html" || field.syntax === "json" ? "font-mono" : "font-sans",
            )}
            data-syntax={field.syntax}
          >
            {field.value}
          </pre>
        ) : (
          <span className="break-words">{field.value}</span>
        )}
      </dd>
    </>
  );
}
