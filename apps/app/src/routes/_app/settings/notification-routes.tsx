// Settings → Notifications → Slack channel routes (stage 6b, ADR 0172), human admins only: post a
// short message with a link to a Slack channel when a record of an object is created, updated or
// deleted, optionally only on a field change (a value, or a move to a won / lost stage). Saved as
// a whole list with notification.setRoutes; activities (synced email and meetings) can't be routed.
import type { CoreInput, CoreOutput } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardContent } from "@crm/ui/components/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { Skeleton } from "@crm/ui/components/skeleton";
import { Switch } from "@crm/ui/components/switch";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HashIcon, LockIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { type ObjectInfo, useSchemaObjects } from "#/lib/schema";

export const Route = createFileRoute("/_app/settings/notification-routes")({
  component: NotificationRoutesPage,
});

type RouteRow = CoreOutput<"notification.routes">["routes"][number];
type RouteEvent = RouteRow["event"];

const EVENTS: { value: RouteEvent; label: string }[] = [
  { value: "created", label: "is created" },
  { value: "updated", label: "is updated" },
  { value: "deleted", label: "is deleted" },
];

/** Objects that can never be routed (synced email and meetings stay out of Slack). */
const UNROUTABLE = new Set(["activity"]);

/** The condition on an update: any change, a stage move by type, or a field reaching a value. */
type Condition = "any" | "won" | "lost" | "value";

function NotificationRoutesPage() {
  const { isAdmin } = Route.useRouteContext();
  return (
    <PageLayout
      title="Slack channel routes"
      width="md"
      back={{ to: "/settings/notifications", label: "Notifications" }}
      description={
        <>
          Post to a Slack channel when records change, e.g. deals won → #sales. Messages carry the
          route's label, the record's title and a link, and go out through the Slack connection
          chosen under{" "}
          <Link to="/settings/notification-delivery" className="underline">
            Delivery
          </Link>
          .
        </>
      }
    >
      {isAdmin ? (
        <RoutesList />
      ) : (
        <p
          className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm"
          role="note"
        >
          <LockIcon className="size-4" aria-hidden />
          Only admins can see and change Slack channel routes.
        </p>
      )}
    </PageLayout>
  );
}

function stageTypeOf(match: RouteRow["to"]): string | null {
  return match && typeof match === "object" && "stageType" in match ? match.stageType : null;
}

function routeSummary(route: RouteRow, objects: ObjectInfo[]): string {
  const object = objects.find((o) => o.name === route.object);
  const parts = [`${object?.label ?? route.object} ${route.event}`];
  if (route.field) {
    const field = object?.fields.find((f) => f.name === route.field);
    const stageType = stageTypeOf(route.to);
    if (stageType) parts.push(`moves to a ${stageType} stage`);
    else if (route.to !== undefined)
      parts.push(`${field?.label ?? route.field} becomes ${JSON.stringify(route.to)}`);
    else parts.push(`${field?.label ?? route.field} changes`);
  }
  return parts.join(", ");
}

