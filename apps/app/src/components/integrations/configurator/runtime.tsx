// Our runtime for the gatekeeper configurator authoring API (`@relationship-os/gatekeeper-configurator-ui`),
// built from @relationship-os/ui's shadcn components. Upstream renders each configurator spec in a sandboxed
// frame with its own runtime; the CRM renders the specs in the app instead (stage 6), and the app's
// Vite and Vitest configs alias the authoring API to this module (see vite-plugin.ts). The authoring
// API's docstrings are the behavioural spec for every component here.
import type {
  AutocompleteProps,
  ButtonProps,
  CheckboxListProps,
  ConfiguratorUIOption,
  FieldProps,
  NoticeProps,
  RadioCardsProps,
  SectionProps,
  TextInputProps,
} from "@relationship-os/gatekeeper-configurator-ui";
import {
  checkboxSelection,
  failureMessage,
  SEARCH_DEBOUNCE_MS,
  sanitizeOptions,
  splitList,
  withUnavailableOptions,
} from "@relationship-os/gatekeeper-configurator-ui/options";
import { Button as UIButton } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Command, CommandInput, CommandItem, CommandList } from "@relationship-os/ui/components/command";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@relationship-os/ui/components/popover";
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { cn } from "@relationship-os/ui/lib/utils";
import { CheckIcon, ChevronsUpDownIcon, CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FieldContext, type OptionsEntry, useField, useFrame } from "./form-context.ts";

export type * from "@relationship-os/gatekeeper-configurator-ui";
export { h } from "./compat.ts";
export { HierarchyPicker } from "./hierarchy-picker.tsx";
export { Fragment };

/** The specs type children as `unknown`; they are whatever `h` built. */
const node = (children: unknown) => children as ReactNode;

/** Groups related configurator fields. */
export function Section({ title, children }: SectionProps) {
  const id = useId();
  return (
    <section className="grid min-w-0 gap-5" aria-labelledby={title ? id : undefined}>
      {title ? (
        <h3 id={id} className="font-medium text-sm">
          {title}
        </h3>
      ) : null}
      {node(children)}
    </section>
  );
}

const LABELABLE = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"]);

/**
 * Labels and describes one control. Our controls take its ids from context; a spec's own markup
 * marks its control with `data-configurator-input` (as upstream's runtime expects), and the label
 * is tied to that element's id after render.
 */
