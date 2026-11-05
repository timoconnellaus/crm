// Settings → Users and roles (admin): every user (user.list) and their role, changed with
// user.updateRole. The last admin cannot be demoted; that refusal is shown inline on the row.

import { Avatar, AvatarFallback, AvatarImage } from "@relationship-os/ui/components/avatar";
import { Badge } from "@relationship-os/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@relationship-os/ui/components/select";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { LockIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { formatDate, initials } from "#/lib/format";
import { OperationCallError } from "#/lib/operations";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";
import { ALL_USERS_INPUT } from "#/lib/users-adapter";

export const Route = createFileRoute("/_app/settings/users")({ component: UsersPage });

type Role = "admin" | "member" | "viewer";

const ROLE_COPY: Record<Role, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Everything, including users, policy and erase" },
  member: { label: "Member", description: "Read and write records" },
  viewer: { label: "Viewer", description: "Read only" },
};

/** A friendlier line for the refusals user.updateRole can give. */
function roleError(error: unknown): string {
  if (error instanceof OperationCallError) {
    if (error.code === "conflict") {
      return "This is the last admin. Make someone else an admin first, then change this role.";
    }
    if (error.code === "forbidden") return "Only admins can change roles.";
  }
  return errorMessage(error);
}

function UsersPage() {
  const { isAdmin, user: me } = Route.useRouteContext();
  const users = useOp("user.list", ALL_USERS_INPUT);
  const update = useOpMutation("user.updateRole");
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function changeRole(id: string, name: string, role: Role) {
    setErrors(({ [id]: _, ...rest }) => rest);
    try {
      const result = await update.mutateAsync({ id, role });
      toast.success(`${name} is now ${ROLE_COPY[result.role].label.toLowerCase()}`);
    } catch (error) {
      const message = roleError(error);
      setErrors((current) => ({ ...current, [id]: message }));
      toast.error(message);
    }
  }

  return (
    <PageLayout
      title="Users and roles"
      width="md"
      back={{ to: "/settings", label: "Settings" }}
      description="Everyone who can sign in. People join by signing in; admins set their role here."
    >
      {!isAdmin && (
        <p className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <LockIcon className="size-4" aria-hidden />
          Only admins can change roles.
        </p>
      )}
      {users.isPending ? (
        <Skeleton className="h-40" />
      ) : users.isError ? (
        <ErrorState
          title="Could not load users"
          error={users.error}
          onRetry={() => void users.refetch()}
        />
      ) : (
        <ul className="grid divide-y rounded-md border" aria-label="Users">
          {users.data.items.map((u) => {
            const name = u.name ?? u.email ?? u.id;
            const role = (u.role ?? "member") as Role;
            return (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
                data-testid="user-row"
                data-email={u.email}
              >
                <Avatar className="size-8">
                  {u.image && <AvatarImage src={u.image} alt="" />}
                  <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
                </Avatar>
                <div className="grid min-w-0 flex-1">
                  <span className="flex items-center gap-2 truncate font-medium">
                    {name}
                    {u.id === me.id && <Badge variant="secondary">You</Badge>}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {u.email}
                    {u.createdAt ? ` · joined ${formatDate(u.createdAt)}` : ""}
                  </span>
                  {errors[u.id] && (
                    <span className="text-xs text-destructive" role="alert">
                      {errors[u.id]}
                    </span>
                  )}
                </div>
                {isAdmin ? (
                  <Select
                    value={role}
                    onValueChange={(next) => void changeRole(u.id, name, next as Role)}
                    disabled={update.isPending}
                  >
                    <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_COPY) as Role[]).map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_COPY[r].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{ROLE_COPY[role].label}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[6rem_1fr]">
        {(Object.keys(ROLE_COPY) as Role[]).map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium">{ROLE_COPY[r].label}</dt>
            <dd>{ROLE_COPY[r].description}</dd>
          </div>
        ))}
      </dl>
    </PageLayout>
  );
}
