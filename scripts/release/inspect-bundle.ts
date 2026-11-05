#!/usr/bin/env node
// Opens a release bundle the way the deployers do (every file checked against the manifest) and
// prints what it holds. Usage: node scripts/release/inspect-bundle.ts <relationship-os-x.y.z.tar.gz>
import { readFileSync } from "node:fs";
import { assertUnresolved, openBundle, sha256Hex } from "@relationship-os/release";

const path = process.argv[2];
if (!path) {
  console.error("usage: inspect-bundle.ts <bundle.tar.gz>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const bundle = await openBundle(bytes);
assertUnresolved(bundle.manifest);
const m = bundle.manifest;
console.log(`Relationship OS ${m.version} (${m.channel}) from ${m.repository}@${m.commit.slice(0, 12)}`);
console.log(`sha256 ${await sha256Hex(bytes)}`);
console.log(
  `extension contract ${m.extensionContract.version} (supports ${m.extensionContract.supported.join(", ")})`,
);
console.log(`core schema ${m.coreSchemaVersion}, ${m.migrations.length} migrations`);
for (const w of m.workers) {
  console.log(
    `  ${w.name.padEnd(28)} ${w.role.padEnd(10)} ${w.optional ? "optional" : "required"}  ${w.modules.length} modules${w.assets ? `, ${Object.keys(w.assets.files).length} assets` : ""}`,
  );
}
for (const r of m.resources)
  console.log(`  resource ${r.type} ${r.name}${r.implicit ? " (implicit)" : ""}`);
