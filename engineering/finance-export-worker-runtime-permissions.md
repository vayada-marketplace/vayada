# Financials export worker database boundary (VAY-2045)

`runFinanceFolioExportJobs` uses only `FINANCE_EXPORT_WORKER_DATABASE_URL`, a
non-owner, `NOINHERIT`, `NOBYPASSRLS` login named
`vayada_next_finance_export_worker`. The worker defaults off and cannot fall
back to API, identity, expense-worker, Channex, or migration credentials. Its
owner-managed property allowlist is empty after migration.

## Complete worker path

| Surface                         | Authority                                                   | Database restriction                                                  |
| ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `platform.jobs`                 | Discover, claim, lease, retry, finish                       | Exact export queue, five reviewed CSV job types, allowlisted property |
| `platform.job_attempts`         | Create and finish attempts                                  | Visible export parent job only                                        |
| `platform.dead_letter_events`   | Append terminal failures                                    | Matching export job, attempt, property, and resource                  |
| `platform.product_audit_events` | Append worker outcomes                                      | Exact system export actions and matching job/property                 |
| `platform.media_objects`        | Register intent and finalize private artifact               | Object ID equals job ID; exact private Financials export shape        |
| Pricing runtime scope views     | No access                                                   | Booking schema usage is not granted to the export worker              |
| Property/pricing evidence       | Read currency and timezone                                  | Allowlisted property only                                             |
| Expense evidence                | Read the accepted manifest rows                             | Allowlisted `finance.expenses`; no receipt or payment tables          |
| Folio evidence                  | Read accepted folio revision, lines, and payment references | Allowlisted property; no direct `finance.payments` access             |

Profit & Loss, Revenue, and Dashboard jobs render only their immutable accepted
snapshots. Folio and Expense jobs re-read the accepted manifest through read
models built from the dedicated worker URL. Every database dependency reached by
the worker therefore uses the export credential; the route/API repositories
continue using `TARGET_DATABASE_URL` and cannot claim or finalize jobs.

The role receives no identity, receipt, payment, booking, outbox, entitlement,
DDL, sequence, ownership, membership, or grant-option authority. Column grants
exclude `finance.expenses.receipt_media_id` and all unneeded source fields.
Restrictive PUBLIC policies preserve existing API and identity policies while
narrowing only the exact export login. The SECURITY INVOKER scope helper returns
before its worker-only lookup for every other login.

## Rollout and rollback

Provision the dedicated login and SSM secret through the reviewed platform
runner. Grant only the exported application matrix, set exactly one reviewed
property in `platform.finance_export_worker_properties`, and run the exact-login
preflight. Map the secret with the enable flag still false, verify the immutable
image/source/task-definition tuple and both worker and general API preflights,
then coordinate the exclusive VAY-1138 verification window.

Enable one task only long enough for existing export
`f3429f38-b462-4453-b7f1-d901fc86ebfa` to become `succeeded` or
`dead_lettered`; do not enqueue another export. Record only status, attempts,
timestamps, error code, artifact metadata, and audit identifiers—never the CSV
or credentials. Rollback first disables the worker, then removes its secret
mapping. Preserve jobs, audit, and artifacts; never substitute an owner URL.
