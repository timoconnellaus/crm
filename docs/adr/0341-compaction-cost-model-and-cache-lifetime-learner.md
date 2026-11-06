# ADR 0341: Compaction is decided by a cost model, with a learned cache lifetime

Status: Accepted (2026-11-06). Stage 17 spec: [`docs/stages/17-assistant.md`](../stages/17-assistant.md),
W2. Builds on [ADR 0340](0340-one-assistant-thread-per-user.md) and the prices in
[ADR 0351](0351-assistant-model-roles.md).

## Context
A thread that never resets (ADR 0340) must be compacted: older messages are folded into a short
"where we left off" note and stay searchable. Compacting too early throws away useful context and
pays for a summary call; compacting too late pays for a long prompt on every turn and eventually
overflows the window. Most providers cache a stable prompt prefix and charge much less for cached
input, but only while the cache entry lives. Compaction rewrites the prefix, so the next turn pays
the full price once. Whether compacting saves money depends on prices, on how long the cache
lives and on how the person uses the chat.

Some providers publish a cache lifetime; many do not, or change it without notice. Cache hits are
also noisy: a single miss can come from load balancing or eviction, not from expiry.

The user decided: compaction is cost-based, between hard rails of 24k tokens and 80% of the
model's window; the cache lifetime comes from provider config or is learned from cache hits; the
learner is robust to outliers ("a 10 s miss in a 15 min cache must not move it"); after compaction
the last ~10 exchanges, the note and memory stay live. Both parts are pure code with unit tests.

## Decision

### Context layout
The prefix stays byte-stable across turns: system instructions, tool definitions, the memory block,
the compaction note, then messages since the compaction. Everything that changes per turn goes in
the **tail**: pending memory lines, page context, device and display facts, then the new message.
A test asserts the prefix hash is unchanged between turns.

### The planner (`agent-core/compaction/plan.ts`, pure, no I/O)
Inputs:
- `C`: the current context size in tokens. `C'`: the size after compaction (prefix, note, the last
  ~10 exchanges), estimated from the messages it would keep plus a note budget.
- Prices per token for the role's model (ADR 0351): `p_in` uncached input, `p_w` cache write,
  `p_r` cached read, `p_out` output. A provider without a separate write price has `p_w = p_in`.
  Unknown prices mean cached is treated as uncached: `p_r = p_w = p_in`.
- `L`: the cache lifetime estimate in seconds, with its source (published, learned or fallback).
- The person's reply-gap distribution and turns per session, learned per user over the same gap
  buckets as the learner, with the same decay. `q = P(gap ≤ L)` is the chance the next turn finds
  the cache warm. `N` is the horizon: the expected turns left in this session, at least 1, at most
  20. A gap over 70 minutes ends a session.
- `Δ`: the expected tokens added per turn (message, reply, tool results), and `o`: expected output
  tokens per turn, both decayed per-user means. `s`: the note's output budget.
- `W`: the model's context window. Rails: `minTokens` (24,000) and `maxShareOfWindow` (0.8),
  admin settings.

Expected input cost of one turn whose reusable prefix is `X` tokens:

```
turn(X) = q·X·p_r + (1 − q)·X·p_w + Δ·p_w + o·p_out
```

(a) **Continue** over the horizon, the context growing by `Δ` a turn:

```
A = Σ_{k=0}^{N−1} turn(C + k·Δ)
```

If `C + k·Δ` would cross `maxShareOfWindow·W` inside the horizon, `A` includes the forced
compaction at that turn, priced as in (b).

(b) **Compact now.** One summary call reads the context while it is warm at `p_r` (cold: `p_in`)
and writes the note; the first turn after writes the new prefix once; later turns run on the
smaller context:

```
S = C·p_r + s·p_out                     (warm; C·p_in + s·p_out when cold)
B = S + (C'·p_w + Δ·p_w + o·p_out) + Σ_{k=1}^{N−1} turn(C' + k·Δ)
```

Decision, in order:
1. `C < minTokens`: never compact.
2. `C + Δ ≥ maxShareOfWindow·W`: compact now, whatever the cost.
3. Otherwise compact only when `B < A`. Ties continue.

With a very large window the ceiling is far away, so cost decides first.

### The idle alarm
When a turn ends and `C ≥ minTokens`, the object sets one alarm at
`lastRequest + L − margin`, with `margin = max(30 s, 0.05·L)`. When it fires and no turn has
arrived, the planner compares the next session starting cold on `C` (its first turn at `p_in`)
against compacting now while warm (`S` at `p_r`) and starting the next session on `C'`. It compacts
only if that is cheaper. A new turn cancels the alarm. Before there is data (no learned or
published lifetime), the fallback is to compact after 10 minutes idle when `C` is over 24k tokens.

### Compaction while a turn arrives
Compaction summarises messages up to a sequence number `s0`. A turn that arrives meanwhile is
answered against the pre-compaction context. The compaction then completes and re-bases: messages
after `s0`, the new turn included, become "messages since the compaction". Pending memory lines are
folded into the memory block (ADR 0342).

