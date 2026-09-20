# PMS Financials activation runbook

This is the VAY-1138 release gate for the five no-provider MVP tabs: Dashboard,
Revenue, Expenses, Profit & Loss, and Folios. The source contract is
[`pms-financials-contracts.md`](pms-financials-contracts.md). Financials stays
inactive for new properties. An official invoice, provider connection, PDF, or
invoice email is not part of this activation.

## Record the candidate

Use one property and one exact deployed API/PMS revision per rehearsal. Keep a
sanitized evidence record with the property ID, UTC time, target migration
version, API and PMS image digests and source SHAs, relevant PRs, test run IDs,
readiness JSON, reconciliation counts, browser result, and remaining exceptions.
Do not include guest PII, credentials, provider payloads, or raw export URLs.

Stop before activation if any dependency is unmerged, its revision is not
serving, its migration has not applied, or an acceptance check below is
blocked. The approved Feature Hub path and explicit production authority are
required for activation; do not insert entitlements directly to bypass it.
As of this snapshot, that path does not exist: the Feature Hub registry has no
modules, the PMS activation API advertises no supported modules, and its
mutation route returns 410. Financials cannot be activated or rolled back
through Feature Hub until a reviewed control and its authorization are shipped
and verified on the serving revision.

## 1. Verify deployment and authorization

1. Confirm the exact running API and PMS image digests and map them to source
   commits. A successful image build or merge alone does not prove deployment.
2. Confirm the target migration chain applied and the property has a currency
   and PMS pricing settings. Keep `module:financials` inactive through rehearsal.
3. Confirm `pms.finance.read` and `pms.finance.manage` grants and the selected
   property's `owner` or `finance_manager` link. Review the effect of granting
   `pms.finance.read` to `finance_manager` on older Finance routes before its
   VAY-1138 migration. A generic `operator` link is insufficient.
4. Prove unauthenticated access returns 401; Front Desk and Housekeeping cannot
   see navigation and receive 403 on direct Financials reads, writes, exports,
   status, and downloads. Missing permission, property link, base entitlement,
   or active module entitlement must each deny Owner and Manager access. Repeat
   the allowed Owner/Manager cases only after activation.

## 2. Rehearse data and reconcile

