// Turning extension source into sandbox modules: transpile TypeScript (sucrase: types stripped,
// ES modules kept), then check and rewrite imports. Extension code may import only its own files
// (relative paths that stay inside the extension) and `@relationship-os/sdk`. Host modules are never imported
// by extension code: the fixed entry module (src/executor/worker-code.ts) wires only the declared
// ones and hands them to tools as `ctx`, so an undeclared module cannot be reached (ADR 0025).
// `node:*`, other packages, dynamic `import()` and `require` are refused here; the Dynamic
// Worker's loader refuses anything unconfigured as a second line.
import type { SourceIssue } from "@relationship-os/core";
import { transform } from "sucrase";

export const SDK_SPECIFIER = "ros-sdk";
export const MAX_FILES = 100;
export const MAX_SOURCE_BYTES = 1_000_000;

export type BuildResult =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; issues: SourceIssue[] };

const SOURCE_RE = /\.(ts|js)$/;
const IMPORT_FROM_RE = /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*)(["'])([^"'\n]+)\2/g;
const BARE_IMPORT_RE = /(\bimport\s*)(["'])([^"'\n]+)\2/g;

/** Removes comments so they cannot hide `import(` (strings are left alone; fail-closed). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
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

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** `./tools` or `./tools.ts` from `index.ts` → `tools.ts` (when that file exists). */
function resolveRelative(
  from: string,
  specifier: string,
  files: Record<string, string>,
): string | null {
  const base = normalise(`${dirOf(from)}/${specifier}`);
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`]) {
    if (Object.hasOwn(files, candidate) && SOURCE_RE.test(candidate)) return candidate;
  }
  return null;
}

const jsName = (path: string) => path.replace(/\.ts$/, ".js");

/** Transpiles and checks every source file. Module paths in the result end in `.js`. */
export function buildExtension(files: Record<string, string>): BuildResult {
  const issues: SourceIssue[] = [];
  const paths = Object.keys(files).filter((p) => SOURCE_RE.test(p));
  if (Object.keys(files).length > MAX_FILES) {
    return {
      ok: false,
      issues: [{ code: "too_large", path: "(root)", message: `At most ${MAX_FILES} files` }],
    };
  }
  const bytes = Object.values(files).reduce((n, text) => n + text.length, 0);
  if (bytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      issues: [{ code: "too_large", path: "(root)", message: "Source is larger than 1 MB" }],
    };
  }
  if (!Object.hasOwn(files, "index.ts") && !Object.hasOwn(files, "index.js")) {
    issues.push({
      code: "entry",
      path: "index.ts",
      message: "An extension needs an index.ts whose default export is defineExtension({...})",
    });
  }
  const modules: Record<string, string> = {};
  for (const path of paths) {
    let code: string;
    try {
      code = transform(files[path] as string, {
        transforms: ["typescript"],
        disableESTransforms: true,
        keepUnusedImports: false,
        filePath: path,
      }).code;
    } catch (error) {
      issues.push({
        code: "syntax",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const scan = stripComments(code);
    if (/\bimport\s*\(/.test(scan)) {
      issues.push({
        code: "import",
        path,
        message: "Dynamic import() is not allowed in extensions",
      });
    }
    if (/\brequire\s*\(/.test(scan)) {
      issues.push({ code: "import", path, message: "require() is not available; use import" });
    }
    if (/\bimport\.meta\b/.test(scan)) {
      issues.push({ code: "import", path, message: "import.meta is not available in extensions" });
    }
    const rewrite = (_match: string, head: string, quote: string, specifier: string) => {
      if (specifier === "@relationship-os/sdk") return `${head}${quote}${SDK_SPECIFIER}${quote}`;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = resolveRelative(path, specifier, files);
        if (!target) {
          issues.push({
            code: "import",
            path,
            message: `Cannot import "${specifier}": not a file of this extension`,
          });
          return `${head}${quote}${specifier}${quote}`;
        }
        const own = jsName(path).split("/");
        own.pop();
        const up = own.map(() => "..");
        const relative = `./${[...up, jsName(target)].join("/")}`;
        return `${head}${quote}${relative}${quote}`;
      }
      issues.push({
        code: "import",
        path,
        message: specifier.startsWith("codemode:")
          ? `Extensions do not import host modules ("${specifier}"); declare it in permissions.modules and use ctx`
          : `Cannot import "${specifier}": extensions may import only @relationship-os/sdk and their own files`,
      });
      return `${head}${quote}${specifier}${quote}`;
    };
    modules[jsName(path)] = code.replace(IMPORT_FROM_RE, rewrite).replace(BARE_IMPORT_RE, rewrite);
  }
  return issues.length ? { ok: false, issues } : { ok: true, modules };
}