export function Field({ label, description, optional = false, children }: FieldProps) {
  const base = useId();
  const controlId = `${base}control`;
  const labelId = `${base}label`;
  const descriptionId = description ? `${base}description` : undefined;
  const body = useRef<HTMLDivElement>(null);
  const hasControl = children !== undefined && children !== null && children !== false;
  const [forId, setForId] = useState<string | undefined>(hasControl ? controlId : undefined);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const own = element.querySelector<HTMLElement>(`[id="${controlId}"]`);
    const marked = element.querySelector<HTMLElement>("[data-configurator-input]");
    const target = own ?? marked;
    setForId(target?.id && LABELABLE.has(target.tagName) ? target.id : undefined);
  });

  return (
    <div className="grid min-w-0 gap-2">
      <div className="grid gap-1">
        <Label id={labelId} htmlFor={forId}>
          {label}
          {optional ? (
            <span className="font-normal text-muted-foreground text-xs">(optional)</span>
          ) : null}
        </Label>
        {description ? (
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {hasControl ? (
        <FieldContext.Provider value={{ controlId, labelId, descriptionId, optional }}>
          <div ref={body} className="min-w-0">
            {node(children)}
          </div>
        </FieldContext.Provider>
      ) : null}
    </div>
  );
}

/** A single-line text input. An emptied input reports null. */
export function TextInput({
  name,
  value,
  placeholder,
  onChange,
  optional,
  disabled,
}: TextInputProps) {
  const field = useField();
  return (
    <Input
      id={field?.controlId}
      name={name}
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      aria-describedby={field?.descriptionId}
      aria-required={optional || field?.optional ? undefined : true}
      data-configurator-input=""
      onChange={(event) =>
        onChange(event.currentTarget.value === "" ? null : event.currentTarget.value)
      }
    />
  );
}

/** Single-select cards, or with `compact` one bordered list of single-line rows. */
export function RadioCards({ value, options, onChange, compact }: RadioCardsProps) {
  const field = useField();
  const base = useId();
  return (
    <RadioGroup
      value={value ?? ""}
      onValueChange={onChange}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.descriptionId}
      className={cn(compact ? "gap-0 divide-y rounded-md border" : "grid gap-2")}
    >
      {options.map((option, index) => {
        const id = `${base}${index}`;
        const checked = option.value === value;
        return (
          <Label
            key={option.value}
            htmlFor={id}
            className={cn(
              "flex cursor-pointer font-normal",
              compact
                ? "min-w-0 items-center gap-3 px-3 py-2"
                : "items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50",
              !compact && checked && "border-primary bg-accent/40",
              compact && checked && "bg-accent/40",
            )}
          >
            <RadioGroupItem
              id={id}
              value={option.value}
              aria-describedby={`${id}d`}
              className={compact ? undefined : "mt-0.5"}
            />
            {compact ? (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-medium">{option.title}</span>
                <span id={`${id}d`} className="truncate text-muted-foreground">
                  {option.description}
                </span>
              </span>
            ) : (
              <span className="grid gap-0.5">
                <span className="font-medium">{option.title}</span>
                <span id={`${id}d`} className="text-muted-foreground">
                  {option.description}
                </span>
              </span>
            )}
          </Label>
        );
      })}
    </RadioGroup>
  );
}

/** Options lines shown under a title, as the option types carry them. */
function OptionText({ option }: { option: ConfiguratorUIOption }) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{option.title}</span>
        {option.meta ? (
          <span className="ml-auto shrink-0 text-muted-foreground text-xs">{option.meta}</span>
        ) : null}
      </span>
      {option.subtitle ? (
        <span className="truncate text-muted-foreground text-xs">{option.subtitle}</span>
      ) : null}
    </span>
  );
}

function LoadingRows({ rows = 3, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div className="grid gap-2 py-1" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={index} className="h-5 w-full" />
      ))}
    </div>
  );
}

function LoadFailed({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-destructive/40 px-3 py-2 text-sm">
      <span role="alert" className="flex-1 text-destructive">
        {message}
      </span>
      <UIButton type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </UIButton>
    </div>
  );
}

/** Filters a whole list in the browser once it is this long. */
const FILTER_FROM = 8;

/**
 * A multi-select list of every option, loaded once per `name` for the life of the form (a failed
 * load is retried when the list shows that name again), its selection a comma-separated value.
 */
export function CheckboxList(props: CheckboxListProps) {
  const generation = useFrame().generation(props.name);
  return <CheckboxListControl key={`${props.name}\u0000${generation}`} {...props} />;
}

