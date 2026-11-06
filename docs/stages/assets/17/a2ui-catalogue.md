# A2UI catalogue for the assistant

Built in stage 17 W6: `packages/agent-a2ui/src/catalogue.ts` is the source of truth, and ADR 0346's amendment records where the build differs from this page.

The assistant (and routines, plugins, other agents) can send rich messages as **A2UI JSON**. The app renders them **only from this catalogue**, using our own shadcn components. No model-written code runs, and every button calls an **operation**, so the normal permissions and approval rules always apply. Each rich message is stored in the thread with a **text fallback**, so the model can still say "the second task" later.

## Where A2UI comes from
1. **The model writes it** for one-off answers ("show me my open tasks").
2. **Saved A2UI producers in plugins.** A plugin ships a saved Code Mode script, run on a stable worker ID so it's cached and cheap, that queries the CRM and returns A2UI JSON with no model involved. Routines and the assistant call it by name, for example `pipeline.staleDealsCard({ days: 14 })`. This is faster, cheaper and the same every time.
3. **The host itself**, for system flows: approvals, routine read-backs, memory saves, plugin updates, agent-to-agent requests.

## Building blocks (primitives)
| Component | Use |
| --- | --- |
| Text / Markdown | Paragraphs, emphasis, links to records |
| Heading, Divider | Structure inside a card |
| Key-value list | "Owner: Maya · Stage: Proposal · Value: $12k" |
| Badge / Status pill | Stage, priority, "pending", "overdue" |
| Avatar / Record chip | A person, organisation or deal as a clickable chip |
| List | A plain or numbered list of items |
| Table | Small tables (≤ 20 rows) with sortable columns and a "view all" link to the real view |
| Buttons / Quick replies | Up to ~4 actions; each calls an operation or opens a page |
| Link | To a record, view, dashboard or external URL (allow-listed) |
| Image | Logos, avatars, chart images from our own storage only |
| Progress | A long-running job, such as an import or bulk update |
| Empty state | "Nothing due today", with one suggested action |

## Records and data
| Component | Shows | Actions |
| --- | --- | --- |
| Record card | Person, organisation, deal or custom object; key fields; owner | Open, Edit, Create task, Log activity |
| Record list | A filtered set of records with 2–3 columns | Open each, Bulk action (→ change set), View all |
| Record diff / change preview | What a change will do, before and after | Approve, Edit, Discard |
| Search results | Hybrid search hits grouped by type, with "matched by meaning or text" | Open, Refine |
| Related records | The people at an organisation, the deals for a person | Open |

## Tasks and activities
| Component | Shows | Actions |
| --- | --- | --- |
| Task list | Due or overdue tasks with checkboxes | Complete, Snooze (presets), Reassign, Open |
| Task card | One task with notes and the linked record | Complete, Edit, Snooze |
| Timeline excerpt | Recent notes, calls, emails and meetings on a record | Open, Reply, Log follow-up |
| Email preview | A received email (subject, snippet, sender chip) | Reply (opens the draft), Open thread, Create task |
| Email draft | A draft written by the AI, editable inline | Send (→ outbound approval), Edit, Discard, Schedule |
| Call or note logger | A quick form to log a call or note | Save |

## Deals and pipeline
| Component | Shows | Actions |
| --- | --- | --- |
| Deal card | Stage, value, close date, days in stage, last activity | Move stage, Create task, Open |
| Deal list (e.g. no activity for N days) | Deals with plain facts (days since activity) | Create follow-up tasks, Open, Snooze |
| Pipeline snapshot | Counts and value per stage (mini bar) | Open board |
| Stage move confirm | Required fields for the target stage | Confirm (→ operation) |

## Calendar and meetings
| Component | Shows | Actions |
| --- | --- | --- |
| Meeting card | Time, attendees (chips), linked organisation and deals | Open prep, Join link, Log notes |
| Meeting prep | Attendees, recent activity, open deals and tasks, AI summary (Jev-checked) | Create task, Open records |
| Availability slots | A few free times, for scheduling | Pick a slot → draft an invite (approval) |

## Charts and numbers
| Component | Shows |
| --- | --- |
| KPI tile | One number with a period comparison (plain facts, no scores) |
| Bar, line or funnel chart | Small chart from a widget definition; "Open in dashboard" |
| Leaderboard | Top N by a measure |

These reuse the dashboard widget renderers, so a chart in chat equals a widget.

## Forms and input
| Component | Use |
| --- | --- |
| Record form | Create or edit a record; submits as an operation, so a change set where review applies |
| Generic form | Fields from the catalogue (text, number, date, select, user picker, record picker) for skills and plugins |
| Choice / Quick reply | Single or multiple choice to answer the assistant |
| Confirm | A yes/no with consequences spelled out (destructive actions) |
| File upload | Attach a file to a record (R2), for example a CSV for import |

## Assistant system flows (host-rendered)
| Component | Use | Actions |
| --- | --- | --- |
| Approval card | A pending change set: diff, reason, and "Agent's reason" shown separately | Approve, Reject, Review |
| Routine read-back | "Every weekday at 8am I'll…" with trigger, gates (plain plus Jev), and the **backtest** (fired N times in 30 days, examples that pass and fail) | Turn on, Edit, Cancel |
| Routine list | Your routines, with status, last run and next run | Pause, Edit, Delete, Test |
| "Why this?" panel | Routine, trigger, the checks that passed and the Jev check | Pause routine, Edit, Not useful |
| Memory saved | "Saved to memory", with the line and its condition if any | Undo, Edit |
| Conditional memory read-back | "When on an organisation with > 500 employees: …" | Confirm, Edit |
| Plugin install | What it adds (skills, saved code, routines, connections), the scopes and needed extensions | Install, Cancel |
| Plugin update / merge | Upstream changes and your edits, with the AI's merged proposal as a diff | Apply, Keep mine, Review |
| Connection needed | "This needs your Gmail", with status | Connect (sign in) |
| Agent connection request | "Sam wants to connect assistants", with the proposed rules | Accept, Decline, Edit rules |
| Agent request | "Sam's agent asks: create a task for Acme follow-up" | Accept, Decline, Ask Sam |
| Agent-to-agent log entry | What was shared, under which rule, and its Jev verdict | Open log |

## Stage 12–16 flows (when built)
| Component | Use |
| --- | --- |
| Import mapping preview | Detected files and links, column mapping, and the choice for matching records |
| Import progress / result | Rows created, updated and skipped, with Undo import |
| Duplicate suggestion | Two or more records with the match reason (same email, domain, phone or name) and the survivor; Merge or Not duplicates |
| Lead card | Status, source, owner; Convert to deal, Reassign |
| Sequence card | Steps, enrolment, replies; Approve version, Pause, Enrol |

## Rules for every component
- Every action is an **operation call** with the user's permissions. Nothing bypasses approvals.
- Data shown respects **visibility** (stage 14). A producer can't render a record the viewer can't see, and hidden linked records show title only, as decided.
- Every component has a **text fallback** stored with the message.
- Accessible: keyboard operable, labelled, and works in the narrow docked panel and on a phone.
- Unknown or invalid A2UI from a model is shown as its text fallback, never rendered blindly.
- The catalogue is **versioned**. Plugins declare the catalogue version they target.
