// Build-time bundling for the extension runtime (ADR 0025):
//
// 1. The SDK as one ES module string (`crm-sdk` inside the sandbox): defineExtension, z,
//    runExtension, … with zod inlined, since Dynamic Workers cannot resolve packages.
// 2. Every shipped extension under extensions/<id>/ as source text (its .ts files, minus tests
//    and config), so it goes through the same transpile → check → sandbox path as runtime
//    extensions. There is no static fast path.
// 3. The declarations for the in-Worker type check of extension source (sdk-types.ts).
// 4. The TypeScript compiler as an ES module (typescript.js), and the type checker's Dynamic Worker
//    (checker.txt: the compiler, the declarations and src/checker/entry.ts in one module). The
//    checker runs in its own Dynamic Worker (ADR 0043), so crm-runner's main bundle does not carry
//    or parse the compiler; it ships checker.txt as a Text module.
// 5. runtime-meta.ts: hashes that go into the Dynamic Workers' stable loader ids (ADR 0043).
//
// Writes src/generated/{shipped,sdk-types,runtime-meta}.ts, sdk-bundle.txt, checker.txt and
// typescript.{js,d.ts} (gitignored). Runs before typecheck, test, dev and build (see package.json).
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = join(here, "..", "src", "generated");

const sdk = await build({
  entryPoints: [join(root, "packages", "sdk", "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
});
const sdkSource = sdk.outputFiles[0].text;

async function sourceFiles(dir, base = dir) {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "test", "tests", "dist", ".turbo"].includes(entry.name)) continue;
      Object.assign(files, await sourceFiles(path, base));
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|config)\.(ts|js)$/.test(entry.name)) {
      files[relative(base, path).split("\\").join("/")] = await readFile(path, "utf8");
    }
  }
  return files;
}

const shipped = [];
const extensionsDir = join(root, "extensions");
for (const entry of (await readdir(extensionsDir, { withFileTypes: true })).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory()) continue;
  const dir = join(extensionsDir, entry.name);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  await stat(join(dir, "index.ts"));
  shipped.push({ id: entry.name, version: pkg.version, files: await sourceFiles(dir) });
}

// 3. The declarations the in-Worker type checker needs (src/extensions/typecheck.ts): @crm/sdk's
//    .d.ts (emitted from packages/sdk/src), the zod .d.ts files they reach, and the ES2022 lib
//    files (no DOM), comments stripped, at virtual paths, plus every import's resolution between
//    them, so the Worker needs no module resolution of its own for these files.
const sdkTypes = (() => {
  const sdkSrc = realpathSync(join(root, "packages", "sdk", "src"));
  const program = ts.createProgram([join(sdkSrc, "index.ts")], {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    throw new Error(
      ts.formatDiagnostics(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  }
  const emitted = {};
  program.emit(undefined, (fileName, text) => {
    emitted[fileName] = text;
  });
  const printer = ts.createPrinter({ removeComments: true });
  const strip = (sf) => printer.printFile(sf);
  const toVirtual = (real) => {
    if (real.startsWith(`${sdkSrc}/`) && real.endsWith(".ts") && !real.endsWith(".d.ts")) {
      return `/sdk/${relative(sdkSrc, real).replace(/\.ts$/, ".d.ts")}`;
    }
    const zod = real.indexOf("/node_modules/zod/");
    if (zod !== -1) return real.slice(zod);
    throw new Error(`typecheck declarations: unexpected file ${real}`);
  };
  const files = {};
  const sources = []; // [virtual path, real path the imports resolve from, text]
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf)) {
      files[`/lib/${basename(sf.fileName)}`] = strip(sf);
      continue;
    }
    const virtual = toVirtual(sf.fileName);
    const text = virtual.startsWith("/sdk/")
      ? emitted[sf.fileName.replace(/\.ts$/, ".d.ts")]
      : strip(sf);
    if (text === undefined) throw new Error(`typecheck declarations: no .d.ts for ${sf.fileName}`);
    files[virtual] = text;
    sources.push([virtual, sf.fileName, text]);
  }
  const resolutions = {};
  for (const [virtual, real, text] of sources) {
    const info = ts.preProcessFile(text, true, true);
    if (info.referencedFiles.length || info.typeReferenceDirectives.length) {
      throw new Error(`typecheck declarations: ${virtual} has reference directives`);
    }
    const map = {};
    for (const { fileName: specifier } of info.importedFiles) {
      const resolved = ts.resolveModuleName(specifier, real, program.getCompilerOptions(), ts.sys)
        .resolvedModule?.resolvedFileName;
      if (!resolved) throw new Error(`typecheck declarations: ${specifier} from ${real}`);
      const target = toVirtual(realpathSync(resolved));
      if (!Object.hasOwn(files, target)) throw new Error(`typecheck declarations: ${target}`);
      map[specifier] = target;
    }
    if (Object.keys(map).length) resolutions[virtual] = map;
  }
  return { entry: "/sdk/index.d.ts", files, resolutions };
})();
const sdkTypesJson = JSON.stringify(sdkTypes);

