import { createFileRoute } from "@tanstack/react-router";
import { PageLayout } from "#/components/layout/page-layout";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  return (
    <PageLayout title="Home" width="md">
      <p className="text-muted-foreground">Nothing here yet.</p>
    </PageLayout>
  );
}
