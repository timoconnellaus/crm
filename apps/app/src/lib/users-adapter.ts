// Users the UI can show and pick (record owners, task assignees), behind an adapter.
//
// TODO(stage-1-wire): replace with `user.list` → [{ id, name, email, role }] (cached, all users
// of the deployment). Until then the only user the UI knows is the signed-in one, from the
// session, so owners can be set to "me" or cleared, and other owners show as their id.
import { useRouteContext } from "@tanstack/react-router";

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

/** Users the current screen can offer as owners. */
export function useUsers(): UserSummary[] {
  const { principal, user } = useRouteContext({ from: "/_app" });
  return [{ id: user.id, name: principal.name, email: principal.email }];
}

/** A display name for a user id ("Me" for the signed-in user). */
export function useUserLabel(): (id: string | null | undefined) => string {
  const { user } = useRouteContext({ from: "/_app" });
  const users = useUsers();
  return (id) => {
    if (!id) return "";
    if (id === user.id) return "Me";
    return users.find((u) => u.id === id)?.name ?? id;
  };
}