// 4. The TypeScript compiler as an ES module for the Worker, minified. typescript.js picks Node's
//    `ts.sys` when `process` and `require` exist, which nodejs_compat provides, and that path reads
//    `__filename` at load and fails; `process.browser` set to true makes it skip `ts.sys` (the
//    checker uses its own in-memory host). Its Node-only requires are never reached.
const typescript = await build({
  entryPoints: [fileURLToPath(import.meta.resolve("typescript"))],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  define: { "process.browser": "true" },
  external: ["fs", "path", "os", "crypto", "inspector", "perf_hooks", "source-map-support"],
});
const typescriptSource = typescript.outputFiles[0].text;

await mkdir(out, { recursive: true });
const banner = "// Generated by apps/runner/scripts/bundle.mjs. Do not edit.\n";
await writeFile(join(out, "typescript.js"), typescriptSource);
await writeFile(
  join(out, "typescript.d.ts"),
  `${banner}import ts from "typescript";\nexport default ts;\n`,
);
await writeFile(
  join(out, "sdk-types.ts"),
  `${banner}/** Declarations for the extension type checker: @crm/sdk, zod and the ES2022 libs. */\nexport const SDK_TYPES: { entry: string; files: Record<string, string>; resolutions: Record<string, Record<string, string>> } = ${sdkTypesJson};\n`,
);
// @crm/sdk as one ES module for the sandbox (specifier `crm-sdk`), shipped as a Text module so the
// runner never parses it as code.
await writeFile(join(out, "sdk-bundle.txt"), sdkSource);
await writeFile(
  join(out, "shipped.ts"),
  `${banner}/** Shipped extensions (extensions/<id>/), as source. */\nexport const SHIPPED_EXTENSIONS: readonly { id: string; version: string; files: Record<string, string> }[] = ${JSON.stringify(shipped, null, 2)};\n`,
);

// The checker's Dynamic Worker: one ES module with the compiler, the declarations and the entry.
const checker = await build({
  entryPoints: [join(here, "..", "src", "checker", "entry.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
  external: [
    "cloudflare:workers",
    "fs",
    "path",
    "os",
    "crypto",
    "inspector",
    "perf_hooks",
    "source-map-support",
  ],
});
const checkerSource = checker.outputFiles[0].text;
await writeFile(join(out, "checker.txt"), checkerSource);

const sha = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};
/** The version of a dependency: the nearest package.json above its resolved entry. */
function pkgVersion(name) {
  let dir = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name) return pkg.version;
    } catch {}
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package.json for ${name}`);
    dir = up;
  }
}
const typescriptVersion = pkgVersion("typescript");
const sucraseVersion = pkgVersion("sucrase");
// Everything that decides what a build produces and how its worker runs: the SDK bundle, the
// transpiler and its version, the build rules and the fixed entry module.
const runtimeHash = sha(
  sdkSource,
  sucraseVersion,
  readFileSync(join(here, "..", "src", "extensions", "build.ts"), "utf8"),
  readFileSync(join(here, "..", "src", "executor", "worker-code.ts"), "utf8"),
);
await writeFile(
  join(out, "runtime-meta.ts"),
  `${banner}/** Hashes in the Dynamic Workers' stable loader ids (ADR 0043). */
export const SDK_HASH = ${JSON.stringify(sha(sdkSource))};
/** The SDK bundle, sucrase, build.ts and the entry module: what a build and its worker depend on. */
export const RUNTIME_HASH = ${JSON.stringify(runtimeHash)};
/** The type checker's worker: the compiler, the SDK declarations and the checker entry. */
export const CHECKER_HASH = ${JSON.stringify(sha(checkerSource))};
export const TYPESCRIPT_VERSION = ${JSON.stringify(typescriptVersion)};
export const SDK_TYPES_HASH = ${JSON.stringify(sha(sdkTypesJson))};
`,
);
console.log(
  `bundled crm-sdk (${(sdkSource.length / 1024).toFixed(0)} KiB), its type declarations (${Object.keys(sdkTypes.files).length} files, ${(sdkTypesJson.length / 1024).toFixed(0)} KiB), the checker worker with typescript ${typescriptVersion} (${(checkerSource.length / 1024).toFixed(0)} KiB) and ${shipped.length} shipped extension(s)`,
);
