# Financials expense worker database boundary (VAY-2044)

Keep `TARGET_DATABASE_URL` and its general runtime preflight unchanged. The
expense worker uses only `FINANCE_EXPENSE_WORKER_DATABASE_URL`, a non-owner,
NOINHERIT, NOBYPASSRLS login named `vayada_next_finance_expense_worker`.
`FINANCE_EXPENSE_WORKER_ENABLED` defaults false. No fallback to any API,
identity, Channex or migration credential is allowed. The initial boundary is
one explicitly configured property, also present in the owner-managed
`platform.finance_expense_worker_properties` table (empty after migration).
The credential remains visible to the API process; this is database isolation,
not process isolation.

## Complete expense-generation path

`server.ts` → `runFinanceExpenseGenerationCycle` performs discovery, then claims
jobs and calls recurring, OTA-commission, or provider-fee handlers. Every
handler reuses the claimed transaction/client; none opens another pool.

| Surface                                       | Required authority                                                                             | Database restriction                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Property, location, pricing                   | Read; property/pricing row locks                                                               | Allowlisted property; lock-only column UPDATE cannot modify rows                                             |
| Organizations, links, entitlements            | Read generation eligibility                                                                    | Linked organizations, allowlisted PMS resources, Financials/base entitlements only; no identity writes       |
| Recurring rules                               | Read and advance next date, active, revision, updated time                                     | Allowlisted property; no changes to economics/category/cadence                                               |
| OTA/provider-fee and nightly revenue evidence | Read and row locks                                                                             | Allowlisted property; no insert/update/delete of source evidence                                             |
| Expense categories                            | Read and row locks                                                                             | Allowlisted property; no category changes                                                                    |
| `finance.expense_generation_dispatches`       | Read/lock/update discovery state                                                               | Allowlisted property; no new dispatch/evidence injection                                                     |
| `platform.jobs`                               | Enqueue, duplicate enqueue, claim, attempts count, lease, continuation, retry, terminal/replay | Exact Finance queue/type/product plus allowlisted property; no queue/property reassignment                   |
| `platform.job_attempts`                       | Insert, completion/failure                                                                     | Visible Finance parent job                                                                                   |
| `platform.dead_letter_events`                 | Insert, replace failure, requeue state                                                         | Finance parent job, same property, matching attempt, same requeued job                                       |
| `platform.idempotency_keys`                   | Reserve/read/complete                                                                          | `finance.generated_expense.execute` only, allowlisted property                                               |
| `platform.product_audit_events`               | Append/read discovery/job/ledger outcomes                                                      | System Finance generation actions only; property-matched job/key references                                  |
| `finance.expenses`                            | Append generated create/correction/reversal, read/lock history                                 | Allowlisted property; recurring/OTA/platform-fee origins only; no receipts, manual expenses or history edits |

The existing identity dead-letter policy references `external_webhook_events`.
Finance therefore receives SELECT on `id, provider` solely to evaluate that
policy, with a restrictive policy exposing zero receipt rows. It receives no
receipt mutation permission. No source-writer rights are inherited.

No sequences are required: IDs use UUIDs. Existing immutable evidence/history
triggers and same-property foreign keys remain in force. The `0099` evidence
INSERT triggers create dispatch rows under the **source writer's** invoker
rights. Expense generation does not create source evidence and receives no
trigger-side INSERT grant. Source-writer repair is a separate contract.
Job claim/handler/outcome are one transaction; locks roll back on failure rather
than leaving a committed running lease. Savepoints preserve retry/dead-letter
handling and atomic ledger/idempotency/audit changes.

## RLS and lock semantics

Restrictive PUBLIC policies intersect existing permissive identity policies;
adding another permissive Finance policy would silently bypass queue isolation.
Previously unprotected tables get a compatibility policy for existing roles.
Existing role ACLs remain unchanged. Finance-only policy lookups run inside a
schema-qualified SECURITY INVOKER PL/pgSQL helper that returns immediately for
other roles. This avoids PostgreSQL eagerly requiring allowlist/attempt grants
on unrelated consumers. Preflight attests its exact definition and owner along
with policy expressions; it provides no elevated execution authority. Owners retain maintenance bypass; FORCE
RLS is unnecessary because worker ownership, memberships and BYPASSRLS are
rejected. The worker cannot change the allowlist, policies or role settings.

PostgreSQL requires UPDATE for SELECT FOR UPDATE/SHARE. A single lock column
is granted where needed, with a restrictive UPDATE WITH CHECK denying actual
writes. Tests must exercise both successful row locks and rejected updates.
Generated expenses are append-only for this role. No grants on receipts,
media, payments, bookings, other product tables, outbox or unrelated identity
records are permitted.

## Outbox evidence

The coordinator's sanitized CloudWatch audit (2026-09-21, SHA-256
`dd20111d1d0e8c1ca6003017d4925306277c197bfb83bcad9ca8f41297f464c9`)
identifies four `outbox_events` 42501 consumers:

- `relayPmsInboxDeliveryOutbox` — PMS Inbox delivery.
- `recoverExpiredLeases` in `bookingPublicationProjector` — booking publication.
- `claimNext` in `bookingGuestPolicyProjectionRuntime` — guest-policy projection.
- `recoverExpiredProjectionLeases` in `pmsInventoryPublicOfferProjection` — public offers.

None is called by expense generation. Per VAY-1138 coordinator clarification,
these remain separate consumer-specific permission blockers; this worker must
fail all outbox read/write probes. This change cannot claim those workers fixed.

## Rollout gates

Review migration, exact grants/preflight and app routing before provisioning.
Provision the dedicated SSM secret and login through the protected platform
runner, then verify effective privileges and the exact property allowlist.
Map only the worker secret; keep its flag false. Verify immutable app digest,
ECS secret reference, startup/preflight result and general API preflight.
Do not infer deployed readiness from tests against an independently supplied URL.

VAY-1138 must confirm reviewed changes merged/deployed and approve an exclusive,
bounded test window before enabling processing. Financials stays inactive;
entitlement writes, payments, reservations and destructive backfills are outside
this ticket. Rollback disables the worker and removes its secret mapping;
retain ledger/source data and never restore a migration-owner runtime URL.
