// "Add resource" on a connection: choose a resource type the account can grant
// (connection.resourceTypes), choose the resource in that type's picker, then Save binds it
// (connection.bindResource). The picker is the gatekeeper's configurator spec rendered with our
// shadcn runtime; its `ui` calls go through connection.configure. A type with no spec (the
// dev-only fake gatekeeper) gets a generic form: one field per named group of its URL pattern.
import type { ConfiguratorUISpec } from "@crm/gatekeeper-configurator-ui";
import { Button } from "@crm/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@crm/ui/components/dialog";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@crm/ui/components/radio-group";
import { Skeleton } from "@crm/ui/components/skeleton";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { callOp } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import {
  ConfiguratorForm,
  type ConfiguratorFormHandle,
} from "./configurator/configurator-form.tsx";
import { configuratorSpecFor } from "./configurator/registry.ts";
import { uiProxy } from "./configurator/ui-proxy.ts";
import { patternForm } from "./pattern-fields.ts";

export interface AddResourceDialogProps {
  connection: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddResourceDialog({ connection, open, onOpenChange }: AddResourceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a resource</DialogTitle>
          <DialogDescription>
            Choose what {connection.title} may use: agents and sync reach only the resources you add
            here.
          </DialogDescription>
        </DialogHeader>
        {open && <AddResourceBody connection={connection} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function AddResourceBody({
  connection,
  onDone,
}: {
  connection: AddResourceDialogProps["connection"];
  onDone: () => void;
}) {
  const types = useOp("connection.resourceTypes", { id: connection.id });
  const grantable = useMemo(() => types.data?.items.filter((t) => t.grantable) ?? [], [types.data]);
  const [pattern, setPattern] = useState<string | null>(null);
  const chosen = grantable.find((t) => t.urlPattern === pattern) ?? null;
  const radioName = useId();

  useEffect(() => {
    if (pattern === null && grantable.length === 1) setPattern(grantable[0]?.urlPattern ?? null);
  }, [grantable, pattern]);

  if (types.isPending) return <Skeleton className="h-32" />;
  if (types.isError) {
    return (
      <p className="text-sm text-destructive" role="alert">
        Could not load resource types: {errorMessage(types.error)}
      </p>
    );
  }
  if (!grantable.length) {
    return <p className="text-sm text-muted-foreground">This account has nothing to add.</p>;
  }
  return (
    <div className="grid min-w-0 gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Resource type</legend>
        <RadioGroup
          name={radioName}
          value={pattern ?? ""}
          onValueChange={setPattern}
          className="grid gap-2"
        >
          {grantable.map((type) => {
            const id = `${radioName}-${type.urlPattern}`;
            return (
              <Label
                key={type.urlPattern}
                htmlFor={id}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem id={id} value={type.urlPattern} className="mt-0.5" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{type.title}</span>
                  {type.description && (
                    <span className="text-xs text-muted-foreground">{type.description}</span>
                  )}
                </span>
              </Label>
            );
          })}
        </RadioGroup>
      </fieldset>
      {chosen && (
        <ResourcePicker
          key={chosen.urlPattern}
          connectionId={connection.id}
          vendor={chosen.vendor}
          pattern={chosen.urlPattern}
          title={chosen.title}
          onDone={onDone}
        />
      )}
    </div>
  );
}

type SpecState =
  | { status: "loading" }
  | { status: "ready"; spec: ConfiguratorUISpec<unknown> }
  | { status: "none" };

function ResourcePicker({
  connectionId,
  vendor,
  pattern,
  title,
  onDone,
}: {
  connectionId: string;
  vendor: string;
  pattern: string;
  title: string;
  onDone: () => void;
}) {
  const [spec, setSpec] = useState<SpecState>({ status: "loading" });
  const bind = useOpMutation("connection.bindResource");

  useEffect(() => {
    let live = true;
    configuratorSpecFor(vendor, pattern).then(
      (loaded) => {
        if (live) setSpec(loaded ? { status: "ready", spec: loaded } : { status: "none" });
      },
      () => {
        if (live) setSpec({ status: "none" });
      },
    );
    return () => {
      live = false;
    };
  }, [vendor, pattern]);

  async function save(url: string) {
    try {
      const out = await bind.mutateAsync({ id: connectionId, url });
      toast.success(`Added ${out.resource.title}`);
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (spec.status === "loading") return <Skeleton className="h-24" />;
  if (spec.status === "none") {
    return <GenericPicker pattern={pattern} title={title} busy={bind.isPending} onSave={save} />;
  }
  return (
    <SpecPicker
      connectionId={connectionId}
      pattern={pattern}
      spec={spec.spec}
      busy={bind.isPending}
      onSave={save}
    />
  );
}

function SpecPicker({
  connectionId,
  pattern,
  spec,
  busy,
  onSave,
}: {
  connectionId: string;
  pattern: string;
  spec: ConfiguratorUISpec<unknown>;
  busy: boolean;
  onSave: (url: string) => Promise<void>;
}) {
  const form = useRef<ConfiguratorFormHandle>(null);
  const [ready, setReady] = useState(false);
  const ui = useMemo(
    () =>
      uiProxy(async (method, args) => {
        const out = await callOp("connection.configure", {
          id: connectionId,
          pattern,
          method,
          args,
        });
        return out.value;
      }),
    [connectionId, pattern],
  );

  async function submit() {
    try {
      const url = await form.current?.collectResourceUrl();
      if (url) await onSave(url);
    } catch {
      // The form shows why it has no resource yet.
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <ConfiguratorForm
        ref={form}
        spec={spec}
        ui={ui}
        resourceUrlPattern={pattern}
        // Widening the connection's grants (a new OAuth consent) is out of scope here: the
        // account was granted what its connect flow asked for, so report it as already granted.
        ensureResources={async () => true}
        onReadyChange={setReady}
      />
      <DialogFooter>
        <Button type="button" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function GenericPicker({
  pattern,
  title,
  busy,
  onSave,
}: {
  pattern: string;
  title: string;
  busy: boolean;
  onSave: (url: string) => Promise<void>;
}) {
  const form = useMemo(() => patternForm(pattern), [pattern]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const base = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const built = form.build(values);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setError(null);
    void onSave(built.url);
  }

  return (
    <form className="grid min-w-0 gap-3" onSubmit={submit} aria-label={`Choose a ${title}`}>
      <p className="text-xs text-muted-foreground">
        <code className="break-all font-mono">{pattern}</code>
      </p>
      {form.fields.map((field) => (
        <div key={field.name} className="grid gap-1.5">
          <Label htmlFor={`${base}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${base}-${field.name}`}
            value={values[field.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
        </div>
      ))}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