function CheckboxListControl({
  name,
  value,
  loadOptions,
  onChange,
  allSelected = false,
  disabled = false,
}: CheckboxListProps) {
  const frame = useFrame();
  const field = useField();
  const base = useId();
  const [entry, setEntry] = useState<OptionsEntry | undefined>(() => frame.options.get(name));
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const load = useRef(loadOptions);
  load.current = loadOptions;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger.
  useEffect(() => {
    let live = true;
    const current = frame.options.get(name);
    if (!current || current.status === "failed") {
      const promise = Promise.resolve()
        .then(() => load.current())
        .then(
          (options): OptionsEntry => ({
            status: "ready",
            options: sanitizeOptions(options, "refuse"),
          }),
          (error: unknown): OptionsEntry => ({
            status: "failed",
            message: failureMessage(error, "The options couldn't be loaded."),
          }),
        )
        .then((settled) => {
          frame.options.set(name, settled);
          return settled;
        });
      frame.options.set(name, { status: "loading", promise });
    }
    const latest = frame.options.get(name);
    setEntry(latest);
    if (latest?.status === "loading") {
      latest.promise.then(() => {
        if (live) setEntry(frame.options.get(name));
      });
    }
    return () => {
      live = false;
    };
  }, [frame, name, attempt]);

  const describedBy = field?.descriptionId;
  if (!entry || entry.status === "loading") return <LoadingRows label="Loading options…" />;
  if (entry.status === "failed") {
    return (
      <LoadFailed
        message={entry.message}
        onRetry={() => {
          frame.options.delete(name);
          setAttempt((count) => count + 1);
        }}
      />
    );
  }

  const options = entry.options;
  const selected = checkboxSelection(options, value, allSelected);
  const shown = withUnavailableOptions(options, allSelected ? null : value);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? shown.filter((option) =>
        `${option.title} ${option.subtitle ?? ""}`.toLowerCase().includes(needle),
      )
    : shown;

  const toggle = (optionValue: string, checked: boolean) => {
    const current = new Set(splitList(value));
    if (checked) current.add(optionValue);
    else current.delete(optionValue);
    const ordered = shown.map((option) => option.value).filter((entry) => current.has(entry));
    onChange(ordered.length > 0 ? ordered.join(",") : null);
  };

  return (
    <fieldset
      aria-labelledby={field?.labelId}
      aria-describedby={describedBy}
      className="m-0 grid min-w-0 gap-2 border-0 p-0"
    >
      {shown.length >= FILTER_FROM ? (
        <Input
          type="search"
          value={filter}
          placeholder="Filter…"
          aria-label="Filter the list"
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      ) : null}
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing to choose from.</p>
      ) : (
        <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {visible.map((option, index) => {
            const id = `${base}${index}`;
            return (
              <label
                key={option.value}
                htmlFor={id}
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-3 py-2 text-sm",
                  disabled && "cursor-not-allowed opacity-70",
                )}
              >
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={selected.has(option.value)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggle(option.value, checked === true)}
                />
                <OptionText option={option} />
              </label>
            );
          })}
          {visible.length === 0 ? (
            <p className="px-3 py-2 text-muted-foreground text-sm">No matches.</p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

type Load =
  | { status: "loading" }
  | { status: "ready"; options: ConfiguratorUIOption[] }
  | { status: "failed"; message: string };

/** Choosing one option from those `loadOptions(query)` finds, searched as the user types. */
export function Autocomplete(props: AutocompleteProps) {
  const generation = useFrame().generation(props.name);
  return <AutocompleteControl key={`${props.name}\u0000${generation}`} {...props} />;
}

function AutocompleteControl({
  name,
  value,
  placeholder,
  loadOptions,
  onChange,
  optional = false,
  onClear,
  disabled = false,
}: AutocompleteProps) {
  const field = useField();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [titles, setTitles] = useState<ReadonlyMap<string, ConfiguratorUIOption>>(new Map());
  const loader = useRef(loadOptions);
  loader.current = loadOptions;
  const requests = useRef(0);

  const remember = useCallback(
    (options: readonly ConfiguratorUIOption[]) =>
      setTitles((known) => {
        const next = new Map(known);
        for (const option of options) next.set(option.value, option);
        return next;
      }),
    [],
  );

  // The typed query goes out once typing pauses.
  useEffect(() => {
    if (query === search) return;
    const timer = setTimeout(() => setSearch(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger.
  useEffect(() => {
    if (!open) return;
    const request = ++requests.current;
    setLoad({ status: "loading" });
    Promise.resolve()
      .then(() => loader.current(search))
      .then(
        (result) => {
          if (request !== requests.current) return;
          const options = sanitizeOptions(result, "truncate");
          remember(options);
          setLoad({ status: "ready", options });
        },
        (error: unknown) => {
          if (request !== requests.current) return;
          setLoad({ status: "failed", message: failureMessage(error, "Couldn't load options.") });
        },
      );
  }, [open, search, attempt]);

  // A value the list has not shown (a pre-filled one) is looked up so it shows its title.
  const known = value ? titles.get(value) : undefined;
  useEffect(() => {
    if (!value || known || disabled) return;
    let live = true;
    Promise.resolve()
      .then(() => loader.current(""))
      .then(
        (result) => {
          if (live) remember(sanitizeOptions(result, "truncate"));
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [value, known, disabled, remember]);

  const clearable = Boolean(value) && (optional || onClear !== undefined) && !disabled;
  const choose = (option: ConfiguratorUIOption) => {
    remember([option]);
    setOpen(false);
    setQuery("");
    setSearch("");
    onChange(option.value);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <UIButton
            id={field?.controlId}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-haspopup="listbox"
            aria-describedby={field?.descriptionId}
            data-configurator-input=""
            data-name={name}
            disabled={disabled}
            className="min-w-0 flex-1 justify-between font-normal"
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? (known?.title ?? value) : placeholder}
            </span>
            <ChevronsUpDownIcon className="opacity-50" aria-hidden="true" />
          </UIButton>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} />
            <CommandList id={listId}>
              {load.status === "loading" ? (
                <div role="status" className="py-6 text-center text-muted-foreground text-sm">
                  Loading…
                </div>
              ) : load.status === "failed" ? (
                <div className="grid justify-items-center gap-2 px-3 py-4 text-sm">
                  <span role="alert" className="text-center text-destructive">
                    {load.message}
                  </span>
                  <UIButton
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAttempt((count) => count + 1)}
                  >
                    Retry
                  </UIButton>
                </div>
              ) : load.options.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">No matches.</div>
              ) : (
                <div className="p-1">
                  {load.options.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => choose(option)}
                    >
                      <CheckIcon
                        aria-hidden="true"
                        className={cn(option.value === value ? "opacity-100" : "opacity-0")}
                      />
                      <OptionText option={option} />
                    </CommandItem>
                  ))}
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {clearable ? (
        <UIButton
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear"
          onClick={() => (onClear ? onClear() : onChange(null))}
        >
          <XIcon aria-hidden="true" />
        </UIButton>
      ) : null}
    </div>
  );
}

/**
 * A button. `disabled` ignores clicks but stays focusable. When a render removes the focused
 * Button, the form moves focus to its first control (see ConfiguratorForm).
 */
export function Button({ children, onClick, disabled = false, variant = "primary" }: ButtonProps) {
  return (
    <UIButton
      type="button"
      variant={variant === "secondary" ? "outline" : "default"}
      aria-disabled={disabled || undefined}
      data-configurator-button=""
      className={cn(disabled && "cursor-not-allowed opacity-50")}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {node(children)}
    </UIButton>
  );
}

/**
 * An inline message. An error is announced assertively (role="alert"); an info notice is announced
 * through the form's one polite live region, which reads the last info notice on screen whenever its
 * text changes. Only the message is announced, not the action.
 */
export function Notice({ children, tone = "info", action }: NoticeProps) {
  const error = tone === "error";
  const Icon = error ? CircleAlertIcon : InfoIcon;
  return (
    <div
      data-configurator-notice={tone}
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm",
        error ? "border-destructive/40 text-destructive" : "bg-muted/50",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1" role={error ? "alert" : undefined} data-notice-message="">
        {node(children)}
      </div>
      {action ? (
        <UIButton
          type="button"
          size="sm"
          variant="outline"
          aria-disabled={action.disabled || undefined}
          data-configurator-button=""
          className={cn("-my-1 shrink-0", action.disabled && "cursor-not-allowed opacity-50")}
          onClick={() => {
            if (!action.disabled) action.onClick();
          }}
        >
          {action.label}
        </UIButton>
      ) : null}
    </div>
  );
}
