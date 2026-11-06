// Settings → Assignment rules (ADR 0246): per object with an owner field, the ordered rules, the
// fallback owner and a Test box. The first enabled rule whose conditions all hold gives a record
// created without an owner its owner. Changing rules is for human admins; others see them.
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Label } from "@relationship-os/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FieldEditor } from "#/components/fields/field-widgets";
import { PageLayout } from "#/components/layout/page-layout";
import {
  type AssignmentRule,
  conditionText,
  editorField,
  RuleDialog,
} from "#/components/settings/assignment-rule-dialog";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { type ObjectInfo, useSchemaObjects } from "#/lib/schema";
import { useUsers } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/settings/assignment-rules")({
  component: AssignmentRulesPage,
});

const NO_OWNER = "__none__";

function AssignmentRulesPage() {
  const { isAdmin } = Route.useRouteContext();
  const list = useOp("assignment.list", {});
  const schema = useSchemaObjects();
  const [chosen, setChosen] = useState<string | null>(null);
  const objects = list.data?.objects ?? [];
  const current = objects.find((o) => o.object === chosen) ?? objects[0];
  const info = schema.data?.objects.find((o) => o.name === current?.object);
  return (
    <PageLayout
      title="Assignment rules"
      width="lg"
      back={{ to: "/settings", label: "Settings" }}
      description="Who owns a record created without an owner. The first rule that matches wins; rules run when a record is created, and when you choose Assign by rules in a list."
    >
      {list.isPending && <Skeleton className="h-40 w-full" />}
      {list.error && <p className="text-sm text-destructive">{errorMessage(list.error)}</p>}
      {current && (
        <div className="grid gap-1.5">
          <Label htmlFor="assignment-object">Records</Label>
          <Select value={current.object} onValueChange={setChosen}>
            <SelectTrigger id="assignment-object" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {objects.map((o) => (
                <SelectItem key={o.object} value={o.object}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {current && info && (
        <ObjectRules
          key={current.object}
          info={info}
          objects={schema.data?.objects ?? []}
          rules={current.rules as AssignmentRule[]}
          fallbackUserId={current.fallbackUserId}
          canEdit={isAdmin}
        />
      )}
    </PageLayout>
  );
}

function ObjectRules({
  info,
  objects,
  rules,
  fallbackUserId,
  canEdit,
}: {
  info: ObjectInfo;
  objects: readonly ObjectInfo[];
  rules: AssignmentRule[];
  fallbackUserId: string | null;
  canEdit: boolean;
}) {
  const users = useUsers();
  const name = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const [editing, setEditing] = useState<AssignmentRule | "new" | null>(null);
  const remove = useOpMutation("assignment.delete");
  const reorder = useOpMutation("assignment.reorder");
  const setFallback = useOpMutation("assignment.setFallback");

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  function move(index: number, by: -1 | 1) {
    const ids = rules.map((r) => r.id);
    const [id] = ids.splice(index, 1);
    if (!id) return;
    ids.splice(index + by, 0, id);
    void run(() => reorder.mutateAsync({ object: info.name, ids }));
  }

  return (
    <>
      <Card data-testid="assignment-rules">
        <CardHeader className="flex flex-row flex-wrap items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <CardTitle className="text-base">Rules</CardTitle>
            <CardDescription>Checked in order. The first match gives the owner.</CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <PlusIcon />
              Add rule
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-2">
          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No rules yet. The fallback owner applies.
            </p>
          )}
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
              data-testid="assignment-rule"
            >
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {index + 1}. {rule.name}
                  {!rule.enabled && <Badge variant="outline">Off</Badge>}
                </p>
                <p className="text-muted-foreground">
                  {rule.conditions.length
                    ? rule.conditions.map((c) => conditionText(info, objects, c)).join(" and ")
                    : "Every record"}
                  {" → "}
                  {rule.method === "roundRobin" ? "round-robin: " : ""}
                  {rule.userIds.map(name).join(", ")}
                </p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${rule.name} up`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${rule.name} down`}
                    disabled={index === rules.length - 1 || reorder.isPending}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => setEditing(rule)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${rule.name}`}
                    disabled={remove.isPending}
                    onClick={() => void run(() => remove.mutateAsync({ id: rule.id }))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fallback owner</CardTitle>
          <CardDescription>Used when no rule matches.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            disabled={!canEdit || setFallback.isPending}
            value={fallbackUserId ?? NO_OWNER}
            onValueChange={(value) =>
              void run(() =>
                setFallback.mutateAsync({
                  object: info.name,
                  userId: value === NO_OWNER ? null : value,
                }),
              )
            }
          >
            <SelectTrigger aria-label="Fallback owner" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_OWNER}>No owner</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <TestBox info={info} rules={rules} />

      {editing && (
        <RuleDialog
          info={info}
          objects={objects}
          rule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** Shows which rule a sample record would match, from the fields the rules test. */
function TestBox({ info, rules }: { info: ObjectInfo; rules: AssignmentRule[] }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const test = useOpMutation("assignment.test");
  const names = [...new Set(rules.flatMap((r) => r.conditions.map((c) => c.via ?? c.field)))];
  const fields = names.flatMap((n) => info.fields.find((f) => f.name === n) ?? []);

  async function submit() {
    try {
      await test.mutateAsync({ object: info.name, values });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const result = test.data;
  return (
    <Card data-testid="assignment-test">
      <CardHeader>
        <CardTitle className="text-base">Test</CardTitle>
        <CardDescription>
          See who a sample record would go to. Nothing is created and no rotation moves.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {fields.map((field) => (
          <div key={field.name} className="grid max-w-sm gap-1.5">
            <Label htmlFor={`test-${field.name}`}>{field.label}</Label>
            <FieldEditor
              id={`test-${field.name}`}
              field={editorField(field)}
              value={values[field.name] ?? null}
              onChange={(value) => setValues((v) => ({ ...v, [field.name]: value }))}
            />
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={test.isPending}
          onClick={() => void submit()}
        >
          Test
        </Button>
        {result && (
          <p className="text-sm" data-testid="assignment-test-result" role="status">
            {result.fallback
              ? result.ownerName
                ? `No rule matches. The fallback owner, ${result.ownerName}, gets it.`
                : "No rule matches, and there is no fallback owner."
              : `${result.ruleName} matches. ${result.ownerName} gets it.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