### The cache-lifetime learner (`agent-core/compaction/cache-lifetime.ts`, pure)
- **Observation**: `(provider, model, gapSeconds, prefixUnchanged, cachedTokens, promptTokens)`
  from each response's usage. `gapSeconds` is the time since the last request in this thread with
  the same prefix. Only observations with an unchanged prefix count; a changed prefix explains its
  own miss. An observation is a **hit** when `cachedTokens ≥ 0.5 ×` the unchanged prefix tokens,
  otherwise a **miss** (providers cache in blocks, so a hit is rarely the whole prefix).
- **Gap buckets** with upper edges 30 s, 2 min, 5, 10, 20, 40, 70 min and one bucket for 70 min
  and over.
- **Beta posteriors.** Each bucket `b` holds `Beta(α_b, β_b) = Beta(α0_b + h_b, β0_b + m_b)`, where
  `h_b` and `m_b` are decayed hit and miss counts. With a published lifetime `L0` the prior has
  strength 20 pseudo-observations: buckets entirely below `L0` get 95% of it as hits, buckets
  entirely above it 95% as misses, and the bucket containing `L0` an even split. Without one the
  prior is the weak default `Beta(0.5, 0.5)` in every bucket.
- **Decay**: counts are multiplied by `2^(−Δt / 14 days)` before each update, so old evidence
  fades toward the prior with a half-life of about 14 days.
- **Monotone fit.** A longer gap can never hit more often than a shorter one. Pool Adjacent
  Violators over the posterior means `α_b / (α_b + β_b)`, weighted by `α_b + β_b`, gives a
  non-increasing fitted hit rate. Each pooled block has the posterior `Beta(Σα, Σβ)` of its
  buckets, and every bucket in a block shares it.
- **Confident buckets.** `LB_b` and `UB_b` are the 5th and 95th percentiles of bucket `b`'s block
  posterior. The candidate `c` is the largest `b` with `LB_j ≥ 0.9` for every `j ≤ b`. The
  estimate is always the upper edge of a bucket, never a value inside one, so it errs short: a
  bucket that straddles the expiry is never confident.
- **Moving only on consistent evidence.** The stored estimate `L̂` rises to `c` whenever `c` is
  longer. It falls only when the bucket at `L̂` is confidently below the bar (`UB < 0.9`), and then
  to `c`, the shorter plausible value. Between the two it stays where it is.
- **Little data**: until some bucket is confident there is no learned estimate. The planner then
  uses the published lifetime if there is one; otherwise it treats the cache as cold (`q = 0`) and
  the idle alarm uses the 10-minute fallback.
- **A published lifetime always overrides** the learned estimate. The learner still runs, so a
  drift from the published value can be shown.
- Estimates are stored per workspace, provider and model in `core_ai_cache_estimate`, updated as
  turns finish (in the turn's existing write, never per token), and shown read-only in Settings →
  AI with their source and sample size.

### Robustness requirement
A single miss must not move the estimate; a real change must, after consistent evidence. These
rules were simulated while writing this ADR. 120 observations from a 15-minute cache at mixed gaps
give `L̂` = 10 minutes (the 10 to 20 minute bucket straddles the expiry, so it is never confident).
A miss at 10 s then leaves `L̂` at 10 minutes: the monotone fit pools the 0 to 30 s bucket with
the longer-gap buckets full of hits, the block's lower bound stays above 0.9, and its upper bound
is nowhere near 0.9. Three misses at about 8 minutes also leave it at 10. After a lifetime learned
in the 40 to 70 minute bucket, the provider's cache drops to 5 minutes: five misses at gaps of 7
to 50 minutes push the upper bound below 0.9 and `L̂` falls to 10 minutes, and further hits and
misses settle it at 5. A plain "last observation wins" rule or a hard threshold on the raw hit
rate would have failed the first case.

### Required unit tests
The 10-second stray miss in a 15-minute cache; a real change from 60 to 5 minutes followed after
consistent evidence; no data; a published value overriding; changed-prefix misses ignored; the
planner at warm and cold cache, with cheap and expensive cached reads, at the 24k floor and the
80% ceiling, and with a very large window where cost decides first.

## Why
- Prices and cache lifetimes differ by an order of magnitude between providers; a fixed threshold
  is wrong for most of them.
- A pure function of numbers is easy to test exhaustively and to explain.
- Beta posteriors with a monotone constraint and a lower-bound threshold are the smallest model
  that ignores single outliers, follows real change and falls back cleanly with no data. Separate
  bars for rising (lower bound) and falling (upper bound) give the hysteresis the user asked for.

## Consequences
- The registry must carry cache prices and published lifetimes (ADR 0351).
- The constants above (bucket edges, prior strengths, the 0.9 bar, the 5th and 95th percentiles, the
  half-life, the horizon cap) live in code beside the tests. The two rails are admin settings.
- Compaction loses detail, which no price captures; the 24k floor and keeping the last ~10
  exchanges limit that. Older detail is still reachable with `thread.search`.

## Alternatives considered
- **Compact at a fixed token count or a fixed idle time.** Rejected: wrong for most price and cache
  combinations. Kept only as the fallback before there is data.
- **Trust published lifetimes only.** Rejected: many providers publish none.
- **Use the last observed hit or miss.** Rejected: one stray miss would move it, which the user
  ruled out.
- **A logistic fit of hit rate against gap.** Considered. It needs more data to be stable and its
  confidence is harder to explain than per-bucket posteriors.