Use the property-scoped, read-only readiness audit described in the
[`backend-migration` README](../packages/backend-migration/README.md#pms-financials-activation-readiness):

```bash
TARGET_DATABASE_URL=<target database url> \
  npm --workspace @vayada/backend-migration run target:financials:readiness:dist -- \
    --property-id <property id> --expect-inactive --pretty
```

Record each finding code and count. Resolve missing default categories through
the reviewed, property-scoped seed procedure; leave archived categories for
manual review. Do not create historical manual expenses. Rehearse nightly
revenue and attribution backfills with stable run IDs, dry-run reports, source
fingerprints, and repeat runs. Missing room-night scope, unresolved money,
unknown channel/currency, missing or ambiguous effective OTA commission rates,
and pending generated expenses remain exceptions. Do not infer an OTA rate or
synthesize a booking payment, folio, or invoice.

Recurring Finance expense discovery and queued-job processing require an active
Financials entitlement. OTA and provider fee evidence may enqueue jobs while
the module is inactive, but those jobs cannot be processed. For a property
with nonzero applied OTA commission evidence, the routine worker cannot clear
`OTA_COMMISSION_EXPENSE_PENDING` during the inactive rehearsal. Stop at that
finding until a reviewed, property-scoped preactivation projection path is
available. That path must preserve source keys, idempotency, correction and
audit evidence, reconcile queued and dispatched jobs against source evidence,
and prove a second run inserts no duplicate expenses. Do not activate the
module temporarily to make the worker run.

Compare source and target counts and totals by property, currency, stay/date
range, channel, and correction state. Re-run the same backfill and confirm no
duplicate projections or generated expenses. Match the Dashboard, Revenue,
Expenses, and Profit & Loss API totals to the same evidence and filtered CSV
rows. Verify CSV formula cells are neutralized and export retries reuse their
durable job rather than issuing a second artifact. Capture job failures and
reconciliation differences, not just a top-level `ready` value.

Production writes require a separately reviewed plan and explicit authority.
Do not treat a passing disposable or staging rehearsal as proof of live parity.

## 3. Run the acceptance gates

The candidate must pass migrations from empty and upgraded databases, Finance
domain/API/authorization/export tests, PMS Web build and lint, and payment,
provider, checkout, payout, and affiliate regression suites. Record exact
commands and CI links. Mocked browser fixtures are separate from real-account
evidence.

After the approved property activation, rerun the audit with
`--expect-active`. With reusable real accounts, exercise the five tabs on that
same property:

| Tab           | Required evidence                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard     | Cards and totals agree with the authorized API and selected period.                                                                                     |
| Revenue       | Stay/channel attribution, exceptions, filters, currency, and CSV reconcile.                                                                             |
| Expenses      | Manual and supplier-bill entry, category/paid filters, generated versus recurring labels, and CSV reconcile without duplicates.                         |
| Profit & Loss | Monthly and YTD rows, custom categories, and CSV reconcile with API totals.                                                                             |
| Folios        | Prepare and finalize an operational folio, inspect payment references, and export accounting-ready CSV. No Vayada record is called an official invoice. |

Use bounded synthetic data and coordinate the shared property with other smoke
tasks. Do not make a real guest reservation or payment. Record screenshots or
sanitized response IDs, filter inputs, totals, and any retry outcome.

## Observe and roll back

Before and during activation, reconcile queued and dispatched Finance jobs to
source evidence; watch the readiness finding counts, retries and dead letters,
export outcomes, redacted audit events, HTTP 4xx/5xx, and application
exceptions. Confirm the same deployed source remains serving. Define the
observation window and responsible reviewer in the evidence record.

If a gate fails after activation, deactivate the property module through the
approved Feature Hub control and, if needed, return application traffic to the
last known good revision. Confirm direct routes deny access and navigation is
hidden, then rerun the audit with `--expect-inactive`. Preserve payment rows,
Financials source evidence, projections, folio revisions, idempotency keys,
and export jobs/artifacts. Do not reverse successful exports blindly or delete
ledger rows to make reconciliation appear clean. Reconcile remaining queued
and dispatched jobs to source evidence. Record the failure, exact serving
revision, rollback time, and remaining work before another attempt.

VAY-1138 remains In Progress until the evidence record has no unexplained
blockers and a human explicitly accepts completion.

## Evidence snapshot — 2026-09-20 11:10 UTC

This snapshot documents preparation, not activation or a passing golden path.
ECS reports one running task and a completed rollout for each service; their
task definitions reference these exact images:

| Service  | Task definition                | Image digest                                                              | Source SHA                                 |
| -------- | ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------ |
| Next API | `vayada-next-api:1120`         | `sha256:acdf7d35f95b67aa81c530bd50f503d60257d8cadf32d8f95a0fc13101604693` | `dda47a35e4c739ca55dd36f8f98c0339d485f033` |
| Next PMS | `vayada-next-pms-frontend:578` | `sha256:b4ce6e919a33ca69ad48b19074e1b622aeff485d61add439d3126e832e93bc19` | `a4709fe189a039a2eaa52714a3497e8458bc51ed` |

Both sources contain the merged read-only readiness audit from PR #2486.
Category-seed PR #2522 is open with green required CI and is not serving.
VAY-1134 and VAY-1136 remain In Progress; VAY-1137 is Done. VAY-2037 code is
serving, but its monitored real-account smoke stopped at owner login because
the runtime lacks permission on `platform.product_audit_events` (PostgreSQL
`42501`). Do not repeat that unchanged blocker.

The `finance_manager` read grant, module-aware Financials navigation, a
preactivation OTA commission expense projection path, complete reconciliation,
Feature Hub activation and rollback controls, and five-tab real-account smoke
are still open gates.
No live backfill or Financials activation was performed for this snapshot.
Replace it with a new timestamped record after a relevant change; do not reuse
these image SHAs as proof of a later deployment.
