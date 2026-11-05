// Erasure housekeeping (ADR 0320), human admins only:
// - erasure.addressStatus / erasure.allowAddress: the erased-address list, which keeps mail and
//   calendar sync from collecting an erased person again. Allowing an address is for a person who
//   comes back by consent.
// - erasure.reapply: after a database restore (D1 Time Travel), erase again everything the erase
//   log (R2, outside the restorable database) says was erased.
import { z } from "zod";
import { ConfigError } from "../errors.ts";
import { defineOperation } from "../operation.ts";
import { chunk } from "../records/common.ts";
import { planReapply, putEraseLog, readEraseLog } from "../records/erase-log.ts";
import { erasedAddressHash } from "../records/erase-subject.ts";

const address = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const erasureAddressStatus = defineOperation({
  name: "erasure.addressStatus",
  description:
    "Whether an email address is on the erased-address list: the addresses of erased people, " +
    "which mail and calendar sync drops (the list holds only a hash of each address). Admins only.",
  input: z.object({ email: address }),
  output: z.object({ erased: z.boolean(), erasedAt: z.string().nullable() }),
  // The admin Audit page's permission: admins only, and a read.
  permission: "audit:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_erased_address")
      .select("erased_at")
      .where("hash", "=", await erasedAddressHash(input.email))
      .executeTakeFirst();
    return { erased: Boolean(row), erasedAt: row?.erased_at ?? null };
  },
});

export const erasureAllowAddress = defineOperation({
  name: "erasure.allowAddress",
  description:
    "Take an email address off the erased-address list, so mail and calendar sync can match and " +
    "suggest it again: for a person who was erased and has come back by consent. Admins only, " +
    "and only a person in the app. Records the decision in the erase log, so a re-apply after a " +
    "restore keeps it.",
  input: z.object({ email: address }),
  output: z.object({ removed: z.boolean() }),
  permission: "records:erase",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // The address is personal data: the audit keeps that the call happened, not the address.
  redact: ["email"],
  async handler(input, ctx) {
    const hash = await erasedAddressHash(input.email);
    const row = await ctx.db
      .selectFrom("core_erased_address")
      .select("hash")
      .where("hash", "=", hash)
      .executeTakeFirst();
    if (!row) return { removed: false };
    if (ctx.blobs && !ctx.simulation) {
      await putEraseLog(ctx.blobs, { v: 1, kind: "allow", at: ctx.now, addresses: [hash] });
    }
    ctx.write(ctx.db.deleteFrom("core_erased_address").where("hash", "=", hash));
    return { removed: true };
  },
});

export const erasureReapply = defineOperation({
  name: "erasure.reapply",
  description:
    "After the database is restored from a backup or Time Travel, erase again every person and " +
    "organisation the erase log says was erased, and restore the erased-address list. The log " +
    "lives in blob storage, outside the database, and holds only hashes. Safe to run more than " +
    "once. Admins only, and only a person in the app.",
  input: z.object({}),
  output: z.object({
    entries: z.number().describe("Erase-log entries read"),
    people: z.array(z.string()).describe("People erased again"),
    organisations: z.array(z.string()).describe("Organisations erased again"),
    addresses: z.number().describe("Addresses on the erased-address list"),
  }),
  permission: "records:erase",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    if (!ctx.blobs?.list) {
      throw new ConfigError("The erase log is in blob storage (R2), which is not available here");
    }
    const entries = await readEraseLog(ctx.blobs);
    const plan = await planReapply(ctx.db, entries);
    const nested = { actor: ctx.actor, user: ctx.user, origin: ctx.origin };
    if (!ctx.simulation) {
      // Each erase commits on its own (and is audited); a failure stops here and the call can be
      // repeated: what was erased is no longer found.
      // A record merged into another one in the plan goes with it, so each is looked up again
      // just before its erase.
      for (const id of plan.people) {
        const live = await ctx.db
          .selectFrom("core_person")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (live) await ctx.pipeline.invoke("person.erase", { id }, nested);
      }
      for (const id of plan.organisations) {
        const live = await ctx.db
          .selectFrom("core_organisation")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (live) await ctx.pipeline.invoke("organisation.erase", { id }, nested);
      }
    }
    for (const part of chunk(plan.addresses)) {
      ctx.write(
        ctx.db
          .insertInto("core_erased_address")
          .values(
            part.map((hash) => ({
              hash,
              object_type: "person" as const,
              erased_at: ctx.now,
              erased_by: ctx.user.id,
            })),
          )
          .onConflict((oc) => oc.doNothing()),
      );
    }
    return {
      entries: entries.length,
      people: plan.people,
      organisations: plan.organisations,
      addresses: plan.addresses.length,
    };
  },
});

export const erasureOperations = [
  erasureAddressStatus,
  erasureAllowAddress,
  erasureReapply,
] as const;
