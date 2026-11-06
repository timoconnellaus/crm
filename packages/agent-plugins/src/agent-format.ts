// Reads the open Agent Plugins format (ADR 0347): a folder with a plugin manifest, `skills/<name>/
// SKILL.md` files and an MCP server list. Skills become skill items. An MCP server becomes a
// connection need, for the host to wrap as a gatekeeper connection: nothing here connects to it.
// A server that runs a local command cannot run on a Worker, so it is left out and reported.
// Everything else in the format (commands, hooks, agents) has no meaning here and is reported too.
import { z } from "zod";
import type { PluginItem, PluginManifest } from "./manifest.ts";
import { pluginManifestSchema } from "./manifest.ts";

/** Where the format's manifest may sit. */
const MANIFEST_PATHS = [".plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"];
const MCP_PATHS = [".mcp.json", "mcp.json"];
const SKILL_PATH = /^skills\/([^/]+)\/SKILL\.md$/;
const IGNORED = /^(commands|agents|hooks|output-styles)\//;

const openManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().max(40).optional(),
  description: z.string().max(1_000).optional(),
  author: z.union([z.string(), z.object({ name: z.string() }).loose()]).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

const mcpFileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) });

const remoteServerSchema = z
  .object({ url: z.string().url(), type: z.string().optional() })
  .loose();

export interface AgentPluginLoad {
  manifest: PluginManifest;
  /** What could not come across, in plain words. */
  skipped: string[];
}

/** `---` frontmatter of simple `key: value` lines, then the body. */
export function parseSkillFile(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) {
      fields[pair[1] as string] = (pair[2] as string).trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { fields, body: (match[2] as string).trim() };
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const words = (name: string) => {
  const text = name.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function parseJson(path: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

function skillItem(folder: string, text: string): PluginItem {
  const { fields, body } = parseSkillFile(text);
  const name = fields.name || folder;
  return {
    kind: "skill",
    key: `skill-${slug(name)}`,
    label: words(name).slice(0, 120),
    ...(fields.description ? { description: fields.description.slice(0, 400) } : {}),
    body: {
      name: slug(name),
      description: (fields.description || words(name)).slice(0, 400),
      instructions: body,
    },
  };
}

/** Loads a plugin folder, given its text files by relative path. */
export function loadAgentPlugin(files: Readonly<Record<string, string>>): AgentPluginLoad {
  const path = MANIFEST_PATHS.find((p) => files[p] !== undefined);
  if (!path) throw new Error("No plugin manifest found");
  const open = openManifestSchema.parse(parseJson(path, files[path] as string));
  const skipped: string[] = [];
  const items: PluginItem[] = [];

  for (const [file, text] of Object.entries(files)) {
    const skill = SKILL_PATH.exec(file);
    if (skill) items.push(skillItem(skill[1] as string, text));
    else if (IGNORED.test(file)) skipped.push(`${file}: this app has no use for it`);
  }

  const mcpPath = MCP_PATHS.find((p) => files[p] !== undefined);
  const servers = {
    ...(mcpPath ? mcpFileSchema.parse(parseJson(mcpPath, files[mcpPath] as string)).mcpServers : {}),
    ...open.mcpServers,
  };
  const connections: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const remote = remoteServerSchema.safeParse(server);
    if (!remote.success) {
      skipped.push(`MCP server ${name}: it runs a local command, which cannot run here`);
      continue;
    }
    const service = `mcp:${slug(name)}`;
    connections.push(service);
    items.push({
      kind: "connectionNeed",
      key: `mcp-${slug(name)}`,
      label: words(name).slice(0, 120),
      body: {
        service,
        integration: "mcp",
        level: "workspace",
        reason: `The ${words(name)} tools come from this MCP server.`,
        server: { name, url: remote.data.url },
      },
    });
  }
  if (!items.length) throw new Error("This plugin has no skills or remote MCP servers to bring in");

  const author = typeof open.author === "string" ? open.author : open.author?.name;
  const manifest = pluginManifestSchema.parse({
    id: slug(open.name),
    name: words(open.name),
    version: /^\d+\.\d+\.\d+$/.test(open.version ?? "") ? open.version : "0.1.0",
    publisher: author || "Unknown",
    description: open.description || words(open.name),
    access: { connections },
    items,
  });
  return { manifest, skipped };
}
