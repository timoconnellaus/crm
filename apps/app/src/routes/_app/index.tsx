import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
      <p className="mt-2 text-muted-foreground">Nothing here yet.</p>
    </div>
  );
}
