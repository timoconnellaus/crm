// What cards are built from, after the mockup (docs/stages/assets/17/cards.html): the frame with
// header, body and footer, facts, record chips, links, and buttons. Everything wraps or cuts rather
// than widening the card, because cards live in a 384 px panel and on 390 px phones.
import type { A2uiAction, Fact, RecordRef, Tone } from "@relationship-os/agent-a2ui";
import { useA2uiAction } from "@relationship-os/agent-a2ui/react";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { cn } from "@relationship-os/ui/lib/utils";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { recordHref } from "#/lib/schema";
import { isAllowedHref, useCardHost } from "./host.tsx";

const FRAME_TONE = {
  default: "",
  pending: "border-amber-500/40 bg-amber-500/5",
  ok: "border-success/35",
  blocked: "border-destructive/35 bg-destructive/5",
} as const;

export function Frame({
  type,
  tone = "default",
  children,
  className,
  ...props
}: {
  /** The catalogue type, for tests. */
  type: string;
  tone?: keyof typeof FRAME_TONE;
  children: ReactNode;
} & Omit<ComponentProps<"section">, "children">) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-[var(--radius)] border bg-card text-sm shadow-xs",
        FRAME_TONE[tone],
        className,
      )}
      data-a2ui={type}
      {...props}
    >
      {children}
    </section>
  );
}

export function Header({
  title,
  subtitle,
  aside,
  lead,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 px-3 py-2.5">
      {lead}
      <div className="min-w-0 flex-1">
        {title && <div className="truncate font-medium">{title}</div>}
        {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {aside && <div className="shrink-0 text-xs text-muted-foreground">{aside}</div>}
    </header>
  );
}

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-w-0 gap-2 px-3 pb-3", className)}>{children}</div>;
}

export function Footer({ children }: { children: ReactNode }) {
  return <footer className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">{children}</footer>;
}

/** Rows of a list inside a card. */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="divide-y border-t" aria-label={label}>
      {children}
    </ul>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn("flex min-w-0 items-center gap-2.5 px-3 py-2", className)}>{children}</li>;
}

export function RowText({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate">{title}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "",
  info: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300",
  success: "bg-green-100 text-green-900 dark:bg-green-500/15 dark:text-green-300",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  danger: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
};

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge
      variant={tone === "neutral" ? "outline" : "secondary"}
      className={cn("max-w-full rounded-sm font-normal", TONE_CLASS[tone])}
    >
      <span className="truncate">{children}</span>
    </Badge>
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

export function Initials({
  name,
  square,
  className,
}: {
  name: string;
  square?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden bg-muted text-xs font-medium",
        square ? "rounded-md" : "rounded-full",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** A path or an allowed URL as a link; anything else as plain text. */
export function CardLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const host = useCardHost();
  if (!isAllowedHref(href)) return <span className={className}>{children}</span>;
  if (!href.startsWith("/")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        host.navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** A button-shaped link for a card's footer. */
export function LinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Button size="xs" variant="ghost" className="max-md:h-8" asChild>
      <CardLink href={href}>{label}</CardLink>
    </Button>
  );
}

export function Chip({ record }: { record: RecordRef }) {
  return (
    <CardLink
      href={recordHref(record.object, record.id)}
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background py-px pr-2 pl-0.5 text-xs leading-[18px] hover:bg-accent"
    >
      <Initials name={record.label} className="size-4 text-[8px]" />
      <span className="truncate">{record.label}</span>
    </CardLink>
  );
}

export function Chips({ records }: { records: readonly RecordRef[] }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {records.map((r) => (
        <Chip key={`${r.object}:${r.id}`} record={r} />
      ))}
    </div>
  );
}

export function Facts({ items }: { items: readonly Fact[] }) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {items.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 break-words">
            {fact.record ? <Chip record={fact.record} /> : fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** How long a second step stays unpressable, so a double tap cannot go through both steps. */
const ARM_DELAY_MS = 350;

/**
 * The deliberate second step (ADR 0345): the first press shows the confirm button and Cancel.
 * The confirm button takes a moment to accept a press, so a double tap never confirms.
 */
export function TwoStepButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  variant = "default",
  icon,
  testId,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  icon?: ReactNode;
  testId?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    setReady(false);
    const timer = setTimeout(() => {
      setReady(true);
    }, ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (ready) confirm.current?.focus();
  }, [ready]);
  if (!armed) {
    return (
      <Button
        size="xs"
        variant={variant}
        className="max-md:h-8"
        disabled={disabled}
        onClick={() => setArmed(true)}
        data-testid={testId}
      >
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <>
      <Button
        ref={confirm}
        size="xs"
        variant="destructive"
        className="max-md:h-8"
        disabled={disabled || !ready}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        {confirmLabel}
      </Button>
      <Button
        size="xs"
        variant="outline"
        className="max-md:h-8"
        onClick={() => setArmed(false)}
        data-testid={testId ? `${testId}-cancel` : undefined}
      >
        Cancel
      </Button>
    </>
  );
}

const BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  destructive: "destructive",
} as const;

/** One action as a button: busy, then what happened. A `confirm` label makes it two-step. */
export function ActionButton({
  action,
  extra,
  index = 0,
  disabled,
}: {
  action: A2uiAction;
  extra?: Record<string, unknown>;
  index?: number;
  disabled?: boolean;
}) {
  const state = useA2uiAction(action);
  const variant = BUTTON_VARIANT[action.style ?? (index === 0 ? "secondary" : "ghost")];
  const run = () => void state.run(extra);
  const busy = state.status === "busy";
  const finished = state.status === "done" && action.kind === "operation";
  const button =
    action.kind === "operation" && action.confirm ? (
      <TwoStepButton
        label={action.label}
        confirmLabel={action.confirm}
        onConfirm={run}
        disabled={disabled || busy || finished}
        variant={variant}
      />
    ) : (
      <Button
        size="xs"
        variant={variant}
        className="max-w-full max-md:h-8"
        disabled={disabled || busy || finished}
        onClick={run}
      >
        {busy && <LoaderCircleIcon className="animate-spin" />}
        {finished && <CheckIcon />}
        <span className="truncate">{action.label}</span>
      </Button>
    );
  return (
    <>
      {button}
      {state.message && (
        <span
          role="status"
          className={cn(
            "min-w-0 text-xs",
            state.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {state.message}
        </span>
      )}
    </>
  );
}

/** A card's buttons in its footer. */
export function ActionFooter({
  actions,
  children,
}: {
  actions?: readonly A2uiAction[] | undefined;
  children?: ReactNode;
}) {
  if (!actions?.length && !children) return null;
  return (
    <Footer>
      {actions?.map((action, i) => (
        <ActionButton key={action.label} action={action} index={i} />
      ))}
      {children}
    </Footer>
  );
}
