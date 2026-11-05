# Stage 14: Teams and permissions

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Data,
Identity, MCP, Dashboards), [`CONTEXT.md`](../../CONTEXT.md),
[`docs/research/cloudflare-cost-audit.md`](../research/cloudflare-cost-audit.md), ADRs
[0003](../adr/0003-operations-registry.md), [0008](../adr/0008-identity-adapters.md),
[0015](../adr/0015-core-data-model.md), [0018](../adr/0018-invocation-pipeline-and-gate.md),
[0020](../adr/0020-query-sql-validator-and-csv-import.md), [0021](../adr/0021-mcp-surface.md),
[0057](../adr/0057-dashboards-params-cache-and-click-through.md),
[0112](../adr/0112-email-calendar-sync-service.md), [0153](../adr/0153-ai-summaries.md),
[0155](../adr/0155-hybrid-search-similar-records-and-retrieval.md),
[0170](../adr/0170-automation-run-as-bindings.md), [0200](../adr/0200-in-app-assistant-build.md),
[0211](../adr/0211-plans-and-entitlements.md), and this stage's
[0244](../adr/0244-visibility-enforced-at-one-seam.md) and
[0245](../adr/0245-roles-teams-and-identity-seams.md).

Builds on every stage so far. It changes every read path, so it is split into **14a** (roles,
teams, invites, visibility) and **14b** (SSO and SCIM).

## Goal

A sales team of five, or fifty, can work in one CRM where everyone sees everything by default, and
an admin can restrict an object so people see only their own records, or their team's. Managers see
their team's records. Read-only users can look but not change. The rules hold everywhere: lists,
record pages, search, the assistant, MCP clients, dashboards, `query.sql`, exports and summaries,
enforced in one place so a new feature cannot forget them. Later, companies sign in with their own
identity provider and provision users with SCIM.

## What exists today (from the code)

- **Roles:** `admin`, `member`, `viewer` (`ROLES` in `packages/core/src/principals.ts`), stored in
  `core_user.role` with a `CHECK` constraint (migration 0002). `core_user` is Better Auth's own user
  table. Permissions are object-agnostic: `records:read`, `records:write`, `records:erase`,
  `audit:read`, `users:manage`, `policy:manage`, `extensions:manage`, `integrations:manage`,
  `settings:manage` (`ROLE_PERMISSIONS`). No teams, no groups, no invites (Better Auth lets the first
  user in, and later users only with `AUTH_ALLOW_SIGNUP=true`).
- **Owners:** `core_person.owner_id` and `core_organisation.owner_id`, indexed. Tasks have
  `assignee_id`; activities have `author_user_id` and `private_to`. Extension tables get no owner
  column; Deals declares its own `owner` user field with an `["owner","status"]` index.
- **Read paths:** `runListQuery` (`packages/core/src/list.ts`) serves the list operations, but
  `record.count`, `record.groups`, `export.csv` and single-record loads (`loadRecord`, `loadPerson`)
  each build their own query on the `crm_*` view or the core table.
- **SQL:** `query.sql` and dashboard widgets run validated read-only SQL over `crm_*` views through
  `runReadOnlySql`, which already wraps the SQL. Views are static; D1 has no session variables. A
  user-written CTE may today reuse a `crm_*` name (CTE names are checked first in `checkTable`).
- **Search:** FTS over `core_search_docs`, hydrated through `loadDisplays`, which serves
  `search.global`, `search.hybrid` and `record.similar`. Vectorize metadata holds only `{object, id}`.
  `similarRecords` does not check the caller can see the source record.
- **Caches and summaries:** dashboard results are cached 60 s keyed by `visibilityScope(user)`,
  which returns `role:<role>` today with a comment that it must become per user. AI summaries are
  one shared row per subject.
- **Actors:** MCP is role ∩ scopes (`pipeline.ts`); the assistant runs as the person with no scopes;
  automations run as the extension principal with role hard-coded `member`; system jobs as
  `SYSTEM_USER` (admin).
- **Precedent:** private activities (`private_to`) are filtered inside `core_base_activities`,
  `crm_activity_links`, FTS, embeddings and summaries, with a `visibleTo(userId)` helper.

## Scope: 14a

### Roles
- **Admin:** everything, sees all records.
- **Manager:** a Member who also sees records owned by members of their teams under an `own`
  policy, and may import (`records:import`).
