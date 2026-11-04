// CSV import (`/import?object=person|organisation`), reachable from the People and Organisations
// list menus and the command palette.
import { createFileRoute } from "@tanstack/react-router";
import { type ImportObject, ImportWizard } from "#/components/import/import-wizard";

export const Route = createFileRoute("/_app/import")({
  validateSearch: (search: Record<string, unknown>): { object?: ImportObject } =>
    search.object === "person" || search.object === "organisation" ? { object: search.object } : {},
  component: ImportPage,
});

function ImportPage() {
  const { object } = Route.useSearch();
  // Keyed so a menu link to the other object starts a fresh wizard.
  return <ImportWizard key={object ?? "person"} initialObject={object ?? "person"} />;
}
