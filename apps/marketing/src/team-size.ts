// The waitlist's optional team-size question and the page's two waitlist forms. The form markup and
// the endpoint's validation both read these lists, so the two can't drift apart.
export const TEAM_SIZES = [
  { value: "just-me", label: "Just me" },
  { value: "2-10", label: "2 to 10" },
  { value: "11-50", label: "11 to 50" },
  { value: "51-plus", label: "More than 50" },
] as const;

export type TeamSize = (typeof TEAM_SIZES)[number]["value"];

export const TEAM_SIZE_VALUES = TEAM_SIZES.map((size) => size.value) as [TeamSize, ...TeamSize[]];

/** The landing page's waitlist forms. A browser that posts without JavaScript is sent back to its own. */
export const FORM_SOURCES = ["hero", "waitlist"] as const;
export type FormSource = (typeof FORM_SOURCES)[number];

/** The id of a form's "You're on the list" message, which a no-JavaScript submission lands on. */
export const joinedAnchor = (source: FormSource) => `joined-${source}`;
