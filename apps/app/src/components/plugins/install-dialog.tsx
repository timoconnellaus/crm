// Installing from the Plugins pages (ADR 0347): the same read-back the chat shows, as a dialog. It
// asks plugin.propose for what the plugin would add, then Install runs plugin.install with what was
// shown. The chat's card and this dialog share every check.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";

type Preview = CoreOutput<"plugin.propose">;
type Source = "first_party" | "workspace" | "marketplace";

export const PLUGIN_INVALIDATES = { invalidates: ["plugin.", "routine.", "view.", "dashboard."] };

export function InstallDialog({
  plugin,
  name,
  source,
  onClose,
}: {
  plugin: string;
  name: string;
  source: Source;
  onClose: () => void;
}) {
  const propose = useOpMutation("plugin.propose", {});
  const install = useOpMutation("plugin.install", PLUGIN_INVALIDATES);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adaptations, setAdaptations] = useState<{ from: string; to: string }[]>([]);
  const { mutateAsync } = propose;

  useEffect(() => {
    let live = true;
    mutateAsync({ plugin, source, adaptations })
      .then((out) => {
        if (live) setPreview(out);
      })
      .catch((error: unknown) => {
        if (live) setProblem(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [mutateAsync, plugin, source, adaptations]);

  async function confirm() {
    if (!preview) return;
    try {
      const out = await install.mutateAsync({
        plugin,
        version: preview.version,
        source: preview.source,
        fingerprint: preview.fingerprint,
        adaptations,
      });
      toast.success(
        out.status === "requested" ? out.message : `${name} installed. It's your own copy.`,
      );
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const p = preview?.preview;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="plugin-install-dialog">
        <DialogHeader>
          <DialogTitle>Install {name}</DialogTitle>
          <DialogDescription>
            It's your own copy, so you can change anything in it later.
          </DialogDescription>
        </DialogHeader>
        {problem && <p className="text-sm text-destructive">{problem}</p>}
        {!p && !problem && <Skeleton className="h-32 w-full" />}
        {p && (
          <div className="grid gap-4 text-sm">
            <section className="grid gap-1">
              <h3 className="font-medium">What it adds</h3>
              <ul className="grid gap-0.5">
                {p.adds.map((add) => (
                  <li key={`${add.kind}:${add.label}`} className="break-words">
                    <span className="text-muted-foreground">{add.kind}:</span> {add.label}
                  </li>
                ))}
              </ul>
            </section>
            {p.routines.length > 0 && (
              <section className="grid gap-1.5">
                <h3 className="font-medium">Things it will do on its own</h3>
                {p.routines.map((r) => (
                  <div key={r.key} className="grid gap-0.5" data-testid="plugin-routine">
                    <div>{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.when}
                      {r.fired === null
                        ? ""
                        : `. Tried on ${r.days} days: ${r.fired} message${r.fired === 1 ? "" : "s"}`}
                    </div>
                    {r.note && (
                      <div className="flex gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                        Jev: {r.note}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
            {p.checks.length > 0 && (
              <section className="grid gap-1">
                <h3 className="font-medium">Checks</h3>
                {p.checks.map((check) => (
                  <div key={check.text} className="flex items-center gap-1.5">
                    {check.passed ? (
                      <CheckIcon className="size-3.5 text-green-600" />
                    ) : (
                      <TriangleAlertIcon className="size-3.5 text-amber-600" />
                    )}
                    {check.text}
                  </div>
                ))}
              </section>
            )}
            {p.access.length > 0 && (
              <section className="grid gap-1">
                <h3 className="font-medium">Access it asks for</h3>
                <ul className="grid list-disc gap-0.5 pl-4">
                  {p.access.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            )}
            {p.needs.length > 0 && (
              <section className="grid gap-1.5">
                <h3 className="font-medium">Connections</h3>
                {p.needs.map((need) => (
                  <div key={need.key} className="flex flex-wrap items-center gap-2">
                    <span>{need.label}</span>
                    <Badge variant={need.met ? "secondary" : "outline"}>
                      {need.met ? "Connected" : "Waits for this"}
                    </Badge>
                    {need.swap && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setAdaptations([
                            { from: need.service, to: (need.swap as { service: string }).service },
                          ])
                        }
                      >
                        Use {need.swap.label} instead
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!preview || install.isPending}>
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