function RoutesList() {
  const routes = useOp("notification.routes", {});
  const schema = useSchemaObjects();
  const delivery = useOp("notification.deliverySettings", {});
  const save = useOpMutation("notification.setRoutes", { invalidates: ["notification."] });
  const [editing, setEditing] = useState<RouteRow | "new" | null>(null);

  if (routes.isPending || schema.isPending) return <Skeleton className="h-48" />;
  if (routes.isError) {
    return (
      <ErrorState
        title="Could not load the routes"
        error={routes.error}
        onRetry={() => void routes.refetch()}
      />
    );
  }
  const objects = (schema.data?.objects ?? []).filter((o) => !UNROUTABLE.has(o.name));
  const list = routes.data.routes;

  async function replace(next: CoreInput<"notification.setRoutes">["routes"], done: string) {
    try {
      await save.mutateAsync({ routes: next });
      toast.success(done);
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    }
  }

  const add = (
    <Button onClick={() => setEditing("new")} disabled={list.length >= 50}>
      <PlusIcon />
      Add route
    </Button>
  );

  return (
    <div className="grid gap-4">
      {delivery.data && !delivery.data.slack && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="note">
          No Slack connection is chosen for notifications yet, so routes don't post. Pick one under{" "}
          <Link to="/settings/notification-delivery" className="underline">
            Delivery
          </Link>
          .
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState
          icon={HashIcon}
          title="No channel routes"
          description="Add one to post record events, such as a deal won, to a Slack channel."
          action={add}
        />
      ) : (
        <>
          <ul className="grid gap-3" aria-label="Slack channel routes">
            {list.map((route) => (
              <li key={route.id}>
                <Card data-testid="notification-route" data-route={route.id} className="py-4">
                  <CardContent className="flex flex-wrap items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{route.label}</span>
                        <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
                          {route.channel.startsWith("#") ? route.channel : `#${route.channel}`}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {routeSummary(route, objects)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={route.enabled}
                        disabled={save.isPending}
                        aria-label={`Enable ${route.label}`}
                        onCheckedChange={(enabled) =>
                          void replace(
                            list.map((r) => (r.id === route.id ? { ...r, enabled } : r)),
                            enabled ? `${route.label} on` : `${route.label} off`,
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${route.label}`}
                        onClick={() => setEditing(route)}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${route.label}`}
                        disabled={save.isPending}
                        onClick={() =>
                          void replace(
                            list.filter((r) => r.id !== route.id),
                            `${route.label} deleted`,
                          )
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          <div>{add}</div>
        </>
      )}
      {editing && (
        <RouteDialog
          route={editing === "new" ? null : editing}
          objects={objects}
          saving={save.isPending}
          onClose={() => setEditing(null)}
          onSave={async (route) => {
            const next =
              editing === "new"
                ? [...list, route]
                : list.map((r) => (r.id === editing.id ? { ...route, id: r.id } : r));
            if (await replace(next, `${route.label} saved`)) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function initialCondition(route: RouteRow | null): Condition {
  if (!route?.field) return "any";
  const stageType = stageTypeOf(route.to);
  if (stageType === "won" || stageType === "lost") return stageType;
  return route.to !== undefined ? "value" : "any";
}

function RouteDialog({
  route,
  objects,
  saving,
  onClose,
  onSave,
}: {
  route: RouteRow | null;
  objects: ObjectInfo[];
  saving: boolean;
  onClose: () => void;
  onSave: (route: Omit<RouteRow, "id">) => Promise<void>;
}) {
  const [label, setLabel] = useState(route?.label ?? "");
  const [object, setObject] = useState(route?.object ?? objects[0]?.name ?? "");
  const [event, setEvent] = useState<RouteEvent>(route?.event ?? "created");
  const [condition, setCondition] = useState<Condition>(initialCondition(route));
  const [field, setField] = useState(
    route?.field && initialCondition(route) === "value" ? route.field : "",
  );
  const [value, setValue] = useState(
    typeof route?.to === "string" || typeof route?.to === "number" ? String(route.to) : "",
  );
  const [channel, setChannel] = useState(route?.channel ?? "");

  const info = objects.find((o) => o.name === object);
  const stageField = typeof info?.stages?.field === "string" ? info.stages.field : null;
  const fields = (info?.fields ?? []).filter((f) => f.track || f.filterable);
  const valid =
    label.trim() !== "" &&
    object !== "" &&
    /^#?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(channel.trim()) &&
    (event !== "updated" || condition !== "value" || (field !== "" && value.trim() !== ""));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    const base = { label: label.trim(), object, event, channel: channel.trim(), enabled: true };
    if (route) base.enabled = route.enabled;
    if (event === "updated" && (condition === "won" || condition === "lost") && stageField) {
      await onSave({ ...base, field: stageField, to: { stageType: condition } });
    } else if (event === "updated" && condition === "value") {
      await onSave({ ...base, field, to: value.trim() });
    } else {
      await onSave(base);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{route ? "Edit route" : "Add a channel route"}</DialogTitle>
            <DialogDescription>
              Each matching change posts the label, the record's title and a link.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="route-label">Label</Label>
            <Input
              id="route-label"
              value={label}
              maxLength={120}
              placeholder="Deal won"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="route-object">When a</Label>
              <Select
                value={object}
                onValueChange={(v) => {
                  setObject(v);
                  setField("");
                  setCondition("any");
                }}
              >
                <SelectTrigger id="route-object" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {objects.map((o) => (
                    <SelectItem key={o.name} value={o.name}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="route-event">Event</Label>
              <Select value={event} onValueChange={(v) => setEvent(v as RouteEvent)}>
                <SelectTrigger id="route-event" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENTS.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {event === "updated" && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="route-condition">Only when</Label>
                <Select value={condition} onValueChange={(v) => setCondition(v as Condition)}>
                  <SelectTrigger id="route-condition" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any change</SelectItem>
                    {stageField && <SelectItem value="won">It moves to a won stage</SelectItem>}
                    {stageField && <SelectItem value="lost">It moves to a lost stage</SelectItem>}
                    <SelectItem value="value">A field changes to a value</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {condition === "value" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="route-field">Field</Label>
                    <Select value={field} onValueChange={setField}>
                      <SelectTrigger id="route-field" className="w-full">
                        <SelectValue placeholder="Choose a field" />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        {fields.map((f) => (
                          <SelectItem key={f.name} value={f.name}>
                            {f.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="route-value">Becomes</Label>
                    <Input
                      id="route-value"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="route-channel">Slack channel</Label>
            <Input
              id="route-channel"
              value={channel}
              maxLength={80}
              placeholder="#sales"
              onChange={(e) => setChannel(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? "Saving…" : "Save route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
