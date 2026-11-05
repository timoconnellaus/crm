// The demo's five steps: the tab label, the tab's one-line summary, and the description the live
// region reads out (the app picture itself is decorative).
export const DEMO_STEPS = [
  {
    name: "Ask",
    tagline: "Answers from your customer data",
    description: "Ask: the assistant lists customers with no contact in 60 days.",
  },
  {
    name: "Shape",
    tagline: "New fields when you need them",
    description: "Shape: a new Renewal date field appears on organisations as a pending preview.",
  },
  {
    name: "See",
    tagline: "Dashboards from a sentence",
    description: "See: a dashboard chart is created from a one-line description.",
  },
  {
    name: "Automate",
    tagline: "Tested before they go live",
    description:
      "Automate: a follow-up automation is drafted and test-run without changing anything.",
  },
  {
    name: "Approve",
    tagline: "Every change reviewed first",
    description: "Approve: the change set is approved and applied.",
  },
] as const;
