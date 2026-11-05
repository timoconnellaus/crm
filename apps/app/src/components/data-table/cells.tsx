// Default cell rendering by field type, used by DataTable when no custom renderer is given.
import type { FieldDefinition } from "@relationship-os/core/client";
import { Badge } from "@relationship-os/ui/components/badge";
import { formatDate, formatDateTime, formatValue } from "#/lib/format";

export function DefaultCell({ field, value }: { field: FieldDefinition; value: unknown }) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  ) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (field.name === "tags" && Array.isArray(value)) {
    return (
      <span className="flex gap-1">
        {value.slice(0, 3).map((tag) => (
          <Badge key={String(tag)} variant="secondary">
            {String(tag)}
          </Badge>
        ))}
        {value.length > 3 && <span className="text-muted-foreground">+{value.length - 3}</span>}
      </span>
    );
  }
  if (field.type === "datetime" && typeof value === "string") {
    return <time dateTime={value}>{formatDateTime(value)}</time>;
  }
  if (field.type === "date" && typeof value === "string") {
    return <time dateTime={value}>{formatDate(value)}</time>;
  }
  return <>{formatValue(value)}</>;
}
