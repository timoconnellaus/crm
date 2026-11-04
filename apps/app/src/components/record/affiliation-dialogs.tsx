// Affiliation writes from a person's Organisations card: add one (affiliation.create), end one
// (affiliation.end), and Change job (person.changeJob: ends the primary job, starts a new primary
// one and posts a Job change on the timelines).
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
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";
import type { AffiliationItem } from "./adapters.ts";
import { OrganisationPicker, type PickedOrganisation } from "./organisation-picker.tsx";
import { localToday } from "./tasks.tsx";

const AFFILIATION_READS = ["affiliation.", "person.", "organisation."];

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  onSubmit,
  error,
  pending,
  submitLabel,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  onSubmit: (form: FormData) => void;
  error: string | null;
  pending: boolean;
  submitLabel: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          aria-label={label}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onSubmit(new FormData(event.currentTarget));
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Resets an error and a picked organisation whenever the dialog opens. */
function useDialogState(open: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [organisation, setOrganisation] = useState<PickedOrganisation | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setOrganisation(null);
    }
  }, [open]);
  // Picking one clears a "Pick an organisation" error left by an earlier submit.
  const pick = useCallback((value: PickedOrganisation | null) => {
    setOrganisation(value);
    if (value) setError(null);
  }, []);
  return { error, setError, organisation, pick };
}

export interface AffiliationDialogProps {
  personId: string;
  personName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddAffiliationDialog({
  personId,
  personName,
  open,
  onOpenChange,
}: AffiliationDialogProps) {
  const state = useDialogState(open);
  const create = useOpMutation("affiliation.create", { invalidates: AFFILIATION_READS });

  async function submit(form: FormData) {
    if (!state.organisation) {
      state.setError("Pick an organisation");
      return;
    }
    try {
      await create.mutateAsync({
        personId,
        organisationId: state.organisation.id,
        title: text(form, "title") || null,
        role: text(form, "role") || null,
        startedOn: text(form, "startedOn") || null,
      });
      onOpenChange(false);
      toast.success(`Added ${state.organisation.name}`);
    } catch (error) {
      state.setError(errorMessage(error));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add organisation"
      description={`Link ${personName} to an organisation they work with.`}
      label="Add organisation"
      onSubmit={(form) => void submit(form)}
      error={state.error}
      pending={create.isPending}
      submitLabel="Add"
    >
      <Field id="aff-org" label="Organisation">
        <OrganisationPicker
          id="aff-org"
          value={state.organisation}
          onChange={state.pick}
          autoFocus
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="aff-title" label="Job title">
          <Input id="aff-title" name="title" maxLength={200} />
        </Field>
        <Field id="aff-role" label="Role">
          <Input id="aff-role" name="role" maxLength={200} placeholder="e.g. Decision maker" />
        </Field>
      </div>
      <Field id="aff-start" label="Started on">
        <Input id="aff-start" name="startedOn" type="date" />
      </Field>
    </FormDialog>
  );
}

export interface ChangeJobDialogProps extends AffiliationDialogProps {
  /** The job that ends (the person's primary affiliation), if any. */
  current: AffiliationItem | null;
}

export function ChangeJobDialog({
  personId,
  personName,
  current,
  open,
  onOpenChange,
}: ChangeJobDialogProps) {
  const state = useDialogState(open);
  const changeJob = useOpMutation("person.changeJob", { invalidates: AFFILIATION_READS });

  async function submit(form: FormData) {
    if (!state.organisation) {
      state.setError("Pick the new organisation");
      return;
    }
    const previousEndedOn = text(form, "previousEndedOn");
    try {
      await changeJob.mutateAsync({
        personId,
        organisationId: state.organisation.id,
        title: text(form, "title") || null,
        role: text(form, "role") || null,
        startedOn: text(form, "startedOn") || localToday(),
        ...(previousEndedOn ? { previousEndedOn } : {}),
      });
      onOpenChange(false);
      toast.success(`${personName} moved to ${state.organisation.name}`);
    } catch (error) {
      state.setError(errorMessage(error));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change job"
      description={
        current
          ? `Ends ${personName}'s job at ${current.organisationName ?? "their organisation"} and starts the new one. Both stay in their job history.`
          : `Starts ${personName}'s new job.`
      }
      label="Change job"
      onSubmit={(form) => void submit(form)}
      error={state.error}
      pending={changeJob.isPending}
      submitLabel="Change job"
    >
      <Field id="job-org" label="New organisation">
        <OrganisationPicker
          id="job-org"
          value={state.organisation}
          onChange={state.pick}
          autoFocus
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="job-title" label="New job title">
          <Input id="job-title" name="title" maxLength={200} />
        </Field>
        <Field id="job-role" label="Role">
          <Input id="job-role" name="role" maxLength={200} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="job-start" label="Starts on">
          <Input id="job-start" name="startedOn" type="date" defaultValue={localToday()} />
        </Field>
        {current && (
          <Field id="job-end" label="Previous job ended">
            <Input id="job-end" name="previousEndedOn" type="date" />
          </Field>
        )}
      </div>
    </FormDialog>
  );
}

export function EndAffiliationDialog({
  affiliation,
  onOpenChange,
}: {
  affiliation: AffiliationItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const end = useOpMutation("affiliation.end", { invalidates: AFFILIATION_READS });
  const open = Boolean(affiliation);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function submit(form: FormData) {
    if (!affiliation) return;
    try {
      await end.mutateAsync({ id: affiliation.id, endedOn: text(form, "endedOn") || localToday() });
      onOpenChange(false);
      toast.success(`Ended ${affiliation.organisationName ?? "affiliation"}`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="End affiliation"
      description={`It moves to the job history${affiliation?.organisationName ? ` for ${affiliation.organisationName}` : ""}.`}
      label="End affiliation"
      onSubmit={(form) => void submit(form)}
      error={error}
      pending={end.isPending}
      submitLabel="End"
    >
      <Field id="end-on" label="Ended on">
        <Input id="end-on" name="endedOn" type="date" defaultValue={localToday()} />
      </Field>
    </FormDialog>
  );
}
