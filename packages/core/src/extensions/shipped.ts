// Installing shipped extensions at boot (ADR 0025): every extension bundled with this release goes
// through `extension.install`, the same audited path an admin uses, as a system call. An extension
// already at the bundled commit is left alone (so an admin's disable sticks); a new release's
// version is installed.
import type { CrmDb } from "@relationship-os/db";
import { toOperationError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { invokeByName } from "../invoke.ts";
import { SYSTEM_USER } from "../users.ts";
import type { ExtensionHost, ShippedExtension } from "./host.ts";

export interface ShippedInstallResult {
  id: string;
  /**
   * `ejected`: an admin ejected it (it is a runtime extension now), so releases leave it alone.
   * `available`: an opt-in shipped extension no admin has installed (ADR 0246).
   */
  outcome: "installed" | "unchanged" | "ejected" | "available" | "failed";
  error?: string;
}

export async function installShippedExtensions(options: {
  db: CrmDb;
  host: ExtensionHost;
  floor?: GateFloor;
}): Promise<ShippedInstallResult[]> {
  const results: ShippedInstallResult[] = [];
  const failed: ShippedExtension[] = [];
  const all = await options.host.shipped();
  // One that depends on another shipped extension (Leads on Deals) may fail before it is
  // installed; it gets a second try after the rest.
  for (const [pass, list] of [
    [1, all],
    [2, failed],
  ] as const) {
    for (const shipped of [...list]) {
      const result = await installOne(options, shipped);
      if (result.outcome === "failed" && pass === 1) {
        failed.push(shipped);
        continue;
      }
      results.push(result);
    }
  }
  return all.flatMap((s) => results.filter((r) => r.id === s.id));
}

async function installOne(
  options: { db: CrmDb; host: ExtensionHost; floor?: GateFloor },
  shipped: ShippedExtension,
): Promise<ShippedInstallResult> {
  try {
    const installed = await options.db.query
      .selectFrom("core_extensions")
      .select(["source"])
      .where("id", "=", shipped.id)
      .executeTakeFirst();
    if (installed?.source === "runtime") {
      return { id: shipped.id, outcome: "ejected" };
    }
    if (!installed && shipped.optional) return { id: shipped.id, outcome: "available" };
    const { commit } = await options.host.commitShipped(shipped.id);
    const row = await options.db.query
      .selectFrom("core_extensions")
      .select(["commit_oid"])
      .where("id", "=", shipped.id)
      .executeTakeFirst();
    if (row?.commit_oid === commit) {
      return { id: shipped.id, outcome: "unchanged" };
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
    return { id: shipped.id, outcome: "installed" };
  } catch (error) {
    const typed = toOperationError(error);
    console.error(`installing shipped extension ${shipped.id} failed`, typed.toJSON());
    return { id: shipped.id, outcome: "failed", error: typed.message };
  }
}
