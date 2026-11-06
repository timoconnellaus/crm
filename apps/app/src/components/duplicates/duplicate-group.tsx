// One group of likely duplicates on the Duplicates page (stage 16, ADR 0247): the records side by
// side with the fields that differ marked, why they matched, and who would remain. There is no
// score: the reasons are the rules.
import type { CoreOutput } from "@relationship-os/core";
import { Badge } from "@relationship-os/ui/components/badge";
import { Button } from "@relationship-os/ui/components/button";
import { Checkbox } from "@relationship-os/ui/components/checkbox";
import { Label } from "@relationship-os/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@relationship-os/ui/components/radio-group";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

export type DuplicateGroup = CoreOutput<"duplicate.list">["groups"][number];
type Member = DuplicateGroup["members"][number];

function groupTitle(group: DuplicateGroup): string {
  const [first, ...rest] = group.members.map((m) => m.title);
  if (rest.length === 1) return `${first} and ${rest[0]}`;
  return `${first} and ${rest.length} others`;
}

function MemberCard({
  object,
  member,
  group,
  isSurvivor,
}: {
  object: "person" | "organisation";
  member: Member;
  group: DuplicateGroup;
  isSurvivor: boolean;
}) {
  const radioId = useId();
  const to = object === "person" ? ("/people/$id" as const) : ("/organisations/$id" as const);
  return (
    <div
      className="grid min-w-0 content-start gap-2 rounded-lg border p-3 data-[survivor=true]:border-primary"
      data-survivor={isSurvivor}
    >
      <div className="flex items-center gap-2">
        <RadioGroupItem value={member.id} id={radioId} aria-label={`Keep ${member.title}`} />
        <Label htmlFor={radioId} className="font-normal text-muted-foreground">
          {isSurvivor ? "Keep this one" : "Merge into the other"}
        </Label>
      </div>
      <Link
        to={to}
        params={{ id: member.id }}
        className="truncate font-medium underline-offset-4 hover:underline"
      >
        {member.title}
      </Link>
      <dl className="grid gap-1 text-sm">
        {member.fields
          .filter((f) => f.value !== null && f.value !== "")
          .map((f) => (
            <div key={f.field} className="grid min-w-0 grid-cols-[6rem_1fr] gap-2">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd
                className="min-w-0 break-words data-[differs=true]:font-medium"
                data-differs={group.differingFields.includes(f.field)}
              >
                {f.value}
              </dd>
            </div>
          ))}
        <div className="grid grid-cols-[6rem_1fr] gap-2">
          <dt className="text-muted-foreground">Activities</dt>
          <dd>{member.activityCount}</dd>
        </div>
      </dl>
    </div>
  );
}

export function DuplicateGroupCard({
  object,
  group,
  selected,
  survivorId,
  busy,
  onSelect,
  onSurvivor,
  onMerge,
  onDismiss,
}: {
  object: "person" | "organisation";
  group: DuplicateGroup;
  selected: boolean;
  survivorId: string;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  onSurvivor: (id: string) => void;
  onMerge: () => void;
  onDismiss: (ids: string[]) => void;
}) {
  const headingId = useId();
  const checkId = useId();
  const title = groupTitle(group);
  const survivor = group.members.find((m) => m.id === survivorId);
  const titleOf = (id: string) => group.members.find((m) => m.id === id)?.title ?? id;
  const many = group.members.length > 2;
  return (
    <section
      aria-labelledby={headingId}
      className="grid min-w-0 gap-3 rounded-xl border p-3"
      data-testid="duplicate-group"
    >
      <header className="flex min-w-0 items-start gap-2">
        <Checkbox
          id={checkId}
          className="mt-0.5"
          checked={selected}
          onCheckedChange={(next) => onSelect(next === true)}
          aria-label={`Select ${title} for bulk merge`}
        />
        <div className="grid min-w-0 flex-1 gap-1">
          <h3 id={headingId} className="min-w-0 font-medium break-words">
            {title}
          </h3>
          <ul className="flex flex-wrap gap-1" aria-label="Why these match">
            {group.reasons.map((reason) => (
              <li key={reason}>
                <Badge variant="secondary" className="h-auto whitespace-normal">
                  {reason}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </header>
      <RadioGroup
        value={survivorId}
        onValueChange={onSurvivor}
        aria-label="Which record to keep"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {group.members.map((member) => (
          <MemberCard
            key={member.id}
            object={object}
            member={member}
            group={group}
            isSurvivor={member.id === survivorId}
          />
        ))}
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        {survivorId === group.survivorId
          ? `Suggested: keep ${survivor?.title}. ${group.survivorReason}.`
          : `You chose to keep ${survivor?.title}.`}
      </p>
      {many && (
        <ul className="grid gap-1 text-sm" aria-label="Pairs in this group">
          {group.pairs.map((pair) => (
            <li key={`${pair.aId}-${pair.bId}`} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                {titleOf(pair.aId)} and {titleOf(pair.bId)}: {pair.reasons.join(". ")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDismiss([pair.aId, pair.bId])}
              >
                Not duplicates
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onDismiss(group.members.map((m) => m.id))}
        >
          {many ? "Dismiss all in this group" : "Not duplicates"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onMerge}>
          Merge…
        </Button>
      </div>
    </section>
  );
}
