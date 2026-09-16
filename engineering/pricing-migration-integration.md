# Pricing migration integration

VAY-1557 and VAY-1545 reconcile the replacement-pricing and Channex stacks
with main `6b7fa8e34`. The combined append-only sequence is:

| Versions  | Owner               | Purpose                                                                                                              |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0300–0313 | Replacement pricing | Pricing storage, offer terms, charges, FX, draft sources, booking quote evidence, and PMS adoption                   |
| 0314–0323 | Channex             | Published offer targets, creation and ARI attempts/receipts, availability attempts/receipts, and inventory job scope |

The files under `packages/backend-migration/migrations` are the authoritative
mapping. Do not reuse or renumber 0300–0323 independently: Channex 0314 depends
on replacement-pricing tables introduced by 0300–0313, and later Channex
migrations extend the 0314 ownership and attempt model.

Validate a fresh database against current main plus the complete combined
sequence. Rerunning must apply nothing. Before deployment, also compare the
target environment's migration ledger with these filenames and bytes.

Local databases previously migrated with earlier pricing or Channex numbers
have a different ledger. Preserve them as historical evidence; use fresh
isolated databases for integration verification. Do not rewrite their ledger
or apply both histories. If a shared environment contains an earlier history,
stop the rollout and reconcile its actual ledger separately.

The default rollout remains observe-only and performs no provider writes. An
environment that already enables mutating Channex ARI and contains queued
`sync_ari` jobs can send restrictions or availability when the worker starts.
Audit or pause that queue before deployment. This document does not authorize
merging, deployment, runtime activation, or provider writes.
