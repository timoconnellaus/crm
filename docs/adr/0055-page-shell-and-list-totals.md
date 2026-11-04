# ADR 0055: Page shell, infinite lists and capped list totals

Status: accepted, 2026-11-04 (modern-UI sweep).

## Decision
- **One scroll region per page.** The signed-in shell is viewport-high (`h-dvh`, safe-area
  insets) and the window never scrolls. Every page renders `PageLayout`: a fixed header (title,
  live count, actions, tabs, filters) over a body that is the page's only vertical scroller. A
  table or a record page's panels may take the body over and scroll themselves (`scroll="none"`).
- **Lists are infinite and virtualised.** `DataTable` pages through the list operation's keyset
  cursor with `useInfiniteQuery` and renders rows with TanStack Virtual. The next page loads as
  the rendered range nears the end, never more than one request at a time. "Load more" is gone.
  Feeds that are not tables (Activity, Trash, the audit log) use `VirtualFeed`, and short lists
  (a record's timeline and history) load more through a sentinel.
- **Scroll positions are the app's own,** kept per history entry (`useScrollMemory`), so going
  back restores a list and a fresh visit starts at the top. The router's window-based scroll
  restoration is off.
- **List totals come from `record.count`,** a read operation that counts live records of any
  registry object matching the same filter JSON as its list operation. D1 bills rows read and
  `COUNT(*)` reads every match, so a count reads at most 10,000 rows (`capped` above that; the UI
  shows "10,000+"). The app fetches it once per object and filter, and caches it under the list
  operation's key so the invalidation after a write to that object refreshes it. Scrolling never
  recounts.
- **Select all matching** pages ids from the list operation (up to 1,000) and applies bulk
  actions through the batch operations, 100 ids per call.

## Why
Headers that scrolled away and "Load more" buttons made long lists slow to work with. A page with
one scroll region avoids nested-scroll traps on phones. Counting on every page or scroll would
multiply D1 reads; a capped count per filter keeps a total cheap and bounded.

## Consequences
- New pages use `PageLayout`; a page that does not still scrolls (the shell's main region is a
  fallback scroller) but loses the fixed header.
- Trash and the audit log have no total operation; their headers show the loaded count ("50+").
