// The wire format between a workspace and the hosted marketplace (ADR 0347). Both ends read these
// schemas. Every call is authenticated: a hosted deployment signs it (ADR 0250), a self-hosted one
// sends its workspace token as a bearer token. Only reviewed listings are ever returned.
import { z } from "zod";
import { pluginListingSchema, pluginManifestSchema } from "./manifest.ts";

export const MARKETPLACE_LISTINGS_PATH = "/api/marketplace/listings";
export const MARKETPLACE_SUBMISSIONS_PATH = "/api/marketplace/submissions";

export const marketplaceSearchResultSchema = z.object({ listings: z.array(pluginListingSchema) });
export type MarketplaceSearchResult = z.infer<typeof marketplaceSearchResultSchema>;

export const marketplaceListingResultSchema = z.object({
  listing: pluginListingSchema,
  manifest: pluginManifestSchema,
});
export type MarketplaceListingResult = z.infer<typeof marketplaceListingResultSchema>;

export const marketplaceSubmissionSchema = z.object({
  manifest: pluginManifestSchema,
  note: z.string().trim().max(1_000).optional(),
});
export type MarketplaceSubmission = z.input<typeof marketplaceSubmissionSchema>;

export const SUBMISSION_STATUSES = ["in_review", "approved", "rejected"] as const;
export const marketplaceSubmissionResultSchema = z.object({
  id: z.string(),
  status: z.enum(SUBMISSION_STATUSES),
  reason: z.string().nullable().default(null),
});
export type MarketplaceSubmissionResult = z.infer<typeof marketplaceSubmissionResultSchema>;

/** What a workspace needs from the marketplace; the host supplies the transport. */
export interface MarketplaceClient {
  search(input: { query?: string | undefined }): Promise<MarketplaceSearchResult>;
  /** A listing with its reviewed manifest; null when there is none. */
  get(id: string): Promise<MarketplaceListingResult | null>;
  submit(submission: MarketplaceSubmission): Promise<MarketplaceSubmissionResult>;
  submission(id: string): Promise<MarketplaceSubmissionResult | null>;
}
