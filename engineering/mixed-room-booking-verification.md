# VAY-910 release verification

Local verification on 2026-09-06, rebased onto main `864fa5f5f`. Scope and accepted
per-room cancellation decision: [mixed-room contract](mixed-room-booking-contract.md).
The activation change is last in the dependency stack; merge/deployment and human
acceptance remain separate gates.

Release integration on 2026-09-07: main's meal-inclusion migration uses 0164,
so the still-unmerged changed-bundle adoption migration was renamed to 0165
without changing its SQL. A fresh isolated PostgreSQL 17 database applied
0001–0165 through the official runner; 45 bundle, pending-edit and nightly-revenue
database tests passed on that schema. The earlier local evidence below retains
its original migration numbering.

Latest release integration on 2026-09-07 uses main `1d87271ae`, including
VAY-1528's canonical stay restrictions and the additive nightly pricing resolver.
Mixed search resolves the exact offered rate plan and obtains the specific PMS
restriction reason before the checkout loader applies its canonical guard. The
reason query uses `pms.effective_stay_restrictions`, including disabled rules and
stop-sell on every occupied night. No restriction guard is bypassed.
Fresh isolated PostgreSQL 17 applied 0001–0166; 52 bundle, pending-edit and
nightly-revenue tests passed, including middle-night stop-sell, disabled-rule and
checkout-day exclusions. API/package build and independent integration review
passed. Migration 0165 retains the reviewed SQL unchanged.

Subsequent main `9572ea8f1` includes the guest-entrypoint and meal-display fixes.
Main's operational-alert migration took 0165 before this stack merged, so only
our pending adoption migration is now 0168; its SQL is byte-for-byte unchanged.
VAY-1528 retains 0166/0167. A fresh PostgreSQL 17 database applied all 167
available migrations (0001–0166 and 0168); all 53 focused database tests passed.
The full workspace build and a final Booking Web build passed. Integration
preserves authenticated editing and adds canonical breakfast/room-only text to
every selection line; all three card tests passed. Final workspace typecheck and Booking Web lint also passed. Independent browser
review rendered the actual component in a temporary harness with mocked currency:
1280px and 390px widths showed both per-line meal labels, the EUR600 total, no
horizontal overflow and selection of all three rooms. This was component browser
coverage, not a new end-to-end deployed smoke.

The final pending adoption migration is 0170: subsequently merged pricing and
ARI migrations own 0168/0169. An inventory of all other open PR files found no
pending migration claims before this allocation; the coordinator was notified.
Only the filename changed (100% identical SQL). A fresh database applied the
exact migration set from main `393bf7194` plus our 0170 (0001–0170), and the same
53 focused tests passed against it. PR #1685's fresh CI verifies integration
with current main; the remaining application stack stays gated until released.

## Evidence

| Check                                                      | Result                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root workspace build and typecheck                         | Passed, including Booking Web, Booking Admin, PMS, API and shared consumers               |
| API production TypeScript build after integration fixes    | Passed                                                                                    |
| Fresh PostgreSQL 17 migration runner                       | All 0001–0164 applied in order                                                            |
| API suite without database URL                             | 3,408 passed; 644 database-dependent tests skipped                                        |
| Dedicated mixed inventory and pending-edit database suites | 42 passed on fully migrated isolated PostgreSQL                                           |
| Finance read-model database suites                         | 6 passed                                                                                  |
| Booking / PMS / Distribution domain suites                 | 156 / 230 / 96 passed                                                                     |
| Booking Web unit suite                                     | 74 passed                                                                                 |
| Booking Web browser pilot                                  | 92 passed, mocked APIs                                                                    |
| Booking Admin / PMS host browser scenarios                 | 5 passed across full run and focused reruns, mocked auth/APIs, production frontend builds |
| Booking Web / Booking Admin / PMS lint                     | No errors; existing warnings remain                                                       |
| Independent review                                         | Each slice reviewed; valid findings fixed and re-reviewed                                 |

