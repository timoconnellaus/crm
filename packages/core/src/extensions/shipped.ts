// Installing shipped extensions at boot (ADR 0025): every extension bundled with this release goes
// through `extension.install`, the same audited path an admin uses, as a system call. An extension
// already at the bundled commit is left alone (so an admin's disable sticks); a new release's
// version is installed.
import type { CrmDb } from "@relationship-os/db";
import { toOperationError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { invokeByName } from "../invoke.ts";
import { SYSTEM_USER } from "../users.ts";
import type { ExtensionHost } from "./host.ts";

export interface ShippedInstallResult {
  id: string;
  /** `ejected`: an admin ejected it (it is a runtime extension now), so releases leave it alone. */
  outcome: "installed" | "unchanged" | "ejected" | "failed";
  error?: string;
}

export async function installShippedExtensions(options: {
  db: CrmDb;
  host: ExtensionHost;
  floor?: GateFloor;
}): Promise<ShippedInstallResult[]> {
  const results: ShippedInstallResult[] = [];
  for (const shipped of await options.host.shipped()) {
    try {
      const installed = await options.db.query
        .selectFrom("core_extensions")
        .select(["source"])
        .where("id", "=", shipped.id)
        .executeTakeFirst();
      if (installed?.source === "runtime") {
        results.push({ id: shipped.id, outcome: "ejected" });
        continue;
      }
      const { commit } = await options.host.commitShipped(shipped.id);
      const row = await options.db.query
        .selectFrom("core_extensions")
        .select(["commit_oid"])
        .where("id", "=", shipped.id)
        .executeTakeFirst();
      if (row?.commit_oid === commit) {
        results.push({ id: shipped.id, outcome: "unchanged" });
        continue;
      }
      await invokeByName(
        "extension.install",
        { id: shipped.id, shipped: true },
        {
          actor: "human",
          user: SYSTEM_USER,
          origin: { surface: "system" },
          db: options.db,
          ...(options.floor ? { floor: options.floor } : {}),
          extensionHost: options.host,
        },
      );
      results.push({ id: shipped.id, outcome: "installed" });
    } catch (error) {
      const typed = toOperationError(error);
      console.error(`installing shipped extension ${shipped.id} failed`, typed.toJSON());
      results.push({ id: shipped.id, outcome: "failed", error: typed.message });
    }
  }
  return results;
}
