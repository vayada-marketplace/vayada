# PMS Financials activation runbook

This is the VAY-1138 release gate for the five no-provider MVP tabs: Dashboard,
Revenue, Expenses, Profit & Loss, and Folios. The source contract is
[`pms-financials-contracts.md`](pms-financials-contracts.md). An official invoice, provider connection, PDF, or
invoice email is not part of this activation.

For a newly created PMS hotel, Financials turns on automatically after its
currency is first saved and all seven starter expense categories exist. Until
then its property entitlement is suspended. The Owner can turn Financials off
or back on in Feature Hub; later currency edits never override that choice.
PMS billing must still be eligible. A global suspension or linked historical
data keeps the module off for manual review.
Existing hotels are not activated by this setup path and still follow the
property-specific rehearsal and approval below. Do not bulk-enable them.

Before releasing the new-hotel path, run the standard API runtime database
preflight and verify the restricted runtime role can read billing, booking,
property links, entitlements, and categories; insert categories and audit
events; and update the property entitlement. Hold the release if any exact
privilege is missing. Do not add a broad grant.

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
The Feature Hub control now exists for approved properties. Verify its current
serving revision, owner authorization, entitlement write, audit event, and
rollback behavior for each activation candidate.

The control introduced in PR #2541 is property-scoped. The API setting
`PMS_FINANCIALS_ACTIVATION_PROPERTY_IDS` defaults to an empty list for existing
hotels. Add only an explicitly approved existing property ID and verify the
running API picked it up. A newly created hotel with a completed setup marker
can use the Feature Hub switch without this allowlist. The allowlist does not
replace the readiness audit or production approval for existing hotels.
Only an active property owner with `pms.finance.manage`, a PMS base entitlement,
and effective property access can change the module. A global Financials
suspension blocks activation. Removing a property from the allowlist must not
remove its rollback path: an owner can still deactivate an active property row
or an effective organization-wide grant. Record the corresponding redacted
`platform.product_audit_events` event and verify runtime database write grants
for both entitlement and audit tables before adding any live property ID.

## 1. Verify deployment and authorization

1. Confirm the exact running API and PMS image digests and map them to source
   commits. A successful image build or merge alone does not prove deployment.
2. Confirm the target migration chain applied and the property has a currency
   and PMS pricing settings. For an existing hotel, keep `module:financials`
   inactive through rehearsal. For a newly created hotel whose setup completed,
   or an already approved active test property, use `--expect-active`; do not
   toggle it merely to satisfy the inactive audit.
3. Confirm `pms.finance.read` and `pms.finance.manage` grants and the selected
   property's `owner` or `finance_manager` link. Review the effect of granting
   `pms.finance.read` to `finance_manager` on older Finance routes before its
   VAY-1138 migration. A generic `operator` link is insufficient.
4. Prove unauthenticated access returns 401; Front Desk and Housekeeping cannot
   see navigation and receive 403 on direct Financials reads, writes, exports,
   status, and downloads. Missing permission, property link, base entitlement,
   or active module entitlement must each deny Owner and Manager access. Repeat
   the allowed Owner/Manager cases only after activation.
5. Confirm the Feature Hub card and state are visible only for the authorized
   owner/property, that activation persists an effective property-scoped
   entitlement and audit event, and that deactivation hides navigation and
   denies direct Financials access. An existing property outside the allowlist
   cannot activate; a completed new-hotel setup can. Rollback remains possible
   after allowlist removal.

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

## Evidence snapshot — 2026-09-20 16:24 UTC

This snapshot documents preparation, not activation or a passing golden path.
ECS reports one running task and a completed rollout for each service; their
task definitions reference these exact images:

| Service  | Task definition                | Image digest                                                              | Source SHA                                 |
| -------- | ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------ |
| Next API | `vayada-next-api:1121`         | `sha256:25af5d54b304568c2a45a8d0e33a2e8b8af5871af5ddf267762070ce4433255d` | `9dec079aa94f6f3d1529e4cc2dfdeb42be8763e8` |
| Next PMS | `vayada-next-pms-frontend:584` | `sha256:0bc7305cf9186b1e1a5e15eb7e1a3317bb19171e2b2abf96e35543a84719277e` | `1126c77c0adb846a30ff0d4bbd716da54c728355` |

Readiness PRs #2522, #2531, #2533, #2536, and #2541 are merged, but neither
serving source includes those merges. Runbook PR #2525 is open and rebuilding
after a README conflict was resolved. Migration 0402, the Financials navigation
gate, and Feature Hub control are not yet verified on the serving revisions.
VAY-1136 and VAY-1137 are Done; VAY-1134 remains In Progress. VAY-2037 code is
serving, but its monitored real-account smoke stopped at owner login because
the runtime lacks permission on `platform.product_audit_events` (PostgreSQL
`42501`). Do not repeat that unchanged blocker.

Complete deployed revision and migration verification, property-scoped source
reconciliation, the reviewed runtime privilege fix, authorized activation, and
five-tab real-account smoke before acceptance. No VAY-1138 live backfill or
Financials activation was performed for this snapshot.
Replace it with a new timestamped record after a relevant change; do not reuse
these image SHAs as proof of a later deployment.

## Evidence snapshot — 2026-09-28 12:06 UTC

The approved synthetic property `65f6b2fc-c783-4963-9d6b-a85f82319769`
remains active from its earlier VAY-1128 smoke. New properties remain inactive
by default. The serving API `vayada-next-api:1168` is source
`a3adca84e77a7c43fe4474d28c216c1c94677309` at runtime digest
`sha256:2ff7ec1d356b4eddb713ef8fce2925c9130981768cb6f0c3f7bc3b5a56803f7e`.
The serving PMS frontend `vayada-next-pms-frontend:627` is source
`ada6119ebb553d8b1cdb28290192cc161fe0745b` at runtime digest
`sha256:bebbbb442ee348c0d500e232c0625606cc4056ba0c951da81210a914a9d9a338`.
Both ECS services have one running task and one completed primary deployment.

The bounded five-tab test passed: Dashboard, Revenue, Expenses, Profit & Loss,
and a synthetic operational Folio prepared as draft then ready. All five CSV
paths returned files; the ready Folios CSV contained one data row. The Folio
amount was EUR 0.01 with no booking or payment reference, and it was not
labeled an official invoice. The narrow Folio command grant and both live
runtime preflights passed. A GET-only live check allowed the reusable Owner and
denied Front Desk and anonymous users on direct Financials routes. Manager and
Housekeeping behavior, sidebar hiding, and entitlement rollback have code and
integration test evidence, without separate live logins or a live off/on
rehearsal. [App PR #2662 CI](https://github.com/vayada-marketplace/vayada/actions/runs/36313105396)
passed required checks and PostgreSQL 16/17 integration. The test property
stays active.

The read-only audit rerun with `--expect-active` confirmed the module is active,
all default categories exist, and unresolved revenue and pending commission
expense counts are zero. Its strict result is still `BLOCKED` with seven
findings on five old records: two bookings each count once for missing assignment
and once for missing nightly revenue, and three OTA snapshots have no historical
commission rule. Flamur accepted these as visible, unchanged legacy exceptions;
no rate or amount was inferred. Do not report the strict audit as passing.

Sanitized request results, CSV hashes, exact Folio ID, active audit output,
limitations, and scripts are in
`/Users/flamurmaliqi/.local/share/vayada-testing/evidence/vay1138-final-five-tab-20260927/RESULTS.md`.
No real reservation, payment, provider write, or official invoice was created.
VAY-1138 remains In Progress until Flamur accepts this evidence and the stated
legacy and live-role limitations.
