// The TypeScript checker's Dynamic Worker (ADR 0043). scripts/bundle.mjs bundles this entry with
// the compiler and the SDK declarations into generated/checker.txt; ros-runner loads it with
// LOADER.get("tsc@<typescript version>+<checker hash>", …), so the 3.5 MB compiler is parsed in
// this worker only, once per isolate, and never in ros-runner's own cold start. The parsed
// declarations stay cached in this isolate across checks (typecheck.ts).
import { WorkerEntrypoint } from "cloudflare:workers";
import { typecheckExtension } from "../extensions/typecheck.ts";

export default class Checker extends WorkerEntrypoint {
  /** Type-checks extension source against @relationship-os/sdk; see typecheckExtension. */
  async check(files: Record<string, string>) {
    return typecheckExtension(files);
  }
}
