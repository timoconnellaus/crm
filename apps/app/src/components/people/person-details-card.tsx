// Person details card with inline edit (`e`, or the Edit button): names, emails, phones,
// location and timezone, social profiles, owner, tags and the Markdown description. Saves the
// changed fields with person.update.
import type { Person } from "@crm/core";
import { Badge } from "@crm/ui/components/badge";
import { Button } from "@crm/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@crm/ui/components/card";
import { Input } from "@crm/ui/components/input";
import { Label } from "@crm/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@crm/ui/components/select";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useHotkey } from "#/lib/hotkeys";
import { patchRecord, plainPatch } from "#/lib/optimistic";
import { errorMessage, useOpMutation } from "#/lib/query";
import { useUserLabel, useUsers } from "#/lib/users-adapter";
import { RowList, TagInput } from "../fields.tsx";
import { Markdown, MarkdownEditor } from "../markdown.tsx";
import { draftToUpdate, isEmptyUpdate, type PersonDraft, toDraft } from "./person-draft.ts";

export interface PersonDetailsCardProps {
  person: Person;
  /** Read-only (e.g. the person is in Trash). */
  readOnly?: boolean;
}

const NO_OWNER = "__none__";

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function localTime(timezone: string | null): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeStyle: "short", timeZone: timezone }).format(
      new Date(),
    );
  } catch {
    return null;
  }
}

