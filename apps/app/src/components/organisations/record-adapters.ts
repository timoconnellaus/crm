// Organisation-page data the generic record adapters (`#/components/record/adapters`) don't
// cover: its people (current and past affiliations) and its child organisations. Timeline,
// composer, tasks and history come straight from the generic adapters with
// `("organisation", id)`.
import {
  type AdapterResult,
  type AffiliationItem,
  useAffiliations,
} from "#/components/record/adapters";
import { useOp } from "#/lib/query";

export type OrganisationAffiliation = AffiliationItem;

/** An organisation's people: current affiliations first, then past ones (affiliation.list). */
export function useOrganisationPeople(id: string): AdapterResult<OrganisationAffiliation[]> {
  return useAffiliations("organisation", id, { limit: 500 });
}

export interface ChildOrganisation {
  id: string;
  name: string;
  primaryDomain: string | null;
}

/** Live organisations whose parent is `id`. */
export function useChildOrganisations(id: string): AdapterResult<ChildOrganisation[]> {
  const query = useOp("organisation.list", {
    filter: { field: "parentId", op: "eq", value: id },
    limit: 100,
    fields: ["name", "primaryDomain"],
  });
  return {
    data: (query.data?.items ?? []).map((o) => ({
      id: o.id,
      name: o.name ?? o.id,
      primaryDomain: o.primaryDomain ?? null,
    })),
    isPending: query.isPending,
    error: query.error,
  };
}
