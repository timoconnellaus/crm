# ADR 0320: Erase reaches every store

Status: accepted, 2026-11-05 (erase completeness). Amends ADR 0019.

## Context
ADR 0019 made `person.erase` and `organisation.erase` hard-delete the record and redact the audit
log, and its amendments added shared activities, pending actions, AI summaries, vectors and
assistant conversations. An audit of every store found personal data an erase still left behind,
or that sync collected again afterwards:

1. **R2 email bodies** (`email-bodies/<external key>`): bodies of deleted activities were never
   deleted, and bodies of shared activities were never scrubbed, though they are still served
   (`activity.body`) and summarised.
2. **Sync**: suggested contacts, signatures and job-change suggestions stayed, and the next sync
   pass matched and suggested the person's address again.
3. **Extension data**: side-table rows (`x_<ext>_person`) have no foreign key or trigger, relation
   fields (a deal participant) kept pointing at the erased id, and extension key-value state and
   run logs were not looked at.
4. **Automation run history and notifications** (kept 30 to 90 days): trigger diffs, step logs,
   reports, errors, run-record rows, notification titles, bodies and links, delivery details.
5. **Matching**: a person's former emails and phones were not terms; an organisation erase passed
   no terms at all.
6. **Integration storage**: gatekeeper action journals and caches inside the integration host's
   facets.
7. **Logs**: AI Gateway logged prompts; Workers Logs got error objects whose messages can quote
   record content.
8. **Short-lived stores** and **backups**, which an erase cannot reach.

## Decision

### Terms and names (`records/erase-subject.ts`)
- A person's terms are their ids, current and **former** emails, phone numbers (as stored, and as
  bare digits) and social profile URLs. Former values come from the person's own audit change rows
  (`emails[].email`, `phones[].number`, `socialProfiles[].url`, before and after), read before the
  erase redacts them.
- An organisation's terms are its ids, current and former **domains**, its **website** (as stored
  and without the scheme) and its **street lines** (`line1`, `line2`).
- Terms shorter than 6 characters are still dropped. Matching is case-insensitive substring
  matching, bound one term per `instr` (not a `json_each` join, which D1 bills once per term per
  scanned row).
- **Names** (a person's display, given and family names; an organisation's name) are matched as
  whole words, and only in rows known to be about the subject: a run whose record was the subject,
  extension rows whose relation pointed at them, assistant conversations that looked them up. A
  name is never replaced across the database.

### R2 email bodies: dropped, not rewritten
- Activities an erase deletes take their bodies with them.
- A **shared** activity (also about other records) keeps its scrubbed subject, snippet and
  payload, but loses its full body: `body_ref` becomes null. We drop rather than rewrite because an
  email body is mostly about its sender and recipients (greetings, signatures, quoted replies), and
  names are not matched in shared text, so a rewrite would leave the person's name and anything
  else that identifies them without an email or phone. A rewrite would also need an R2 write before
  the commit for every shared email. The cost is that other people's timelines show the snippet
  instead of the full email; erase is rare.
- **The deletion queue.** A D1 batch cannot reach R2, so migration 0330 adds
  `core_blob_deletion` and two triggers on `core_activity`: any delete of an activity with a body,
  and any update that clears or changes `body_ref`, queues the old key in the same batch. The erase
  drains the queue right after its commit; the 10-minute cron retries what is left
  (`runBlobDeletionCron`), up to 10 attempts per key. A key that an activity references again (the
  message synced anew) is dequeued without deleting. The triggers also cover the Trash purge, which
  left bodies behind before.

### Sync: the erased-address list
- `core_erased_address` holds `sha256:<hex>` of each erased person's addresses (current and
  former), never the address. Plain SHA-256 (as the assistant conversation index uses): a salt kept
  in the same database would not stop a targeted guess, and the hash must survive a restore to be
  re-applied from the erase log.
- `sync.ingest` looks each batch's addresses up by primary key (one query, about two rows read per
  address) and removes erased ones from senders, recipients, attendees, organisers and bounce
  reports before matching. A message from an erased sender also loses its snippet, body and
  signature; a meeting they organised loses its description. The removal is made on the call's
  input, so the ingest's own audit row never records the address either.
