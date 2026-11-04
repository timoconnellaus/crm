# @crm/core

Pure TypeScript domain core, with no Worker or UI dependencies. It will hold:

- the **operations registry**: every operation with zod input/output, a model-facing description,
  a permission and a risk class (ADR 0003, stage 1);
- risk classes and approval-policy types (ADR 0011);
- the model-role registry (ADR 0009, stage 7).

Empty in stage 0.
