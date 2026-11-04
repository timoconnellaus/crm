// Users the UI can show and pick (record owners, task assignees): every user of the deployment,
// from `user.list` (one cached query, refetched after role changes).
import { useRouteContext } from "@tanstack/react-router";
import { useOp } from "./query.ts";

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role?: "admin" | "member" | "viewer";
}

/** The input every users query shares, so they hit one cache entry. */
export const ALL_USERS_INPUT = { limit: 200, sort: { field: "name", direction: "asc" } } as const;

/** All users (first 200 by name), with the signed-in user always included. */
export function useUsers(): UserSummary[] {
  const { principal, user } = useRouteContext({ from: "/_app" });
  const query = useOp("user.list", ALL_USERS_INPUT, { staleTime: 60_000 });
  const users: UserSummary[] = (query.data?.items ?? []).map((u) => ({
    id: u.id,
    name: u.name ?? u.email ?? u.id,
    email: u.email ?? "",
    role: u.role,
  }));
  if (!users.some((u) => u.id === user.id)) {
    users.unshift({ id: user.id, name: principal.name, email: principal.email });
  }
  return users;
}

/** A display name for a user id ("Me" for the signed-in user, the id while unknown). */
export function useUserLabel(): (id: string | null | undefined) => string {
  const { user } = useRouteContext({ from: "/_app" });
  const users = useUsers();
  return (id) => {
    if (!id) return "";
    if (id === user.id) return "Me";
    return users.find((u) => u.id === id)?.name ?? id;
  };
}
