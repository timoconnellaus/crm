// Suggested contacts (stage 6a, ADR 0052): external senders people have emailed with at least
// twice, grouped by their organisation's domain, for a one-click add (nothing is created
// automatically), and job changes suggested from email (bounces, new signatures, a known person
// writing from a new domain), applied with person.changeJob on confirmation.
//
// Both lists are bounded by their operations (at most 100 domains, 200 job changes per page), so
// they render as plain lists rather than virtualised feeds.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@relationship-os/ui/components/dialog";
import { Input } from "@relationship-os/ui/components/input";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BriefcaseIcon, Building2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "#/components/empty-state";
import { PageCount, PageLayout } from "#/components/layout/page-layout";
import {
  OrganisationPicker,
  type PickedOrganisation,
} from "#/components/record/organisation-picker";
import { jobChangeEvidence } from "#/components/suggestions/evidence";
import { formatDateTime, formatRelative } from "#/lib/format";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/suggested-contacts")({
  component: SuggestedContactsPage,
});

type Group = CoreOutput<"suggestedContact.list">["groups"][number];
type JobChange = CoreOutput<"jobChange.list">["items"][number];

const WRITES = ["suggestedContact.", "jobChange.", "person.", "organisation.", "affiliation."];

function SuggestedContactsPage() {
  const list = useOp("suggestedContact.list", { limit: 100 });
  const jobs = useOp("jobChange.list", { limit: 200 });
  const contacts = list.data?.groups.reduce((n, g) => n + g.contacts.length, 0);
  return (
    <PageLayout
      title="Suggested contacts"
      count={
        <PageCount
          value={list.data ? (contacts ?? 0) + (jobs.data?.items.length ?? 0) : undefined}
          isPending={list.isPending}
          noun="suggestions"
        />
      }
      width="lg"
      description="People you email who aren't in the CRM yet, and job changes spotted in email. Nothing is added until you say so."
    >
      <section className="grid min-w-0 gap-3" aria-labelledby="senders">
        <h2 id="senders" className="text-lg font-semibold">
          New contacts
        </h2>
        {list.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : list.isError ? (
          <ErrorState
            title="Could not load suggested contacts"
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : list.data.groups.length === 0 ? (
          <EmptyState
            icon={UserPlusIcon}
            title="No suggested contacts"
            description="External people you've emailed with at least twice show up here once your mailbox syncs (Settings → Integrations)."
          />
        ) : (
          <ul className="grid gap-3" aria-label="Suggested contacts by domain">
            {list.data.groups.map((group) => (
              <li key={group.domain}>
                <DomainGroup group={group} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid min-w-0 gap-3" aria-labelledby="job-changes">
        <h2 id="job-changes" className="text-lg font-semibold">
          Job changes
        </h2>
        {jobs.isPending ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : jobs.isError ? (
          <ErrorState
            title="Could not load job changes"
            error={jobs.error}
            onRetry={() => void jobs.refetch()}
          />
        ) : jobs.data.items.length === 0 ? (
          <EmptyState
            icon={BriefcaseIcon}
            title="No job changes spotted"
            description="Bounces, new signatures and known people writing from a new domain suggest a job change here."
          />
        ) : (
          <ul className="grid divide-y rounded-xl border" aria-label="Suggested job changes">
            {jobs.data.items.map((item) => (
              <JobChangeRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </PageLayout>
  );
}

function DomainGroup({ group }: { group: Group }) {
  const headingId = useId();
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [createOrg, setCreateOrg] = useState(true);
  const add = useOpMutation("suggestedContact.add", { invalidates: WRITES });
  const dismiss = useOpMutation("suggestedContact.dismiss", { invalidates: WRITES });
  const selected = group.contacts.filter((c) => !unchecked.has(c.email));
  const createId = `${headingId}-create`;

  async function addSelected() {
    try {
      const out = await add.mutateAsync({
        emails: selected.map((c) => c.email),
        ...(!group.organisation && createOrg ? { createOrganisation: true } : {}),
      });
      toast.success(
        `Added ${out.added.length} ${out.added.length === 1 ? "person" : "people"} from ${group.domain}`,
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function dismissWith(input: { emails: string[] } | { domain: string }, what: string) {
    try {
      await dismiss.mutateAsync(input);
      toast.success(`Dismissed ${what}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <section
      className="overflow-hidden rounded-xl border"
      aria-labelledby={headingId}
      data-testid="suggested-domain"
      data-domain={group.domain}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-3.5 py-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h3 id={headingId} className="truncate font-semibold">
            {group.domain}
          </h3>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <Building2Icon className="size-3.5" aria-hidden />
            {group.organisation ? (
              <Link
                to="/organisations/$id"
                params={{ id: group.organisation.id }}
                className="underline-offset-2 hover:underline"
              >
                {group.organisation.name}
              </Link>
            ) : (
              <span>No organisation</span>
            )}
            <span aria-hidden>·</span>
            <span>
              {group.messageCount} message{group.messageCount === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={dismiss.isPending}
          onClick={() => void dismissWith({ domain: group.domain }, group.domain)}
          aria-label={`Dismiss everyone at ${group.domain}`}
        >
          <XIcon />
          Dismiss domain
        </Button>
      </header>
      <ul className="divide-y" aria-label={`Contacts at ${group.domain}`}>
        {group.contacts.map((contact) => {
          const id = `${headingId}-${contact.email}`;
          const label = contact.name ?? contact.email;
          return (
            <li
              key={contact.email}
              className="flex min-w-0 items-center gap-3 px-3.5 py-2.5 text-sm"
              data-testid="suggested-contact"
              data-email={contact.email}
            >
              <Checkbox
                id={id}
                checked={!unchecked.has(contact.email)}
                onCheckedChange={(checked) =>
                  setUnchecked((current) => {
                    const next = new Set(current);
                    if (checked === true) next.delete(contact.email);
                    else next.add(contact.email);
                    return next;
                  })
                }
                aria-label={`Select ${label}`}
              />
              <label htmlFor={id} className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate font-medium">{label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {contact.name ? `${contact.email} · ` : ""}
                  {contact.messageCount} message{contact.messageCount === 1 ? "" : "s"} · last{" "}
                  <time dateTime={contact.lastSeenAt} title={formatDateTime(contact.lastSeenAt)}>
                    {formatRelative(contact.lastSeenAt)}
                  </time>
                </span>
              </label>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={dismiss.isPending}
                aria-label={`Dismiss ${label}`}
                onClick={() => void dismissWith({ emails: [contact.email] }, label)}
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ul>
      <footer className="flex flex-wrap items-center gap-3 border-t px-3.5 py-3">
        {!group.organisation && (
          <div className="flex min-w-0 items-center gap-2">
            <Checkbox
              id={createId}
              checked={createOrg}
              onCheckedChange={(checked) => setCreateOrg(checked === true)}
            />
            <Label htmlFor={createId} className="text-sm font-normal">
              Create an organisation for {group.domain}
            </Label>
          </div>
        )}
        <Button
          size="sm"
          className="ml-auto"
          disabled={!selected.length || add.isPending}
          onClick={() => void addSelected()}
        >
          <UserPlusIcon />
          {add.isPending
            ? "Adding…"
            : selected.length === group.contacts.length && selected.length > 1
              ? `Add all ${selected.length}`
              : `Add selected (${selected.length})`}
        </Button>
      </footer>
    </section>
  );
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function JobChangeRow({ item }: { item: JobChange }) {
  const [applying, setApplying] = useState(false);
  const dismiss = useOpMutation("jobChange.dismiss", { invalidates: WRITES });
  const evidence = jobChangeEvidence(item);
  const name = item.personName ?? "Someone";

  async function onDismiss() {
    try {
      await dismiss.mutateAsync({ id: item.id });
      toast.success("Dismissed");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <li
      className="grid min-w-0 gap-2 px-3.5 py-3 text-sm"
      data-testid="job-change"
      data-job-change={item.id}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              to="/people/$id"
              params={{ id: item.personId }}
              className="font-semibold underline-offset-2 hover:underline"
            >
              {name}
            </Link>
            <Badge variant="outline" className="rounded-sm px-1.5 font-normal">
              {item.signal === "bounce"
                ? "Bounce"
                : item.signal === "signature"
                  ? "New signature"
                  : "New domain"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {item.currentOrganisation ? `Now at ${item.currentOrganisation}. ` : ""}
            {evidence.headline}
          </p>
          {evidence.detail && (
            <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2 font-sans text-xs whitespace-pre-wrap">
              {evidence.detail}
            </pre>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={dismiss.isPending}
            onClick={() => void onDismiss()}
            aria-label={`Dismiss job change for ${name}`}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            onClick={() => setApplying(true)}
            aria-label={`Apply job change for ${name}`}
          >
            Apply
          </Button>
        </div>
      </div>
      <ApplyJobChangeDialog item={item} open={applying} onOpenChange={setApplying} />
    </li>
  );
}

function ApplyJobChangeDialog({
  item,
  open,
  onOpenChange,
}: {
  item: JobChange;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const proposedOrg = str(item.proposal.organisationId);
  const proposedName = str(item.proposal.organisationName);
  const [organisation, setOrganisation] = useState<PickedOrganisation | null>(null);
  const [title, setTitle] = useState(str(item.proposal.title) ?? "");
  const apply = useOpMutation("jobChange.apply", { invalidates: WRITES });
  const base = useId();
  const needsOrg = !proposedOrg;
  const name = item.personName ?? "this person";
  const hint = useMemo(
    () => proposedName ?? str(item.proposal.domain) ?? null,
    [proposedName, item.proposal.domain],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsOrg && !organisation) {
      toast.error("Choose the organisation they moved to");
      return;
    }
    try {
      await apply.mutateAsync({
        id: item.id,
        ...(organisation ? { organisationId: organisation.id } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onOpenChange(false);
      toast.success(`Updated ${name}'s job`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply job change</DialogTitle>
          <DialogDescription>
            Ends {name}'s current job and adds the new one. It goes through the approval policy as
            you.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${base}-org`}>
              New organisation{needsOrg ? "" : " (optional, to override the suggestion)"}
            </Label>
            <OrganisationPicker
              id={`${base}-org`}
              value={organisation}
              onChange={setOrganisation}
            />
            {hint && !organisation && (
              <p className="text-xs text-muted-foreground">Suggested: {hint}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${base}-title`}>Job title (optional)</Label>
            <Input
              id={`${base}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={apply.isPending || (needsOrg && !organisation)}>
              {apply.isPending ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