- An erase deletes the person's suggested contacts (by person id and address), signature rows and
  job-change suggestions, and scrubs other people's job-change evidence that mentions them.
- `erasure.addressStatus` (admin read) and `erasure.allowAddress` (human admin) check and remove an
  entry, for a person who comes back by consent. The address is redacted from the audit row.

### Extension data, generically
Through `core_extension_fields` and `core_extension_objects`, never per extension:
- side-table rows for the erased records are deleted;
- a row whose **required single relation** points at the subject exists only to relate to them (a
  deal participant) and is deleted, with its links, tags and search entry; any other relation is
  cleared (a many-relation loses only the erased ids) and the row's text fields lose the subject's
  terms and names;
- text, long text, email, phone and URL fields anywhere in extension tables that mention a term
  are scrubbed; a typed field (email, phone, URL) that mentions them is cleared;
- extension records' search titles follow;
- `core_extension_kv`: an entry whose key mentions them is deleted, other values are redacted;
- `core_extension_runs`: logs, operations and errors that mention them are redacted.

### Runs, notifications, events
- A run whose record was the subject (by `record_id` or `core_automation_run_records`) keeps only
  its trigger type (`{ type, erased: true }`), step names, kinds and statuses; its report, logs,
  values, operations and error message go, its record is cleared and its run-record rows deleted.
  The runner refuses to retry or replay it.
- Other runs that mention a term have the identifying entries dropped and mentioning strings
  replaced by `"[erased]"` whole (a log line, an error message), as an audit input is.
- Notifications that mention the subject (their id, a term, a link to them) or came from a run
  about them are deleted, including daily digests. Delivery records that mention them lose their
  detail.
- Integration events lose payload entries naming them; automation outbox messages that mention
  them are dropped.

### Failing closed and repeating
Everything above is queued in the erase's batch. External steps that must succeed run before the
commit: assistant conversations (ADR 0019 amendment) and the erase log (below). Post-commit steps
are queue-backed: R2 deletions (`core_blob_deletion`) and vectors (`core_embedding_queue`). Every
step is idempotent. The pipeline no longer queues embeddings for the erase's own record changes;
the erase queues only records that have a vector and clears queue rows for deleted records that
have none.

### Integration host storage (vendored)
Gatekeeper action journals, the MCP action store, the email-send history and provider caches live
in facet storage only vendored code can read, and `packages/gatekeeper-*`, `gatekeeper-kit` and
`mcp-shared` are not modified. `UPSTREAMS.md` (proposal V4) asks upstream for a facet
`eraseSubject({ terms, names })` RPC. Until then:
- the host's own state holds no mail content; sync error text has addresses masked
  (`syncErrorText`);
- the D1 mirrors of outbound actions (`core_pending_action`) are redacted by erase;
- retention inside the facets is documented in ADR 0019's amendment; disconnecting a connection
  deletes its facets and their storage, the complete remedy an admin has today.

### Logs
- **AI Gateway**: every call this code routes through the gateway with headers sends
  `cf-aig-collect-log-payload: false`, so the gateway keeps metadata, tokens and cost (what Settings
  → AI's usage reads) but not prompts or responses. Hosted Platform AI already did (ADR 0213
  amendment). We chose this over deleting matching logs on erase: the logs API cannot search
  content, and a prompt that was never stored needs no erase.
  **Not covered:** Workers AI called through the `AI` binding (the self-hosted default) cannot
  turn off payload logging alone; the binding's only option, `collectLog: false`, also drops the
  metadata usage is read from. Those prompts stay in the gateway's logs for as long as AI Gateway
  keeps them (the gateway is created with `collect_logs: true` and no log limit). See
  Consequences.
- **Workers Logs**: operation, MCP, assistant, pipeline-hook, outbox and runner cron failures are
  logged through `errorForLog`, which keeps the error's name, code and stack frames and masks
  email addresses and phone-like numbers. Logs carry ids, not record content.

### Backups and the erase log
- An erase writes an **erase log** entry to R2 (`erase-log/<at>-<uuid>.json`) before it commits:
  the hashes of the erased record ids and addresses and the time. R2 is outside D1 Time Travel.
