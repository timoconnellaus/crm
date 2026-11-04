// user.* operations: the deployment's users and their roles. Changing a role is admin-only and
// human-only (identity is not AI-configurable), and the last admin cannot be demoted.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError } from "../errors.ts";
import { defineObject } from "../fields/types.ts";
import { listInputSchema, pageSchema, runListQuery, selectFields } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { ROLES } from "../principals.ts";

/** Users are not a record object (no tags, links or timeline); this only drives user.list. */
export const userObject = defineObject({
  name: "user",
  label: "User",
  source: "crm_users",
  defaultSort: { field: "name", direction: "asc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    { name: "name", label: "Name", type: "text", column: "name", filterable: true, sortable: true },
    {
      name: "email",
      label: "Email",
      type: "text",
      column: "email",
      filterable: true,
      sortable: true,
    },
    {
      name: "role",
      label: "Role",
      type: "enum",
      enumValues: ROLES,
      column: "role",
      filterable: true,
      sortable: true,
    },
    {
      name: "createdAt",
      label: "Created",
      type: "datetime",
      column: "created_at",
      filterable: true,
      sortable: true,
    },
  ],
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  image: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;
const USER_FIELDS = Object.keys(userSchema.shape);

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: (typeof ROLES)[number];
  image: string | null;
  created_at: string;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  image: row.image,
  createdAt: String(row.created_at),
});

export const userList = defineOperation({
  name: "user.list",
  description:
    "List the CRM's users (people who can sign in) with their role: admin, member or viewer. " +
    "Use it to find a user id for an owner or assignee. Filter with structured filter JSON " +
    "over id, name, email, role and createdAt; sort by any of them (default name). Read-only.",
  input: listInputSchema,
  output: pageSchema(userSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery(ctx.db.selectFrom("crm_users").selectAll(), userObject, input);
    return {
      items: selectFields(page.rows.map(toUser), input.fields, USER_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

export const userUpdateRole = defineOperation({
  name: "user.updateRole",
  description:
    "Change a user's role: admin (everything, including erase, users and the approval " +
    "policy), member (read and write records) or viewer (read only). Admins only, and only a " +
    "human can call it. The last admin cannot be demoted. Returns the user.",
  input: z.object({
    id: z.string().min(1).max(64).describe("User id (usr_…)"),
    role: z.enum(ROLES),
  }),
  output: userSchema.extend({ previousRole: z.enum(ROLES) }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await ctx.db
      .selectFrom("crm_users")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("user", input.id);
    const demotingAdmin = before.role === "admin" && input.role !== "admin";
    if (demotingAdmin) {
      const other = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("role", "=", "admin")
        .where("id", "<>", input.id)
        .executeTakeFirst();
      if (!other) {
        throw new ConflictError("The last admin cannot be demoted; make someone else admin first", {
          field: "role",
        });
      }
    }
    // Backstop for a concurrent demotion of the other admin: if no other admin remains when
    // the batch runs, the CASE writes a value the role CHECK rejects and nothing is applied.
    const role = demotingAdmin
      ? sql<
          (typeof ROLES)[number]
        >`CASE WHEN EXISTS (SELECT 1 FROM core_user WHERE role = 'admin' AND id <> ${input.id}) THEN ${input.role} ELSE 'no-admin-left' END`
      : input.role;
    ctx.write(
      ctx.db.updateTable("core_user").set({ role, updated_at: ctx.now }).where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "user",
      id: input.id,
      action: "update",
      before: { role: before.role },
      after: { role: input.role },
    });
    return { ...toUser({ ...before, role: input.role }), previousRole: before.role };
  },
});

export const userOperations = [userList, userUpdateRole] as const;
