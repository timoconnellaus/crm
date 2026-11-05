// What the in-app assistant was looking at when asked (ADR 0200): the page, its record and a list
// selection. Browser-safe (zod only): the UI builds it, the server validates it.
import { z } from "zod";

export const assistantContextSchema = z.object({
  path: z.string().max(500).describe("The app path the person is on, e.g. /people/per_…"),
  title: z.string().max(200).optional().describe("The page's title"),
  record: z
    .object({
      object: z.string().max(100),
      id: z.string().max(100),
      label: z.string().max(200).optional(),
    })
    .optional()
    .describe("The record the page shows"),
  selection: z
    .object({
      object: z.string().max(100),
      ids: z.array(z.string().max(100)).min(1).max(200),
      labels: z.array(z.string().max(200)).max(200).optional(),
    })
    .optional()
    .describe("Records selected in a list"),
});
export type AssistantContext = z.infer<typeof assistantContextSchema>;
