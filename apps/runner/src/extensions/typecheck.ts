// A real TypeScript type check of extension source against @crm/sdk's types, in the Worker: the
// compiler API over an in-memory host. The declarations (the SDK's .d.ts, the zod .d.ts files they
// reach, the ES2022 libs) and their import resolutions are generated at build time
// (scripts/bundle.mjs → src/generated/sdk-types.ts). Their parsed (and bound) SourceFiles are
// cached in module scope, so after the first call in an isolate only the extension's own files
// are parsed. Synchronous and CPU-bound. The compiler is the build-time ESM bundle of
// `typescript` (generated/typescript.js), which works under nodejs_compat.
import type { SourceIssue } from "@crm/core";
import { SDK_TYPES } from "../generated/sdk-types.ts";
import ts from "../generated/typescript.js";

export const MAX_TYPE_ISSUES = 50;
const MAX_MESSAGE_LENGTH = 2_000;

/** Extension files live under this virtual directory; issue paths are relative to it. */
const ROOT = "/ext/";
const SDK_SPECIFIER = "@crm/sdk";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  allowImportingTsExtensions: true,
  allowJs: true,
  isolatedModules: true,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  noLib: false,
};

/** Parsed declaration files, shared by every check in this isolate. */
const declarations = new Map<string, ts.SourceFile>();

function declarationFile(
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.SourceFile | undefined {
  const cached = declarations.get(fileName);
  if (cached) return cached;
  const text = SDK_TYPES.files[fileName];
  if (text === undefined) return undefined;
  const file = ts.createSourceFile(fileName, text, languageVersion);
  declarations.set(fileName, file);
  return file;
}

function normalise(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** The same rules as build.ts: own files (`./x`, `./x.ts`, `./x.js`, `./x/index.ts`) and the SDK. */
function resolveFromExtension(
  from: string,
  specifier: string,
  files: Record<string, string>,
): ts.ResolvedModuleFull | undefined {
  if (specifier === SDK_SPECIFIER) {
    return { resolvedFileName: SDK_TYPES.entry, extension: ts.Extension.Dts };
  }
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const dir = from.slice(ROOT.length).split("/").slice(0, -1).join("/");
  const base = normalise(`${dir}/${specifier}`);
  if (base === null) return undefined;
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${base}.ts`, `${stem}.ts`, `${base}.js`, `${base}/index.ts`]) {
    if (/\.(ts|js)$/.test(candidate) && Object.hasOwn(files, candidate)) {
      const extension = candidate.endsWith(".ts") ? ts.Extension.Ts : ts.Extension.Js;
      return { resolvedFileName: `${ROOT}${candidate}`, extension };
    }
  }
  return undefined;
}

function extensionOf(fileName: string): ts.Extension {
  if (fileName.endsWith(".d.cts")) return ts.Extension.Dcts;
  if (fileName.endsWith(".d.mts")) return ts.Extension.Dmts;
  return ts.Extension.Dts;
}

function issueFor(diagnostic: ts.Diagnostic): SourceIssue {
  let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (message.length > MAX_MESSAGE_LENGTH) message = `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
  const file = diagnostic.file;
  if (!file || diagnostic.start === undefined) {
    return { code: "type", path: "(root)", message: `${message} (TS${diagnostic.code})` };
  }
  const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start);
  const path = file.fileName.startsWith(ROOT) ? file.fileName.slice(ROOT.length) : "(sdk)";
  return {
    code: "type",
    path,
    message: `${line + 1}:${character + 1} ${message} (TS${diagnostic.code})`,
  };
}

/**
 * Type-checks an extension's source (paths relative to the extension root, entry `index.ts`)
 * against @crm/sdk. `.ts` files are checked; `.js` files are only read for their exports.
 * Returns at most MAX_TYPE_ISSUES issues, errors only; an empty array means it type-checks.
 */
export function typecheckExtension(files: Record<string, string>): SourceIssue[] {
  const sources: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (/\.(ts|js)$/.test(path) && !path.endsWith(".d.ts")) sources[path] = text;
  }
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      if (fileName.startsWith(ROOT)) {
        const text = sources[fileName.slice(ROOT.length)];
        return text === undefined
          ? undefined
          : ts.createSourceFile(fileName, text, languageVersion);
      }
      return declarationFile(fileName, languageVersion);
    },
    getDefaultLibFileName: () => "/lib/lib.es2022.d.ts",
    getDefaultLibLocation: () => "/lib",
    writeFile: () => {},
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) =>
      fileName.startsWith(ROOT)
        ? Object.hasOwn(sources, fileName.slice(ROOT.length))
        : Object.hasOwn(SDK_TYPES.files, fileName),
    readFile: (fileName) =>
      fileName.startsWith(ROOT) ? sources[fileName.slice(ROOT.length)] : SDK_TYPES.files[fileName],
    directoryExists: () => false,
    getDirectories: () => [],
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map(({ text }) => {
        let resolvedModule: ts.ResolvedModuleFull | undefined;
        if (containingFile.startsWith(ROOT)) {
          resolvedModule = resolveFromExtension(containingFile, text, sources);
        } else {
          const target = SDK_TYPES.resolutions[containingFile]?.[text];
          if (target) {
            resolvedModule = {
              resolvedFileName: target,
              extension: extensionOf(target),
              isExternalLibraryImport: true,
            };
          }
        }
        return { resolvedModule };
      }),
  };
  const roots = Object.keys(sources)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `${ROOT}${path}`);
  const program = ts.createProgram({ rootNames: roots, options: OPTIONS, host });
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...roots.flatMap((root) => {
      const file = program.getSourceFile(root);
      if (!file) return [];
      const syntax = program.getSyntacticDiagnostics(file);
      return syntax.length ? syntax : program.getSemanticDiagnostics(file);
    }),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  return diagnostics.slice(0, MAX_TYPE_ISSUES).map(issueFor);
}
