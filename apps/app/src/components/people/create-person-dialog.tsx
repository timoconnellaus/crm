// "New person" dialog (`c` on People, or from the command palette). Creates via person.create
// and opens the new record.
import { Button } from "@relationship-os/ui/components/button";
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
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { errorMessage, useOpMutation } from "#/lib/query";

export interface CreatePersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the new record after creating it (default true). */
  openAfterCreate?: boolean;
}

export function CreatePersonDialog({
  open,
  onOpenChange,
  openAfterCreate = true,
}: CreatePersonDialogProps) {
  const navigate = useNavigate();
  const create = useOpMutation("person.create");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const email = text("email");
    const phone = text("phone");
    try {
      const person = await create.mutateAsync({
        givenName: text("givenName") || null,
        familyName: text("familyName") || null,
        ...(email ? { emails: [{ email }] } : {}),
        ...(phone ? { phones: [{ number: phone }] } : {}),
      });
      onOpenChange(false);
      toast.success(`Created ${person.displayName}`);
      if (openAfterCreate) navigate({ to: "/people/$id", params: { id: person.id } });
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
        <form onSubmit={onSubmit} className="grid gap-4" aria-label="New person">
          <DialogHeader>
            <DialogTitle>New person</DialogTitle>
            <DialogDescription>A name or an email is enough to start.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-given-name">Given name</Label>
              <Input id="new-given-name" name="givenName" maxLength={100} autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-family-name">Family name</Label>
              <Input id="new-family-name" name="familyName" maxLength={100} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-email">Email</Label>
            <Input id="new-email" name="email" type="email" maxLength={320} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-phone">Phone</Label>
            <Input id="new-phone" name="phone" type="tel" maxLength={50} />
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
              {create.isPending ? "Creating…" : "Create person"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
