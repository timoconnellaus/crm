// Entry points into the assistant (ADR 0030, ADR 0200): "Ask AI" in record headers, "Ask about N
// selected" on lists, and "Ask the assistant" links that open the panel pre-filled. Outside the
// signed-in shell (no AssistantProvider) they render nothing.
import { Button } from "@relationship-os/ui/components/button";
import { MessageSquareIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  type AskOptions,
  type AssistantRecord,
  useOptionalAssistant,
  usePublishRecord,
} from "./assistant-provider.tsx";

/** "Ask AI" for a record header: opens the panel scoped to the record. */
// It also tells the assistant which record "this" is while the page shows it.
export function AskAiButton({ record }: { record: AssistantRecord }) {
  const assistant = useOptionalAssistant();
  usePublishRecord(record);
  if (!assistant) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => assistant.ask({ record })}
      data-testid="ask-ai"
    >
      <SparklesIcon />
      Ask AI
    </Button>
  );
}

/** "Ask about N selected" in a list's bulk toolbar. */
export function AskAboutSelected({ object, ids }: { object: string; ids: string[] }) {
  const assistant = useOptionalAssistant();
  if (!assistant || !ids.length) return null;
  const n = ids.length;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        assistant.ask({
          selection: { object, ids: ids.slice(0, 200) },
          prompt: `About these ${n} selected: `,
        })
      }
      data-testid="ask-about-selected"
    >
      <SparklesIcon />
      Ask about {n > 200 ? "the first 200" : n} selected
    </Button>
  );
}

/** A button that opens the assistant with a prompt (and scope) ready to send. */
export function AskAssistantButton({
  options,
  children = "Ask the assistant",
}: {
  options: AskOptions;
  children?: ReactNode;
}) {
  const assistant = useOptionalAssistant();
  if (!assistant) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => assistant.ask(options)}
      data-testid="ask-assistant"
    >
      <MessageSquareIcon />
      {children}
    </Button>
  );
}
