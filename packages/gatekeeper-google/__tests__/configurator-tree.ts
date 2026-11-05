// Vendored from cloudflare/cloudflare-os@a3ba4746b58f packages/gatekeeper-google/__tests__/configurator-tree.ts (Apache-2.0). Modified locally: see UPSTREAM.md in this package.
// Reads the tree a configurator renders through a mocked `@relationship-os/gatekeeper-configurator-ui`, whose `h`
// returns `{ component, props, children }`.

export type Node = { component: unknown; props: Record<string, any>; children: unknown[] };

/** Every node in `tree`, depth first. */
export function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("component" in tree)) return [];
  const node = tree as Node;
  return [node, ...nodes(node.children)];
}

/** The text `tree` renders. */
export function text(tree: unknown): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object" && "children" in tree) return text((tree as Node).children);
  return "";
}
