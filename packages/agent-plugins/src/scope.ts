// Scopes (ADR 0347): who a plugin is installed for, who may change it, and which copy a person gets
// when more than one applies. Pure: the host passes the installs and the viewer.
export const PLUGIN_SCOPE_KINDS = ["personal", "team", "role", "org"] as const;
export type PluginScopeKind = (typeof PLUGIN_SCOPE_KINDS)[number];

export interface PluginViewer {
  userId: string;
  role: string;
  isAdmin: boolean;
}

export interface ScopedInstall {
  id: string;
  pluginId: string;
  scope: PluginScopeKind;
  /** The person, for `personal`. */
  ownerUserId: string | null;
  /** The role, for `role`. */
  role: string | null;
  /** The members, for `team`. */
  members: readonly string[];
  locked: boolean;
}

/** Does this install apply to this person at all? */
export function appliesTo(install: ScopedInstall, viewer: PluginViewer): boolean {
  switch (install.scope) {
    case "personal":
      return install.ownerUserId === viewer.userId;
    case "team":
      return install.members.includes(viewer.userId);
    case "role":
      return install.role === viewer.role;
    case "org":
      return true;
  }
}

const RANK: Record<PluginScopeKind, number> = { personal: 0, team: 1, role: 2, org: 3 };

/**
 * The installs that take effect for a person: the nearest one of each plugin. Their own copy comes
 * before a team's, a team's before a role's, and a role's before the org's, so "make my own copy"
 * shadows a locked plugin without changing it for anyone else.
 */
export function effectiveInstalls<T extends ScopedInstall>(
  installs: readonly T[],
  viewer: PluginViewer,
): T[] {
  const nearest = new Map<string, T>();
  for (const install of installs) {
    if (!appliesTo(install, viewer)) continue;
    const held = nearest.get(install.pluginId);
    if (!held || RANK[install.scope] < RANK[held.scope]) nearest.set(install.pluginId, install);
  }
  return [...nearest.values()];
}

/** May this person change this copy? Locked and shared copies are for admins alone. */
export function canEdit(install: ScopedInstall, viewer: PluginViewer): boolean {
  if (install.scope === "personal") return install.ownerUserId === viewer.userId;
  return viewer.isAdmin;
}

/** May this person install at this scope? Anyone for themselves; an admin for anyone else. */
export function canInstall(scope: PluginScopeKind, viewer: PluginViewer): boolean {
  return scope === "personal" || viewer.isAdmin;
}

/** Locked installs stay one copy for everyone; an unlocked one hands each member their own. */
export function membersGetCopies(install: Pick<ScopedInstall, "scope" | "locked">): boolean {
  return !install.locked && (install.scope === "team" || install.scope === "role");
}
