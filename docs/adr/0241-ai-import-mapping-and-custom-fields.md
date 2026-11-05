# ADR 0241: One AI-planned importer, custom fields through a local extension, and the `import.mapping` placement

Status: proposed, 2026-11-05 (stage 12 spec). Builds on [ADR 0024](0024-schema-reconciler.md),
[ADR 0041](0041-extension-authoring-and-proposals.md), [ADR 0150](0150-model-role-registry-and-ai-sdk.md)
and [ADR 0230](0230-jev-as-the-typed-judge.md).

## Context

The user decided on one generic importer: the AI works out file roles, links between files, and the
pipeline, stage, owner, picklist and currency mapping; unmatched columns can become custom fields
through schema approval; there is no per-system importer code, and sample exports from HubSpot,
Pipedrive and Salesforce are eval fixtures. The product rule is that AI proposes and a person
confirms, with no invented scores.

Custom fields today exist only in extension manifests. There is no `field.create`.

## Decision

1. **The `extract` model role proposes an import plan** from a profile of the files (headers, 50
   sample rows, up to 200 distinct values per column), never from whole files. The plan is a typed
   object validated by zod and then by code against the field registry, the parsers and the
   samples. Code asks for the role, never a model.
2. **No per-system code.** Knowledge of export shapes lives in the model and is held in place by
   the eval fixtures. If a fixture fails, the fix is the prompt, the profile or a generic rule (for
   example list-valued id columns), never a branch on the source system.
3. **The person confirms on one mapping screen.** Reasons are shown in words; no confidence
   numbers or scores.
4. **Without AI the importer still works**, file by file, mapping by header, field name and label.
5. **New custom fields go on a deployment-local extension, `custom`**, created on first use as a
   working copy and changed with `extension.write` and `extension.propose`. Approval is the
   existing extension approval (human admin). The reconciler adds the side-table columns. No new
   schema path is added. The import waits for the proposal to be applied.
6. **A new judge placement, `import.mapping`,** checks each column target and each stage and
   picklist mapping with one Choice over the candidates code gathered. It passes `docs/jev.md`'s
   rule: the answer must come from known candidates (rule 2); it is a judgement of meaning a person
   makes in seconds from a header and samples, with a closed set (rule 3); and code composes the
   result (rule 4: a flag on the screen, never a change). It fails open, because the person
   confirms every mapping.

## Why

- A plan proposed by a model and checked by code and a person is how the rest of the product uses
  AI. A per-system importer would be three codebases to keep in step with three vendors' exports.
- Reusing extension proposals for custom fields keeps one schema approval path, one reconciler and
  one place where admins approve schema.
- The placement uses Jev where the guide says it is strong (choosing among candidates) and keeps it
  out of what code can check exactly (links, parsing).

## Consequences

- Import quality depends on the `extract` model; the eval is the guard. A model change re-runs it.
- The `custom` extension becomes the home for admin-added fields generally; a later "add field"
  screen should write to it too.
- `docs/jev.md` lists `import.mapping` as a placement proposed by stage 12, built after stage 11's
  seam.
