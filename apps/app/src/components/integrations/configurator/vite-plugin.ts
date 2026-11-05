// Build-time support for rendering the vendored gatekeeper configurator specs natively (stage 6).
// Used by vite.config.ts and vitest.config.ts; never imported by app code.
//
// The specs (`packages/gatekeeper-*/src/configurator/*-configurator-ui.tsx`) are written against
// the authoring API in `@relationship-os/gatekeeper-configurator-ui` and compiled with `jsxFactory: "h"`.
// Upstream bundles each into its own sandboxed frame; we render them in the app with React, so
// this plugin:
//
//  1. aliases `@relationship-os/gatekeeper-configurator-ui` (exactly; not `/options`) to our React runtime,
//     and `@relationship-os/gatekeeper-configurator-ui/options` to the vendored helpers, which the app does
//     not depend on directly;
//  2. resolves `configurator-spec:<vendor>/<name>` (what `registry.ts` imports) to the spec file,
//     so `tsc` never follows the app into vendored sources (their types come from `specs.d.ts`);
//  3. compiles each spec's JSX with the classic runtime through our `h`, whatever the React
//     plugin's automatic runtime would do, by adding JSX pragmas; and
//  4. wraps each spec's module body in `createConfiguratorSpec()`. Specs keep state at module
//     level (a pending grant, a running conversion) for the life of their frame; calling the
//     factory per form is what gives every configurator a fresh "frame". Line numbers are kept.
//
// The vendored files themselves are never edited.
//
// It lives under src/ beside the runtime it wires up, so it must type-check in the app's program,
// which has neither Node's nor Vite's types (Vite's would change the Workers types the server
// functions are checked against): hence no imports, and the plugin's shape spelled out below.

/** The part of Vite's `Plugin` this plugin uses. */
type VitePlugin = {
  name: string;
  enforce: "pre";
  config(): { resolve: { alias: { find: RegExp; replacement: string }[] } };
  resolveId(id: string): string | undefined;
  transform(code: string, id: string): { code: string; map: null } | undefined;
};

const SPEC_PREFIX = "configurator-spec:";

/** The repo's `packages/` directory, as a file system path. */
function packagesDir(): string {
  const path = decodeURIComponent(new URL("../../../../../../packages/", import.meta.url).pathname);
  // file:///C:/… on Windows.
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/**
 * Spec files that live somewhere other than `src/configurator/<name>-configurator-ui.tsx` in
 * `packages/gatekeeper-<vendor>`, keyed by `<vendor>/<name>`.
 */
const SPEC_PATHS: Record<string, string> = {
  "email-send/sender": "gatekeeper-email-send/src/configurator/sender-configurator-ui.tsx",
};

/** The file a `configurator-spec:<vendor>/<name>` specifier names. */
export function configuratorSpecPath(vendorAndName: string): string {
  const [vendor, name, ...rest] = vendorAndName.split("/");
  if (!vendor || !name || rest.length > 0 || !/^[a-z0-9-]+$/.test(vendor + name)) {
    throw new Error(`Bad configurator spec specifier: ${SPEC_PREFIX}${vendorAndName}`);
  }
  const relative =
    SPEC_PATHS[`${vendor}/${name}`] ??
    `gatekeeper-${vendor}/src/configurator/${name}-configurator-ui.tsx`;
  return packagesDir() + relative;
}

const SPEC_FILE = /\/packages\/gatekeeper-[^/]+\/src\/configurator\/[^/]+-ui\.tsx$/;

const PRAGMA =
  "/** @jsxRuntime classic */ /** @jsx __crmConfiguratorH */ /** @jsxFrag __crmConfiguratorFragment */ " +
  'import { h as __crmConfiguratorH, Fragment as __crmConfiguratorFragment } from "@relationship-os/gatekeeper-configurator-ui"; ';

const SPACE_OR_COMMENT = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y;
const WORD = /[\w$]+/y;

/**
 * The end of the import declaration starting at `start`, or null when none starts there. Skips
 * comments inside it (which may hold quotes); ends after the module specifier and its `;`.
 */
export function importEnd(source: string, start: number): number | null {
  if (!/^import[\s{*"']/.test(source.slice(start, start + 7))) return null;
  let index = start + "import".length;
  let lastWord = "import";
  while (index < source.length) {
    const char = source.charAt(index);
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      if (end < 0) return null;
      index = end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
    } else if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end < 0) return null;
      index = end + 1;
      if (lastWord === "from" || lastWord === "import") {
        return source.charAt(index) === ";" ? index + 1 : index;
      }
      lastWord = "";
    } else if (/[\w$]/.test(char)) {
      WORD.lastIndex = index;
      const word = WORD.exec(source)?.[0] ?? char;
      lastWord = word;
      index += word.length;
    } else {
      if (!/\s/.test(char)) lastWord = char;
      index++;
    }
  }
  return null;
}

/**
 * The spec source, compiled through our `h` and wrapped in `createConfiguratorSpec()`. Returns the
 * source with only the pragmas added when its shape is not the one every spec has (imports, then
 * declarations, then one `export default` and no other export): the registry then falls back to
 * the module's default export, shared by every form.
 */
export function transformConfiguratorSpec(source: string): string {
  let index = 0;
  for (;;) {
    SPACE_OR_COMMENT.lastIndex = index;
    const space = SPACE_OR_COMMENT.exec(source);
    if (space) index += space[0].length;
    const end = importEnd(source, index);
    if (end === null) break;
    index = end;
  }
  const header = source.slice(0, index);
  const body = source.slice(index);
  const exports = body.match(/^export\s/gm) ?? [];
  const defaults = body.match(/^export default\s/gm) ?? [];
  if (exports.length !== 1 || defaults.length !== 1) return PRAGMA + source;
  return (
    PRAGMA +
    header +
    "export function createConfiguratorSpec() { " +
    body.replace(/^export default\s/m, "return ") +
    "\n}\nexport default createConfiguratorSpec();\n"
  );
}

/** The Vite plugin; add it before the React plugin. */
export function configuratorSpecs(): VitePlugin {
  const runtime = decodeURIComponent(new URL("./runtime.tsx", import.meta.url).pathname);
  const options = `${packagesDir()}gatekeeper-configurator-ui/src/runtime/options.ts`;
  return {
    name: "crm:configurator-specs",
    enforce: "pre",
    config: () => ({
      resolve: {
        alias: [
          {
            find: /^@relationship-os\/gatekeeper-configurator-ui$/,
            replacement: /^\/[A-Za-z]:\//.test(runtime) ? runtime.slice(1) : runtime,
          },
          { find: /^@relationship-os\/gatekeeper-configurator-ui\/options$/, replacement: options },
        ],
      },
    }),
    resolveId(id) {
      return id.startsWith(SPEC_PREFIX)
        ? configuratorSpecPath(id.slice(SPEC_PREFIX.length))
        : undefined;
    },
    transform(code, id) {
      const [file = "", query = ""] = id.split("?");
      // `?raw` and the like load the file as something other than a module.
      if (/(?:^|&)(?:raw|url|inline|worker)\b/.test(query)) return undefined;
      if (!SPEC_FILE.test(file.replaceAll("\\", "/"))) return undefined;
      return { code: transformConfiguratorSpec(code), map: null };
    },
  };
}
