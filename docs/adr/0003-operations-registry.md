# ADR 0003: Operations registry is the one API

Status: accepted, 2026-11-04 (stage 0 architecture interview).

## Context
"Fully AI" means Claude can do anything a user can. The UI, MCP and extension code must not drift apart.

## Decision
Every operation is defined once in `packages/core` with:
- a name and a model-facing description
- zod input and output schemas
- the required permission
- a **risk class**: `read | write | bulk-write | destructive | schema | extension | outbound`

Adapters generate a TanStack Start server function (UI), an MCP tool (`/mcp`) and a host module (`codemode:crm`) from each definition. Every invocation carries an **actor** and passes through the approval pipeline (ADR 0011).

## Consequences
- A new feature starts as operations, so it's available to UI, Claude and automations at once.
- Descriptions are product copy for models and are reviewed as such.
