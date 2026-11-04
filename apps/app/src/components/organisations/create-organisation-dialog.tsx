// "New organisation" dialog (`c` on Organisations, or from the command palette). Creates via
// organisation.create and opens the new record.
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
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";

export interface CreateOrganisationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the new record after creating it (default true). */
  openAfterCreate?: boolean;
}

export function CreateOrganisationDialog({
  open,
  onOpenChange,
  openAfterCreate = true,
}: CreateOrganisationDialogProps) {
  const navigate = useNavigate();
  const create = useOpMutation("organisation.create");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const domains = text("domains")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((domain, i) => ({ domain, primary: i === 0 }));
    try {
      const organisation = await create.mutateAsync({
        name: text("name"),
        ...(domains.length ? { domains } : {}),
        ...(text("industry") ? { industry: text("industry") } : {}),
      });
      onOpenChange(false);
      toast.success(`Created ${organisation.name}`);
      if (openAfterCreate) {
        navigate({ to: "/organisations/$id", params: { id: organisation.id } });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="grid gap-4" aria-label="New organisation">
          <DialogHeader>
            <DialogTitle>New organisation</DialogTitle>
            <DialogDescription>
              Domains link people to the organisation by their email address.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-org-name">Name</Label>
            <Input id="new-org-name" name="name" maxLength={200} required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-org-domains">Domains</Label>
            <Input
              id="new-org-domains"
              name="domains"
              placeholder="acme.com, acme.co.uk"
              maxLength={2000}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-org-industry">Industry</Label>
            <Input id="new-org-industry" name="industry" maxLength={100} />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create organisation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
