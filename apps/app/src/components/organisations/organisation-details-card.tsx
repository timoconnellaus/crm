// Organisation details card with inline edit (`e`, or the Edit button): name, domains (one
// primary), website, industry, addresses, parent organisation, owner, tags and the Markdown
// description. Saves the changed fields with organisation.update.
import type { Organisation } from "@crm/core";
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
import { Link } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useHotkey } from "#/lib/hotkeys";
import { errorMessage, useOpMutation } from "#/lib/query";
import { useUserLabel, useUsers } from "#/lib/users-adapter";
import { RowList, TagInput } from "../fields.tsx";
import { Markdown, MarkdownEditor } from "../markdown.tsx";
import { RecordPicker } from "../record-picker.tsx";
import {
  BLANK_ADDRESS,
  draftToUpdate,
  formatAddress,
  isEmptyUpdate,
  type OrganisationDraft,
  toDraft,
} from "./organisation-draft.ts";

export interface OrganisationDetailsCardProps {
  organisation: Organisation;
  /** Read-only (e.g. the organisation is in Trash). */
  readOnly?: boolean;
}

const NO_OWNER = "__none__";

export function OrganisationDetailsCard({ organisation, readOnly }: OrganisationDetailsCardProps) {
  const [editing, setEditing] = useState(false);
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
          <DetailsForm organisation={organisation} onDone={() => setEditing(false)} />
        ) : (
          <DetailsView organisation={organisation} />
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

/** An external link for a website value, adding https:// when it has no scheme. */
export function websiteHref(website: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`;
}

function DetailsView({ organisation: org }: { organisation: Organisation }) {
  const userLabel = useUserLabel();
  return (
    <dl className="grid gap-3">
      <Item label="Domains">
        {org.domains.length ? (
          <ul className="grid gap-0.5">
            {org.domains.map((d) => (
              <li key={d.domain} className="flex flex-wrap items-center gap-1.5">
                <a
                  href={`https://${d.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate hover:underline"
                >
                  {d.domain}
                </a>
                {d.primary && org.domains.length > 1 && <Badge variant="secondary">Primary</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Website">
        {org.website ? (
          <a
            href={websiteHref(org.website)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {org.website}
          </a>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Industry">{org.industry ?? <Empty />}</Item>
      <Item label="Addresses">
        {org.addresses.length ? (
          <ul className="grid gap-1">
            {org.addresses.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: addresses have no id.
              <li key={i}>
                {a.label && <span className="text-xs text-muted-foreground">{a.label} · </span>}
                {formatAddress(a)}
                {a.primary && org.addresses.length > 1 && (
                  <Badge variant="secondary" className="ml-1">
                    Primary
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Parent organisation">
        {org.parentId ? (
          <Link
            to="/organisations/$id"
            params={{ id: org.parentId }}
            className="hover:underline"
            data-testid="parent-link"
          >
            {org.parentName ?? org.parentId}
          </Link>
        ) : (
          <Empty />
        )}
      </Item>
      <Item label="Owner">{userLabel(org.ownerId) || <Empty />}</Item>
      <Item label="Tags">
        {org.tags.length ? (
          <span className="flex flex-wrap gap-1">
            {org.tags.map((tag) => (
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
        {org.description ? <Markdown>{org.description}</Markdown> : <Empty />}
      </Item>
    </dl>
  );
}

function DetailsForm({
  organisation: org,
  onDone,
}: {
  organisation: Organisation;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<OrganisationDraft>(() => toDraft(org));
  const [error, setError] = useState<string | null>(null);
  const update = useOpMutation("organisation.update");
  const users = useUsers();
  const formRef = useRef<HTMLFormElement>(null);
  const set = <K extends keyof OrganisationDraft>(key: K, value: OrganisationDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const owners = [...users];
  if (org.ownerId && !owners.some((u) => u.id === org.ownerId)) {
    owners.push({ id: org.ownerId, name: org.ownerId, email: "" });
  }

  async function onSubmit(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    const input = draftToUpdate(org, draft);
    if (isEmptyUpdate(input)) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync(input);
      toast.success("Saved");
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
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
          if ((event.target as HTMLElement).closest("[data-state=open]")) return;
          event.preventDefault();
          onDone();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void onSubmit();
        }
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="edit-org-name">Name</Label>
        <Input
          id="edit-org-name"
          value={draft.name}
          required
          onChange={(e) => set("name", e.target.value)}
        />
      </div>

      <RowList
        label="Domains"
        rows={draft.domains}
        onChange={(rows) => set("domains", rows)}
        blank={() => ({ domain: "", primary: draft.domains.length === 0 })}
        addLabel="Add domain"
        renderRow={(row, patch, i) => (
          <>
            <Input
              aria-label={`Domain ${i + 1}`}
              placeholder="acme.com"
              value={row.domain}
              onChange={(e) => patch({ domain: e.target.value })}
              className="min-w-0 flex-[2_1_10rem]"
            />
            <PrimaryToggle
              checked={row.primary}
              label={`Domain ${i + 1} is primary`}
              onChange={() =>
                set(
                  "domains",
                  draft.domains.map((r, j) => ({ ...r, primary: j === i })),
                )
              }
            />
          </>
        )}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-org-website">Website</Label>
          <Input
            id="edit-org-website"
            value={draft.website}
            placeholder="https://acme.com"
            onChange={(e) => set("website", e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-org-industry">Industry</Label>
          <Input
            id="edit-org-industry"
            value={draft.industry}
            onChange={(e) => set("industry", e.target.value)}
          />
        </div>
      </div>

      <RowList
        label="Addresses"
        rows={draft.addresses}
        onChange={(rows) => set("addresses", rows)}
        blank={() => ({ ...BLANK_ADDRESS, primary: draft.addresses.length === 0 })}
        addLabel="Add address"
        renderRow={(row, patch, i) => (
          <div className="grid w-full gap-2 rounded-md border p-2 sm:grid-cols-2">
            <Input
              aria-label={`Address ${i + 1} label`}
              placeholder="Label (HQ, billing)"
              value={row.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} line 1`}
              placeholder="Street"
              value={row.line1}
              onChange={(e) => patch({ line1: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} line 2`}
              placeholder="Suite, floor"
              value={row.line2}
              onChange={(e) => patch({ line2: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} city`}
              placeholder="City"
              value={row.city}
              onChange={(e) => patch({ city: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} region`}
              placeholder="State or region"
              value={row.region}
              onChange={(e) => patch({ region: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} postcode`}
              placeholder="Postcode"
              value={row.postalCode}
              onChange={(e) => patch({ postalCode: e.target.value })}
            />
            <Input
              aria-label={`Address ${i + 1} country`}
              placeholder="Country (AU)"
              maxLength={2}
              value={row.country}
              onChange={(e) => patch({ country: e.target.value })}
            />
            <PrimaryToggle
              checked={row.primary}
              label={`Address ${i + 1} is primary`}
              onChange={() =>
                set(
                  "addresses",
                  draft.addresses.map((r, j) => ({ ...r, primary: j === i })),
                )
              }
            />
          </div>
        )}
      />

      <div className="grid gap-1.5">
        <Label htmlFor="edit-org-parent">Parent organisation</Label>
        <RecordPicker
          id="edit-org-parent"
          object="organisation"
          label="Parent organisation"
          placeholder="No parent"
          value={draft.parent}
          exclude={[org.id]}
          onChange={(parent) => set("parent", parent)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="edit-org-owner">Owner</Label>
        <Select
          value={draft.ownerId ?? NO_OWNER}
          onValueChange={(value) => set("ownerId", value === NO_OWNER ? null : value)}
        >
          <SelectTrigger id="edit-org-owner" className="w-full">
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
        <Label htmlFor="edit-org-tags">Tags</Label>
        <TagInput id="edit-org-tags" value={draft.tags} onChange={(tags) => set("tags", tags)} />
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
      <div className="flex justify-end gap-2">
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