export function PersonDetailsCard({ person, readOnly }: PersonDetailsCardProps) {
  const [editing, setEditing] = useState(false);
  // A save that failed after the form closed optimistically reopens it with the draft and error.
  const [failed, setFailed] = useState<{ draft: PersonDraft; error: string } | null>(null);
  useHotkey("e", () => setEditing(true), { enabled: !editing && !readOnly });
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);

  return (
    <Card className="gap-3 py-4" data-testid="details-card">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Details</CardTitle>
        {!editing && !readOnly && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-keyshortcuts="e"
              data-testid="edit-details"
            >
              <PencilIcon />
              Edit
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">
        {editing ? (
          <DetailsForm
            person={person}
            retry={failed}
            onDone={() => {
              setEditing(false);
              setFailed(null);
            }}
            onFailed={(draft, error) => {
              setFailed({ draft, error });
              setEditing(true);
            }}
          />
        ) : (
          <DetailsView person={person} />
        )}
      </CardContent>
    </Card>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

const Empty = () => <span className="text-muted-foreground">—</span>;

function DetailsView({ person }: { person: Person }) {
  const userLabel = useUserLabel();
  const time = localTime(person.timezone);
  return (
    <dl className="grid gap-3">
      <Item label="Emails">
        {person.emails.length ? (
          <ul className="grid gap-0.5">
            {person.emails.map((e) => (
              <li key={e.email} className="flex flex-wrap items-center gap-1.5">
                <a href={`mailto:${e.email}`} className="truncate hover:underline">
                  {e.email}
                </a>
                {e.label && <span className="text-xs text-muted-foreground">{e.label}</span>}
                {e.primary && person.emails.length > 1 && (
                  <Badge variant="secondary">Primary</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Phones">
        {person.phones.length ? (
          <ul className="grid gap-0.5">
            {person.phones.map((p) => (
              <li key={p.number} className="flex flex-wrap items-center gap-1.5">
                <a href={`tel:${p.number}`} className="hover:underline">
                  {p.number}
                </a>
                {p.label && <span className="text-xs text-muted-foreground">{p.label}</span>}
                {p.primary && person.phones.length > 1 && (
                  <Badge variant="secondary">Primary</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Location">{person.location ?? <Empty />}</Item>
      <Item label="Timezone">
        {person.timezone ? (
          <>
            {person.timezone}
            {time && <span className="text-muted-foreground"> · {time} local time</span>}
          </>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Social profiles">
        {person.socialProfiles.length ? (
          <ul className="grid gap-0.5">
            {person.socialProfiles.map((s) => (
              <li key={s.url}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {s.handle || s.network}
                </a>{" "}
                <span className="text-xs text-muted-foreground">{s.network}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Owner">{userLabel(person.ownerId) || <Empty />}</Item>
      <Item label="Tags">
        {person.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {person.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </span>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Description">
        {person.description ? <Markdown>{person.description}</Markdown> : <Empty />}
      </Item>
    </dl>
  );
}

function DetailsForm({
  person,
  retry,
  onDone,
  onFailed,
}: {
  person: Person;
  retry: { draft: PersonDraft; error: string } | null;
  onDone: () => void;
  onFailed: (draft: PersonDraft, error: string) => void;
}) {
  const [draft, setDraft] = useState<PersonDraft>(() => retry?.draft ?? toDraft(person));
  const [error, setError] = useState<string | null>(retry?.error ?? null);
  const client = useQueryClient();
  const update = useOpMutation("person.update");
  const users = useUsers();
  const zones = useMemo(timezones, []);
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof PersonDraft>(key: K, value: PersonDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const owners = [...users];
  if (person.ownerId && !owners.some((u) => u.id === person.ownerId)) {
    owners.push({ id: person.ownerId, name: person.ownerId, email: "" });
  }

  async function onSubmit(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    const input = draftToUpdate(person, draft);
    if (isEmptyUpdate(input)) {
      onDone();
      return;
    }
    // Optimistic: the details show the new values and the form closes at once. A failed save
    // rolls the details back and reopens the form with the draft and the error.
    const rollback = await patchRecord(client, ["person."], person.id, plainPatch(input));
    onDone();
    try {
      await update.mutateAsync(input);
      toast.success("Saved");
    } catch (caught) {
      rollback();
      onFailed(draft, errorMessage(caught));
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="grid gap-4"
      aria-label="Edit details"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          // Leave Escape to open popovers/selects first.
          if ((event.target as HTMLElement).closest("[data-state=open]")) return;
          event.preventDefault();
          onDone();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void onSubmit();
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-given">Given name</Label>
          <Input
            id="edit-given"
            value={draft.givenName}
            onChange={(e) => set("givenName", e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-family">Family name</Label>
          <Input
            id="edit-family"
            value={draft.familyName}
            onChange={(e) => set("familyName", e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="edit-display">Shown name</Label>
        <Input
          id="edit-display"
          value={draft.displayName}
          onChange={(e) => set("displayName", e.target.value)}
        />
      </div>

      <RowList
        label="Emails"
        rows={draft.emails}
        onChange={(rows) => set("emails", rows)}
        blank={() => ({ email: "", label: "", primary: draft.emails.length === 0 })}
        addLabel="Add email"
        renderRow={(row, patch, i) => (
          <>
            <Input
              type="email"
              aria-label={`Email ${i + 1}`}
              value={row.email}
              onChange={(e) => patch({ email: e.target.value })}
              className="min-w-0 flex-[2_1_10rem]"
            />
            <Input
              aria-label={`Email ${i + 1} label`}
              placeholder="Label"
              value={row.label}
              onChange={(e) => patch({ label: e.target.value })}
              className="min-w-0 flex-[1_1_5rem]"
            />
            <PrimaryToggle
              checked={row.primary}
              label={`Email ${i + 1} is primary`}
              onChange={() =>
                set(
                  "emails",
                  draft.emails.map((r, j) => ({ ...r, primary: j === i })),
                )
              }
            />
          </>
        )}
      />

      <RowList
        label="Phones"
        rows={draft.phones}
        onChange={(rows) => set("phones", rows)}
        blank={() => ({ number: "", label: "", primary: draft.phones.length === 0 })}
        addLabel="Add phone"
        renderRow={(row, patch, i) => (
          <>
            <Input
              type="tel"
              aria-label={`Phone ${i + 1}`}
              value={row.number}
              onChange={(e) => patch({ number: e.target.value })}
              className="min-w-0 flex-[2_1_10rem]"
            />
            <Input
              aria-label={`Phone ${i + 1} label`}
              placeholder="Label"
              value={row.label}
              onChange={(e) => patch({ label: e.target.value })}
              className="min-w-0 flex-[1_1_5rem]"
            />
            <PrimaryToggle
              checked={row.primary}
              label={`Phone ${i + 1} is primary`}
              onChange={() =>
                set(
                  "phones",
                  draft.phones.map((r, j) => ({ ...r, primary: j === i })),
                )
              }
            />
          </>
        )}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-location">Location</Label>
          <Input
            id="edit-location"
            value={draft.location}
            placeholder="Sydney, Australia"
            onChange={(e) => set("location", e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-timezone">Timezone</Label>
          <Input
            id="edit-timezone"
            list="edit-timezone-options"
            value={draft.timezone}
            placeholder="Australia/Sydney"
            onChange={(e) => set("timezone", e.target.value)}
          />
          <datalist id="edit-timezone-options">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>
      </div>

      <RowList
        label="Social profiles"
        rows={draft.socialProfiles}
        onChange={(rows) => set("socialProfiles", rows)}
        blank={() => ({ network: "", url: "", handle: "" })}
        addLabel="Add profile"
        renderRow={(row, patch, i) => (
          <>
            <Input
              type="url"
              aria-label={`Profile ${i + 1} URL`}
              placeholder="https://linkedin.com/in/…"
              value={row.url}
              onChange={(e) => patch({ url: e.target.value })}
              className="min-w-0 flex-[2_1_10rem]"
            />
            <Input
              aria-label={`Profile ${i + 1} network`}
              placeholder="Network"
              value={row.network}
              onChange={(e) => patch({ network: e.target.value })}
              className="min-w-0 flex-[1_1_5rem]"
            />
          </>
        )}
      />

      <div className="grid gap-1.5">
        <Label htmlFor="edit-owner">Owner</Label>
        <Select
          value={draft.ownerId ?? NO_OWNER}
          onValueChange={(value) => set("ownerId", value === NO_OWNER ? null : value)}
        >
          <SelectTrigger id="edit-owner" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_OWNER}>No owner</SelectItem>
            {owners.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="edit-tags">Tags</Label>
        <TagInput id="edit-tags" value={draft.tags} onChange={(tags) => set("tags", tags)} />
      </div>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Description</span>
        <MarkdownEditor
          label="Description"
          value={draft.description}
          onChange={(value) => set("description", value)}
          maxLength={50_000}
        />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 flex justify-end gap-2 bg-card py-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function PrimaryToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="accent-primary"
      />
      Primary
    </label>
  );
}
