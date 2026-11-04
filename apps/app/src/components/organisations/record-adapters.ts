// Organisation-page data, in one place. Timeline, tasks and history reuse the record adapters
// (`#/components/record/adapters`) unchanged; these thin wrappers call them for an organisation
// so the page does not depend on how those adapters take their record.
// TODO(stage-1-merge): the record adapters are becoming `(object, id)`; when they do, call them
// directly here (or from the page) and delete the wrappers.
import type { CoreOutput } from "@crm/core";
import {
  type AdapterResult,
  type RecordRef,
  useCreateActivity,
  useRecordHistory,
  useRecordTasks,
  useTaskActions,
  useTimeline,
} from "#/components/record/adapters";
import { useOp } from "#/lib/query";

const ref = (id: string): RecordRef => ({ object: "organisation", id });

export const useOrganisationTimeline = (id: string) => useTimeline(ref(id));
export const useOrganisationComposer = (id: string) => useCreateActivity(ref(id));
export const useOrganisationTasks = (id: string) => useRecordTasks(ref(id));
export const useOrganisationTaskActions = (id: string) => useTaskActions(ref(id));
export const useOrganisationHistory = (id: string) => useRecordHistory(ref(id));

export type OrganisationAffiliation = CoreOutput<"affiliation.list">["items"][number];

/** An organisation's people: current affiliations first, then past ones (affiliation.list). */
export function useOrganisationPeople(id: string): AdapterResult<OrganisationAffiliation[]> {
  const query = useOp("affiliation.list", { organisationId: id, limit: 500 });
  return { data: query.data?.items ?? [], isPending: query.isPending, wired: true };
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
    wired: true,
  };
}