- After any restore, `erasure.reapply` (human admin) reads the log, hashes live record ids to find
  ones that were erased, erases them again and restores the erased-address list. `allow` entries
  written by `erasure.allowAddress` are replayed in order, so consent survives a restore too.
- Without blob storage (tests, scripts) no log is written; ros-app always binds `BLOBS`.

## Consequences
- An erase now touches more tables, and scans the free-text ones (audit, activities, tasks, runs,
  notifications, events, extension tables). On the rows-read seed it reads about 0.6 rows per row
  of those tables (`erase-rows-read.test.ts` holds it under 1.0). Sync's added check is one
  indexed query per batch.
- Shared emails lose their full body when someone in them is erased.
- A name in free text that is not known to be about the subject (a note about a meeting, a run
  that only names them) is still not found, as ADR 0019 says.
- **For the user to decide:** whether self-hosted Workers AI calls should also stop gateway
  logging (`collectLog: false` on the binding, losing per-role usage for Workers AI calls), or move
  to Workers AI's REST endpoint with an API token so payload logging can be turned off alone, as
  hosted does.

> **Amended 2026-11-06 (user decision): a narrower organisation erase.** "Shared emails lose their
> full body when someone in them is erased" stays true for a **person** erase, unchanged. An
> **organisation** erase drops an email's full body only when **no person is linked** to that
> email (`core_activity_links`, object `person`). When a person is still on it, the email is
> theirs as much as the organisation's, so the body is kept:
> - **R2 rewrite.** Before the commit, the body is read from R2, the organisation's terms (domains,
>   website, street lines, current and former; the same terms as everywhere else) are replaced with
>   `[erased]`, and it is written back under the same key; `body_ref` stays. Like the erase log,
>   the write happens before the D1 batch: if the batch then fails, the body is already scrubbed and
>   a retry finds nothing to change. A simulation reads and writes nothing.
> - **Snippet only** when the body cannot be rewritten (no blob storage, the object is missing or
>   unreadable, the write fails): `body_ref` is cleared and the body queued for deletion, as for a
>   person, keeping the scrubbed snippet. Never a kept body that was not scrubbed.
> - The subject, snippet and payload are scrubbed as before; the organisation's own data and links
>   go as before; emails linked only to it are deleted as before.
> - The organisation's **name** is not matched in a kept body, as in snippets and other shared text
>   (names are matched only in contexts known to be about the subject). The user's decision names
>   the terms to scrub, not the name; an organisation's name in a person's email is mostly about
>   the person's work.
> - Found by the updated every-store test: an organisation erase now also deletes **suggested
>   contacts at its domains** (`core_suggested_contact.domain`, current and former), which it had
>   left behind. They are counted in `suggestionsRemoved`. Sync may suggest such an address again
>   from later mail; organisations have no erased-address list.
>
> Tests: `erase-stores.test.ts` ("organisation.erase reaches every store"): a kept body rewritten
> (and nothing of the organisation left in D1 or R2), an email with no person on it losing its
> body, an email only about the organisation deleted, the snippet-only fallback (object missing; no
> blob storage), and a person erase afterwards still dropping the body.

> **Amended 2026-11-06 ([ADR 0330](0330-self-hosted-workers-ai-over-rest.md)):** the "not
> covered" AI Gateway item and the decision left to the user are resolved. Self-hosted Workers AI
> now goes over REST through the deployment's gateway with `cf-aig-collect-log-payload: false`
> whenever the installer has given the gateway token Workers AI Read (`AI_GATEWAY_REST`). Prompts
> are still logged only on the binding fallback (a hand-set or older token that could not be
> replaced), and the installer warns when that is the case.

> **Amended 2026-11-06 ([ADR 0342](0342-assistant-memory.md)):** the store list gains `core_memory`.
> An erase deletes the memory lines that name the subject, in its own batch: found through
> `core_memory_refs` (ids, hashed emails, and customers a line named when it was saved), or by a
> term or the full name in a line's text, condition or team history. A single given name alone is
> not matched. The thread a line was said in is scrubbed too, even if its turn looked up no record.
> `person.erase` and `organisation.erase` report `memoryLinesDeleted`.