- **Member:** reads and writes the records they can see.
- **Read-only:** reads the records a Member in their teams would see; no writes. Stored as
  `viewer`, labelled "Read-only" (no data change).
- `manager` is added to `ROLES`, `ROLE_PERMISSIONS` and `core_user.role`'s `CHECK`. SQLite cannot
  alter a `CHECK`, so the migration rebuilds `core_user` with its triggers (`core_user_first_admin`)
  and indexes; it is tested against a copy of a seeded database and Better Auth's sign-in.
- New permissions: `records:import` (Admin, Manager; Members when an admin turns on "Members can
  import"), `teams:manage` (Admin).
- No field-level permissions.

### Teams
- `core_team (id, name, created_at, …)` and `core_team_member (team_id, user_id)`, primary key on
  both, index on `user_id`. A user can be in several teams.
- Operations `team.list`, `team.get` (anyone), `team.create|update|delete|addMember|removeMember`
  (`teams:manage`, `actors: ["human"]`, not exposed to MCP, audited): teams decide visibility, and
  visibility is policy, which is human-admin-only.
- Settings → Users and teams: users with role, teams, status; teams with members.

### Invites
- `user.invite` (Admin, human only): email, role, teams. Writes `core_user_invite` (token hash,
  expiry 7 days) and sends the invite through the notification email path (`gatekeeper-email-send`).
  Accepting signs up through Better Auth even when `AUTH_ALLOW_SIGNUP` is off, and applies the role
  and teams. Under Cloudflare Access, a matching invite sets role and teams on the first request
  (`resolveActingUser` already creates the row then).
- `user.invites`, `user.revokeInvite`. `assertUserCapacity` (plan seats, ADR 0211) is checked at
  invite and at accept.

### Visibility policies (ADR 0244)
- Per object, set by an admin: **everyone** (default), **own**, or **own team**.
  - `own`: a user sees records they own; a Manager also sees records owned by members of any team
    they belong to.
  - `own team`: a user sees records owned by members of any team they belong to (and their own).
  - Admins see everything under every policy.
  - **Unowned records** (no owner) are visible to everyone who can see the object, as HubSpot's
    team and owned-only permissions treat unassigned records, so unassigned leads and imports stay
    findable. (Open question below.)
- Objects with a policy: person, organisation, task (owner = assignee), and any extension object
  that declares an owner field. The extension contract gains `owner: "<field>"` on `defineObject`,
  which must name a `user` field and gets an index; Deals declares `owner: "owner"`.
- **Inherited visibility:**
  - An activity is visible if the caller authored it, or it is linked to at least one record the
    caller can see, or it is linked to nothing (and, as today, it is not private to someone else).
  - Affiliations and deal participants are visible if their person is visible.
  - **Related titles stay visible.** A visible record that links to a hidden one shows the hidden
    record's title, not a link; opening it says "You don't have access to this record".
- Writes: you can change a record you can see, if your role writes. Changing the owner to someone
  else warns when you will lose sight of it.
- `visibility.get` (anyone), `visibility.update` (`policy:manage`, `actors: ["human"]`, not exposed
  to MCP, audited).
- Settings → Visibility: one row per object with the three options and a sentence for each.

### Enforcement: one seam (ADR 0244)
`packages/core/src/visibility/` computes, once per invocation, the caller's **scope** per object:
`all`, or a set of owner user ids (from the policy, the role and `core_team_member`, one indexed
read cached on the invocation context). Every read uses it through one of three doors:

1. **`visibleSource(ctx, object)`** returns the object's `crm_*` view with the predicate
   `(owner IS NULL OR owner IN (SELECT value FROM json_each(?)))`, or the plain view for `all`.
   `runListQuery`, `record.count`, `record.groups`, `export.csv`, `loadRecord`, `person.get`,
   `organisation.get`, `activity.listForRecord` (its parent must be visible), `loadDisplays` (search
   hydration) and `similarRecords` (the source record too) are changed to take their source from it.
   Nothing else may name a `crm_*` view or core record table for a read.
2. **`query.sql` and dashboards:** `runReadOnlySql` rewrites every `crm_*` view in a FROM or JOIN
   position whose object is restricted for the caller into a generated CTE (`__vis_crm_people AS
   (SELECT * FROM crm_people WHERE <predicate>)`), using the validator's own token stream, and binds
   the scope. The validator refuses user CTE names beginning `crm_` or `__vis_`, closing the
   shadowing gap. Activity, affiliation and participant views get their inherited predicates.
3. **Search and vectors:** FTS and Vectorize stay unfiltered at the index; every hit is hydrated
   through `visibleSource`, so a hidden hit is dropped. Vector queries over-fetch (three times
   `topK`, at most 100) so a restricted user still gets a full page.

Policies with everything on **everyone** skip the predicate entirely, so a deployment that never
restricts pays nothing.

### Every surface
- **UI, MCP, the assistant and Code Mode** call operations as the person, so the seam covers them.
  MCP stays role ∩ scopes for permissions; visibility is the person's.
- **Dashboards:** the cache key's `visibilityScope(user)` becomes a hash of the caller's scopes for
  the objects the widget reads, so users with the same scopes share results and nobody else does.
- **Exports:** through `visibleSource`; an export holds what the caller can see, with no count of
  the rest.
- **AI summaries:** a summary is generated from the subject, its activities and its related
  records. `core_ai_summary` gains `scope_key` in its primary key: `all` when no object the summary
  draws on is restricted for the reader, otherwise the hash of the reader's scopes, so a summary
  never includes what its reader cannot see. `summary.get` requires the subject to be visible.
- **Automations** run with the org-wide scope (they are approved by an admin and act for the org,
  as the extension principal does today). A notification they send about a record is delivered only
  to recipients who can see it; others are skipped with a line in the run's report.
- **Extension tools** called by a person run with that person's scope; automation-run extension
  code uses the org-wide scope.
- **Approvals:** non-admins see and decide only change sets whose records they can all see; admins
  see everything.
- **Sync** writes as the system and links activities to people regardless of who can see them;
  visibility then follows the inherited rules.
- **Uniqueness:** a create or import that hits another record's email or domain that the caller
  cannot see says "A record you can't see already uses this email; ask an admin", without its
  content.
- **Merge and erase** need both records visible.

### Tests that keep the seam honest
- A **registry-wide visibility test**: for every registered operation with permission
  `records:read` (core and the shipped extensions), a table names how it is checked; the test runs
  each against a fixture with an `own` policy and asserts no hidden record id, title or field value
  appears in any output. An operation missing from the table fails the test, so a new read
  operation cannot ship unchecked.
- A lint-style test that fails when code outside `visibility/` and the reconciler selects from a
  `crm_*` view or a core record table for a read.

## Scope: 14b (SSO and SCIM)

The seams are built in 14a; the behaviour in 14b.

- **Seams in 14a:** `Principal.groups: string[]` (empty from today's adapters);
  `core_user.external_id` and `core_user.managed_by` (`local | idp | scim`); a
  `core_identity_group_mapping (provider, group, role, team_id)` table; and `resolveActingUser`
  applying mappings for users managed by the IdP. Nothing reads groups until 14b.
- **SSO:** OIDC and SAML through Better Auth's SSO support (ADR 0008 already lists it), configured
  only by env (`SSO_*` secrets and settings), never at runtime or by AI. Cloudflare Access already
  gives SSO; 14b reads its `groups` claim. Group to role and team mappings are edited by human
  admins in Settings → Users and teams. An option "SSO only" turns off password sign-in.
- **SCIM 2.0** on ros-app: `/scim/v2/Users` and `/scim/v2/Groups` (create, update, deactivate,
  group membership), authenticated by a bearer token held only as the Worker secret `SCIM_TOKEN`.
  Users created by SCIM are `managed_by = scim` and cannot be edited in the UI except role overrides
  if an admin allows them. Deactivation goes through `user.deactivate`, so connections and automation
  bindings are revoked as today (ADR 0170). Groups map to teams through the mapping table. Every
  SCIM call is audited with origin `{ surface: "system", via: "scim" }`.
- Tested against Okta's and Microsoft Entra ID's SCIM validators' request shapes (fixtures), and
  with a fake OIDC provider.

## Out of scope
- Field-level permissions, record sharing rules (sharing one record with one user), territory
  hierarchies and role hierarchies deeper than Manager over their teams.
- Per-object write policies different from read (for example "see all, edit own").
- Restricting visibility of users themselves (everyone sees the user list).

## Acceptance criteria
1. **Roles:** Manager and Read-only behave as specified across UI, MCP and the assistant; the
   `core_user` rebuild migration keeps users, sessions, triggers and Better Auth sign-in working on
   a seeded copy; the first-user-admin trigger still fires.
2. **Teams and invites:** admins manage teams; team writes are refused for non-humans and are not on
   MCP; an invite signs a person up with its role and teams with sign-up otherwise closed; expired
   and revoked invites fail; seat limits apply.
3. **Policies:** for person, organisation, task and `deals.deal`, each of `everyone`, `own` and
   `own team` shows exactly the specified records to an Admin, a Manager, a Member and a Read-only
   user, including unowned records, through list, get, count, groups, board, export, search
   (FTS and hybrid), similar records, record tabs and panels.
4. **Inherited:** activities, affiliations and participants follow the rules; titles of hidden
   related records show without links; opening one says no access.
5. **SQL:** `query.sql` and dashboard widgets return only visible rows under a restricted policy,
   including through joins, subqueries and CTEs; a user CTE named `crm_people` or `__vis_x` is
   refused; the validator tests from ADR 0020 still pass.
6. **Registry-wide test** exists, covers every `records:read` operation, and fails for an
   operation missing from its table. The lint-style test fails on a stray `crm_*` read.
7. **Caches and summaries:** two users with different scopes never share a dashboard cache entry or
   a summary; users with equal scopes do.
8. **Automations, notifications, approvals, uniqueness, merge and erase** behave as specified.
9. **Cost:** with every policy `everyone`, `rows_read` budgets in `rows-read.test.ts`,
   `dashboards-rows-read.test.ts` and `ai-rows-read.test.ts` are unchanged. Under `own` and
   `own team`, new budgets for list pages, search hydration, counts and a dashboard over activities
   hold on the 3,000-person seed with `EXPLAIN QUERY PLAN` showing the owner index used; the scope
   costs one indexed read per invocation.
10. **14b:** with a fake OIDC provider and SCIM fixtures, users are created, updated, grouped into
    teams and deactivated; group mappings set role and teams on sign-in; "SSO only" refuses password
    sign-in; `SCIM_TOKEN` is never stored in D1 or logged; SSO settings are env-only.
11. `pnpm lint typecheck test` and e2e (an admin restricts People to `own`; a Member sees only
    theirs in list, search, the assistant and a dashboard) pass in CI. ADRs, `CONTEXT.md` (Role,
    Team, Visibility policy, Scope, Invite) and `docs/architecture.md` (Identity, Data) are updated.

## Dependencies
- Needs everything on `main`, including 7b (the assistant). Touches files many stages edit: build
  14a when few other stages are in flight, or rebase often.
- **Affects 12:** `records:import`; imported records' owners; import uniqueness messages.
- **Affects 13:** templates, enrolment and compose respect visibility; reply detection runs as the
  system.
- **Affects 15:** leads declare an owner field and get a policy; the leads inbox is a list, so it
  inherits visibility; assignment rules can assign to users the creator cannot see into.
- **Affects 16:** duplicate suggestions show only pairs where both records are visible; merging
  needs both.
- Stage 10's per-seat plans count invited users.

## Migrations and numbers
Migrations 0260–0269. ADRs 0244 and 0245.

## Suggested build order
1. Roles (Manager, Read-only label, permissions) and the `core_user` rebuild.
2. Teams and invites.
3. The visibility module and `visibleSource`; move every read path onto it; the registry-wide test
   and the lint test. Policies settings.
4. `query.sql` and dashboard rewriting; cache keys.
5. Search, vectors, similar records.
6. Summaries, automations, notifications, approvals, uniqueness messages.
7. Cost budgets.
8. 14b seams are part of step 1; SSO and SCIM afterwards, in their own PR.

## Open questions
- **Unowned records** under `own` and `own team`: visible to everyone (proposed, HubSpot-like), or
  only to Admins and Managers?
- **Related titles:** show a hidden related record's title (proposed, as Salesforce shows lookup
  names) or "Restricted record"?
- **Members importing:** off by default (proposed)?
- **SCIM-managed users' roles:** may admins override a role the IdP set?