The database suite exercises exact quotes, all-night eligibility, linked stock,
concurrent last-room buyers, atomic reserve/release/adoption, nightly revenue,
pending mixed↔single replacement, confirmed guest/host date changes, complete
assignment adoption, and replay. Changed prices, PMS arrival restrictions and
coupon values fail pending save without changing inventory or the revision.
Repeated coupon edits retain one active redemption. Allocator tests cover
two- and three-type combinations, same-type options, guest bounds, incompatible
payment extensions and incomplete-search reasons.

## Real local guest browser flow

A dedicated target API and PostgreSQL fixture used two Double rooms and one Twin
for six adults, 1–3 February 2027. This exercised the real target repositories and
inventory transactions rather than mocked booking responses:

1. Search displayed the full selection, three allocations, two rate policies and
   €600 total. Selection navigation derived three rooms from the original minimum
   of one room.
2. One booking-scoped €10.25 add-on produced €610.25 through guest details,
   reload, canonical quote replay, payment review and confirmation.
3. Local synthetic booking `VAY-C9F9CF` had one reference and a complete two-line
   receipt bundle. No payment provider or email worker ran.
4. Guest lookup displayed every room and exposed the authorized pending editor.
   The editor restored held inventory even when public search was sold out.
5. Removing the add-on saved revision 1 at €600 with the same reference and all
   three rooms. Replacement receipts covered both room types.
6. At 390×844 the confirmation and policy lines were readable without horizontal
   overflow. Withdrawal canceled the booking; all original and replacement
   receipts were released.

Browser-driven fixes preserve currency cents, compare selection structure across
PostgreSQL JSON key reordering, show quote errors without a promo code, and retain
complete room details in guest lookup. Host browser fixtures separately verify
three unassigned stays, the combined total, both named cancellation policies,
date-change pricing and idempotent retry.

## Earlier local release verification

At that checkpoint, the remaining stack integrated main `7153aa340`, including structured cancellation
defaults and the guest-policy projection worker. Full workspace build and
typecheck passed. A fresh isolated PostgreSQL 17 database applied all migrations
0001–0170; 58 focused bundle, pending-edit, nightly-revenue and Channex restriction
tests passed across the completed runs. The newly merged restriction test now
uses the detailed restriction-reason helper introduced by #1690, preserving all
existing allow/block assertions. Independent integration review found no
regression in the cancellation/worker changes or this test adaptation.

## Stack and release constraints

