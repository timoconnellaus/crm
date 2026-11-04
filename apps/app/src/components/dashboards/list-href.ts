// Where a click-through lands: the object's own list page with the filter in the URL (people,
// organisations, tasks' All tab, Activity, or an extension object's list).
import type { Filter } from "@crm/core/client";
import type { useNavigate } from "@tanstack/react-router";

type Navigate = ReturnType<typeof useNavigate>;

export function openFilteredList(navigate: Navigate, object: string, filter: Filter | null) {
  const search = filter ? { filter } : {};
  switch (object) {
    case "person":
      return navigate({ to: "/people", search });
    case "organisation":
      return navigate({ to: "/organisations", search });
    case "task":
      return navigate({ to: "/tasks", search: { tab: "all", ...search } });
    case "activity":
      return navigate({ to: "/activity", search });
    default:
      return navigate({ to: "/x/$object", params: { object }, search });
  }
}
