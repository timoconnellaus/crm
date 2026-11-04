import { createRouter } from "@tanstack/react-router";
import { createQueryClient } from "./lib/query.ts";
import { routeTree } from "./routeTree.gen.ts";

/**
 * View transitions between pages, where the browser supports them and the user has not asked for
 * reduced motion. Only path changes animate: a filter or tab change (a search-param replace)
 * swaps in place. Browsers without view-transition types would animate every navigation, so
 * they get none.
 */
function viewTransition() {
  if (typeof window === "undefined" || typeof document.startViewTransition !== "function") {
    return false;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  if (!window.CSS?.supports?.("selector(:active-view-transition-type(page))")) return false;
  return {
    types: ({ pathChanged }: { pathChanged: boolean }) => (pathChanged ? ["page"] : false),
  } as const;
}

export function getRouter() {
  // One QueryClient per page load (and per server render). Route loaders prefetch into it on
  // hover (intent preloading); components read it with useQuery.
  const queryClient = createQueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    // Scroll regions are the app's own (PageLayout, DataTable), restored per history entry by
    // useScrollMemory; the window never scrolls.
    scrollRestoration: false,
    defaultPreload: "intent",
    // Preloading only warms the query cache; TanStack Query decides freshness.
    defaultPreloadStaleTime: 0,
    defaultViewTransition: viewTransition(),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