Implementation starts at [#1657](https://github.com/vayada-marketplace/vayada/pull/1657)
and follows each PR's base branch. Final integration slices are
[#1700](https://github.com/vayada-marketplace/vayada/pull/1700),
[#1702](https://github.com/vayada-marketplace/vayada/pull/1702),
[#1703](https://github.com/vayada-marketplace/vayada/pull/1703), and
[#1704](https://github.com/vayada-marketplace/vayada/pull/1704), followed by activation.
Deploy compatible consumers before activating the API. Repository factories keep
their opt-in default for explicit callers; the completed application runtime
enables search, checkout and pending edits together.

The unused portable PMS adapter rejects selection payloads before mutation. The
target runtime uses its full transactional bundle consumer, covered by database
tests. No legacy Python or infrastructure changes are included.

CodeRabbit returned successful status contexts for rate-limited or skipped draft
reviews; those statuses are not evidence of a completed review. No inline findings
were available at the final inspection. Independent review is recorded separately.
Stacked branches do not run the main-targeted full PR workflow until retargeted;
full local validation above is not a claim of full-stack CI coverage.

All prerequisite PRs through #1704 and corrective PRs #1791/#1806 are merged.
Activation #1705 remains draft, rebased onto main `9eee464232606ea78987fc34c1e0ee89c15d84f3`.
Its production diff remains the two explicit mixed-room runtime flags; no broad
activation or human release acceptance has occurred.

## Deployed synthetic verification, 2026-09-09

The isolated API runs canary 20, source `c2eedb466e5894902fa5cd30e10e3293910ee9ea`,
digest `bd25c9ccc389e4d0f8ef26e148a5989ef51380dd2b26d91d8a44b6f4a71b7d6e`.
The corrected guest runs guest 9, merged source `9eee464232606ea78987fc34c1e0ee89c15d84f3`,
digest `ddc38a1aa63149a51e7a8f242963f3d7c9bd3932be822b5f5a8467500c94ecb2`.
Actual running task digests and completed rollouts were checked before testing.
The first guest rollout stopped before mutation because a delayed same-source
build replaced the image tag; the final build digest was verified before retry.

One existing synthetic room and one explicitly authorized mapped synthetic room
provided four-adult capacity for September 21–22. Guest search, details, payment,
confirmation and lookup preserved both room names, individual policies, one
reference and the EUR 200 total. No online payment or real stay was created.
PMS displayed both stays. A host date-change preview rejected an overlap with
the preserved September 20 reservation, without changing the booking.

The first confirmed test was canceled through the supported PMS preview/apply
flow. Guest cancellation correctly rejected its unverifiable legacy policy
snapshot, although the UI hid the 409 reason. A pending test then passed complete
selection prefill, special-request quote/save and guest withdrawal. The deployed
four-to-three guest change exposed missing held-room allocation controls;
#1806 added those controls with nine unit and ten mocked browser checks,
production build, required CI and independent/CodeRabbit review passing.

The corrected deployed editor now passes four-to-three guest reallocation,
quote and save: one adult in the new room, two in the original room, both exact
room/rate identities, EUR 200 and the same reference. PMS lists three guests
under both rooms. Guest withdrawal passed and instant acceptance was restored.
Independent final cleanup at 12:12 UTC verified all three synthetic bookings canceled,
the original eight reservations unchanged, both September 21 assignments released,
732 inventory days at calendar/coverage revision 7, readiness ready and an empty queue.
The evidence is recorded with the local smoke ledger.
These deployed checks cover two room types; the broader combinations, races
and negative cases retain their separately labeled local/database coverage above.

## Final retirement and release acceptance — 2026-09-10

The supported closure and retirement workflow completed. Receipt
`9e9e559c-cab7-4887-a842-5ebe9ce654cb` closed 364 future inventory days,
retired the selected physical unit and suppressed three offers. Exact replay
passed. Publication `45680212-b27e-40d1-90a2-1ec1d1b5b402` succeeded after
extending rolling coverage by two closed-zero original-room dates. The selected
room is inactive, with zero active units; only its two mappings were disabled
and independently audited. All 11 reservations, original room/pricing/policy
choices, two season rules and 369 pre-existing original inventory rows/revisions
were preserved. The room is absent publicly and readiness is ready.

Closure mode was disabled and the scoped worker restored on the same reviewed
image. The normal retirement ARI job was dead-lettered once by the existing
mapping guard before provider HTTP; pending/running jobs ended at zero. A later
supported unchanged inventory-rule reconciliation refreshed stale channel
metadata from the provider. The actual deployed planner then passed the mapping
precondition without executing HTTP. The historical failure remains recorded;
no ARI resend or OTA success is claimed. Booking.com is absent from the current
provider channel list. The fixture lease was released.

Sanitized local evidence: `evidence/vay910-closure-live/RESULT.md` and
`evidence/vay1528-mapping-diagnostic/RESULT.md` under the reusable test evidence
store. Canary26 retains the closure fences with closure mode off; deploying a
replacement must preserve compatibility with the durable closure receipt.

The user accepted proceeding with broad activation after these results on
2026-09-10. Activation still requires current-head checks, review and deployment
compatibility verification; Done follows verified deployment. Request-mode
pay-at-property copy and the obscured legacy-policy cancellation rejection
remain separate recorded UI follow-ups.

## Closure compatibility integration

Aggregate PR #1861 merged as `9f7125ae6198760a9edf90e1102e08c0c55598e2`.
It includes the closure eligibility, publication, inventory, booking and worker
protections, with closure mode defaulting off. The unapplied prepared-import
migration is numbered 0178; applied closure migrations 0174–0177 retain their
original checksums. All ten required checks, 194 focused tests, a fresh migration
run and an upgrade applying only 0178 passed. Independent final review cleared
the composition. CodeRabbit skipped: rate limited after actionable findings
were fixed. This activation branch incorporates the integrated protections.
