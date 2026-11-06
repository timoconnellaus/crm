// @relationship-os/agent-a2ui (ADR 0346, ADR 0350): A2UI cards for an assistant. The schema, the
// catalogue registry and its versioning, text fallbacks and the React renderer arrive in stage 17's
// W6. Until then this is the package's home, and it imports nothing outside the allowed set.

/** The catalogue version this package will render. Bumped when W6 lands the catalogue. */
export const A2UI_CATALOGUE_VERSION = 0;
