import { Toaster } from "@relationship-os/ui/components/sonner";
import { TooltipProvider } from "@relationship-os/ui/components/tooltip";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { THEME_INIT_SCRIPT, ThemeProvider, useTheme } from "../components/theme.tsx";
import appCss from "../styles.css?url";

/** What every route's loader gets: the page's QueryClient (see router.tsx). */
export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Relationship OS" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => <Outlet />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap script. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="min-h-svh font-sans antialiased">
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </QueryProvider>
          <ThemedToaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

/** The router's QueryClient (one per page load), which route loaders also prefetch into. */
function QueryProvider({ children }: { children: ReactNode }) {
  const { queryClient } = useRouter().options.context as RouterContext;
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" closeButton />;
}
