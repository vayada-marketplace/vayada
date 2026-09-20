# Published affiliate terms and creator agreements

VAY-1501 / VAY-1056, with VAY-1505 / VAY-1087 attribution dependencies.
Design draft, 2026-09-10. User authorized preparing this contract after the
repeat-booking review. Detailed lifecycle defaults below are recommendations;
this document does not claim separate acceptance of every proposed rule.
No runtime API, migration, link activation or payment is implemented here.

Read alongside [offer terms](marketplace-affiliate-offer-terms.md) and
[booking evidence](affiliate-booking-evidence-contract.md). Marketplace owns
publication and creator participation; Booking owns destination/referral context;
PMS owns operational evidence; Finance owns commission policies and settlement.
The contract is provider-independent and requires no PMS subscription.

## Current implementation scope — 15 September 2026

Current work implements the requested foundation: immutable published terms and
same-version hotel approval/creator acceptance, preserving exact historical scope.
Detailed pause/resume/grace-window mechanics below remain proposals, not new
commercial defaults authorized by storing this document. Publication storage alone
is not an accepted agreement, and matching decisions alone do not prove activation
readiness. Keep these prerequisites separate from public enrollment and link activation.

The [earning evidence join](affiliate-earning-evidence-join.md) records the current
source gaps. Existing collaboration assent fields are mutable and must not substitute
for independent affiliate agreement history. Diagnostic tracking validation can use
isolated non-earning contexts; it must not require an active earning agreement to
prove the capabilities needed before publication. Genuine readiness is still required
before publishing or activating live earning relationships.

## Product flow

1. Hotel saves a draft with a booking destination, approved percentage policy and
   explicit attribution window. This remains hotel-only.
2. Hotel publishes an immutable terms version after publication checks pass.
   The marketplace displays its exact rate, accommodation-only basis excluding
   taxes/extras, window, booking destination, conditions and tracking readiness.
3. Creator applies to that program/version, or receives a hotel invitation within
   the existing marketplace. Both paths require hotel approval and creator acceptance
   of the same version; an invitation or application alone cannot activate earning.
4. Once both decisions and activation checks pass, the creator agreement becomes
   active and can receive a stable personal hotel link through a later link command.
5. Hotel proposes new terms by publishing a new version. Existing accepted terms
   remain in force until that creator explicitly accepts an approved replacement.
6. Creator sees active, pending, paused or ended participation and its exact terms.
   Collaboration completion does not end the affiliate agreement or its link.

## Records and immutable references

These are logical records, not a proposed additional service or migration schema.
Reuse existing domain identities and command infrastructure where applicable.

| Record            | Required meaning                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Program           | Stable Marketplace identity bound to organization, property and affiliate offer. One non-ended agreement per program/creator; multiple offers must not be silently merged.                                                                             |
| Published terms   | Immutable ID, program/property/offer IDs, source draft ID/revision, exact destination and Finance policy version IDs, explicit window, attribution policy version, publication actor/time and effective instant.                                       |
| Participation     | Program and creator profile, pending/active/paused/ended state, revision and the hotel approval and creator acceptance records needed to activate.                                                                                                     |
| Acceptance        | Exact terms version, accepting creator actor/profile, time, retained immutable creator-visible content snapshot/reference and an integrity digest; a digest alone is insufficient. An acceptance records assent, not hotel approval or tracking proof. |
| Hotel approval    | Exact creator/program/terms version, approving hotel actor, time and authorized property scope. Publication is not blanket creator approval.                                                                                                           |
| Agreement history | Append-only activation, terms-change, pause, resume and end events, expected prior revision, actor, reason, server effective instant and request/idempotency reference.                                                                                |
| Link reference    | Stable opaque link ID bound to agreement and property. Clicks later bind to the effective accepted terms; changing terms must not rewrite old clicks.                                                                                                  |

Application/invitation attempts have their own immutable IDs, separate from the
stable program/creator participation. Each attempt pins one published version;
approval, acceptance, expected revisions and idempotency receipts reference that
attempt. Decline/withdrawal history is append-only and reapplication creates a new
attempt, not a reset of the previous one. Initial assent commands may support only
one attempt until the separate lifecycle commands exist; storage must retain the
stable participation identity independently of that initial terms version.

Published-version `effectiveAt` is publication-scoped. Agreement terms take effect
only through a separate activation/history event with its own server instant,
revision and exact approval/acceptance references after activation checks pass.
Click binding uses that agreement activation boundary, never publication time or
assent alone. An advertised replacement cannot alter earlier accepted click terms.

Published terms must retain the exact creator-visible conditions or immutable
references sufficient to reproduce them. Mutable offer descriptions are not proof
of accepted terms. Never delete historical acceptance or overwrite published rows.
The program's advertised version may advance without changing any agreement.

## Publication and activation gates

Publication requires fresh authorized hotel management context, active Marketplace
entitlement, persisted owner/operator property and offer scope, expected draft
revision, same-property destination resolution and an exact approved Finance policy.
Finance must supply all required creator-visible conditions; missing commercial
conditions cannot be invented by the Marketplace or masked by percentage approval.
Required evidence-path capabilities must be validated, not merely documented or
configured. The existing four pending diagnostics do not satisfy this gate.
Existing moderation rules also apply. Publication is blocked with explicit reasons
when any requirement is missing; no automatic fallback to a newer version occurs.

Activation rechecks the above live eligibility/readiness gates plus creator identity
and entitlement requirements from the existing Marketplace authorization policy.
Hotel approval and creator acceptance must reference the same published version,
which must still be open for enrollment. Closing a version to new enrollment does
not revoke existing agreements. Concurrent approval/acceptance/withdrawal must be
serialized; stale attempts fail with a conflict instead of substituting latest terms.

A readiness outage after activation is separate from agreement lifecycle: disable
new earning-link activation and expose degraded tracking without rewriting agreement
history. Missing evidence stays pending. Never promise guaranteed credit during an
outage or interpret missing referral data as complete negative evidence.

## Proposed lifecycle rules

Initial state is pending. Approval and acceptance may arrive in either order.
Withdrawing either pending decision prevents activation. Declined or withdrawn
requests remain historical; reapplication is an explicit new request.

Both hotel and creator may pause or end their own partnership through authorized
commands. Only the party responsible for a pause may clear it; simultaneous pauses
require both parties to clear theirs. Derive paused state from outstanding pauses.
End is terminal for that agreement; restart requires a new explicitly approved and
accepted agreement. Resume never bypasses an outstanding pause or the live gates.
An active agreement's old terms remain effective while new terms await acceptance.
Accepting new terms does not resume a paused agreement.

For the first implementation, lifecycle changes take effect at server commit time:
no caller-supplied backdating or scheduling. Order events by revision as well as UTC
instant. Equal-time click/change ordering needs trusted sequence evidence; without
it, hold the affected attribution for review rather than guess.

A click requires an active agreement at its instant. Pause/end prevents new clicks
from qualifying; already eligible clicks retain their original accepted window.
Publishing or accepting new terms does not extend old windows. Clicks during a
pause do not become eligible on resume. New accepted terms apply prospectively;
existing clicks and attributed bookings retain their exact terms references.
Historical replay uses event-time agreement history, not today's state.

These grace-window rules cover ordinary lifecycle changes, not proven invalid
referrals. Disputed/invalid evidence requires restricted audited review/correction;
an ordinary pause must not silently revoke earned or previously attributed records.
Loss of tenant/resource authorization still denies access and provider reads now,
even where an old click remains eligible in principle. Lack of evidence stays pending.

## Booking rules consumed by attribution

Each independently evidenced distinct booking at the linked property can qualify
within its accepted click window. The same click may support more than one booking.
Use authenticated original booking creation time, with provenance, never modification,
import, arrival, departure or receipt time. Missing time is pending; conflicts require
review. Completion is evaluated separately for exact stay items and may occur later.

A corroborated replacement booking preserves the original opportunity, creation
instant and attribution outcome (including no attribution). If unresolved, evaluate
historical evidence for the original opportunity. A replacement cannot refresh a
window or switch creators via a later click. Missing lineage remains under review;
never infer aliases from guest names, email addresses or dates alone.

Booking must expose an original opportunity ID and a canonical booking/stay-item
mapping. The Finance journal key is `(propertyId, canonicalBookingId, canonicalStayItemId)`;
provider aliases, replacements and group/room projections must resolve to that key
before intake. A click selector's booking ID is not this mapping or an economic
deduplication guarantee. Distinct genuine bookings keep distinct opportunities;
replacement lineage preserves the original opportunity and item allocations.
The mapping producer is still missing, as recorded in the earning evidence join.

For each distinct booking, establish the complete trusted relevant click set and
select the last eligible click. An old token or guest-editable referral field alone
cannot establish completeness or authenticity. Deduplicate by canonical booking/item
scope, not globally by click or only by provider event. Group/room overlaps, aliases
and later corrections must preserve history and avoid duplicate Finance opportunities.

## Command behavior and authorization

Publication, approval, acceptance, terms changes and lifecycle commands each require
fresh context, scoped target IDs, expected revision and one idempotency key. Derive
actor/organization from trusted context, never request payloads. Creators can act
only for their own profile; hotel managers only for their authorized property/program.
Front-desk PMS access does not grant Marketplace approval/publication permission.

Commit each state change, append-only audit and completed idempotency result atomically.
Authorize before retry replay. Same authorized actor/scope/key/payload returns the
original result; changed payload, actor or expected revision under that key conflicts.
Competing commands serialize and revalidate prerequisites; failed gates create no
partial activation. Cross-domain reference verification must use owning-domain ports,
not new raw cross-domain database queries. No public route accepts trusted eligibility
flags. Concrete transport routes and denial matrices belong to the implementation slice.

Hotel and creator reads expose only their authorized participation, version history,
required next action and readiness reasons. Return unavailable scope without revealing
another creator's participation. Private responses are no-store; provider credentials,
guest identities and restricted raw evidence never enter these views.

## Acceptance criteria for implementation

- Draft save alone cannot publish, accept terms, activate an agreement or create a link.
- Missing/unapproved/out-of-scope policy, destination, conditions or evidence readiness
  blocks publication/activation with no partial write or substituted version.
- Invitation and application paths both require matching hotel approval and creator
  acceptance. Version mismatch and concurrent withdrawal cannot activate participation.
- New advertised terms leave existing agreements untouched; acceptance switches only
  prospective clicks and preserves the content and policy originally accepted.
- Pause by both parties requires both to clear; terms acceptance cannot clear a pause.
  End cannot be resumed; collaboration completion cannot change agreement lifecycle.
- Earlier eligible clicks survive ordinary pause/end within their original window;
  later clicks fail. Boundary ambiguity requires review; replay uses historical state.
- Two distinct bookings can share a click; replacement/duplicate/group-item evidence
  cannot generate another earning opportunity or switch attribution.
- Incomplete click/creation evidence stays pending, contradictions require review,
  and completion/settlement remain separate from attribution.
- Repeated requests return original results; key reuse conflicts; stale revisions
  and unauthorized retries cause no write. Hotel/creator cross-tenant denial cases pass.
- Readiness loss is visible without overwriting accepted terms or inventing evidence.

## Delivery boundary and remaining decisions

Implement separately: published terms persistence/authorized publication; participation
approval/acceptance and lifecycle history; creator/hotel reads and UI; then stable links,
trusted click correlation and durable booking attribution. These are incremental
slices, not authorization to implement the entire chain in one PR.

Consent/retention, operational evidence conflict handling and the remaining Finance
commercial/settlement rules still need their owning contracts. No live tracking or
payment readiness is claimed. No new migration, API or provider connection is part
of this design change. Acceptance criteria above are requirements, not executed tests.

## Initial storage and internal publication command

Migration 0196 stores stable per-offer programs and immutable published terms tied
to the exact scoped draft, disclosure bytes/hash, attribution policy, evidence and
author audit. The internal publication command locks the offer, checks persisted
property access and verified moderation, resolves the exact approved rate and saved
destination, and atomically stores publication and retry result. Publication does
not modify agreements or activate links. Authorized replay returns its original
record; a different key cannot republish the same draft.

The default prerequisite resolver blocks publication: complete commercial conditions
and a validated tracking adapter are unavailable. Its trusted internal replacement
must verify both for the exact scope with transaction-consistent evidence and
retain immutable proof references. No public request can supply that resolver.
Synthetic resolver tests prove transaction behavior only. No HTTP route or live
provider/publication path is wired.

## Initial agreement activation storage

Migration 0214 adds the stable agreement identity and one immutable initial activation
record. The agreement pins the exact program, property, hotel organization, creator
profile and participation independently from the collaboration lifecycle. Activation
references the same attempt and terms for both the hotel approval and creator acceptance,
and retains explicit readiness evidence and a server effective instant. Database keys
reject a substituted creator, program, attempt, terms version or swapped assent side.

This storage does not activate anything by itself. The authorized command must still
recheck the matched assent, current cross-domain readiness and idempotency inside one
transaction. Pause, resume, end, replacement terms, public links and click capture remain
separate later slices. In particular, collaboration completion has no path to mutate or
delete the agreement identity or activation history.

## Initial agreement activation command

The internal activation command locks the exact program, participation, attempt, terms
and assent decisions. It authorizes either participating hotel management or the owning
creator before retry recovery, rechecks persisted resource links and current offer/profile
eligibility, and calls a trusted readiness port inside the transaction. The port must prove
open enrollment plus current hotel lifecycle, commercial, destination and tracking readiness
for the exact scope through owner-domain adapters. Its default implementation blocks, so
missing owner-domain integration cannot create an agreement.

Successful activation atomically stores the stable agreement, immutable activation evidence
and completed idempotency receipt using a server timestamp. Same-key retries return that
record; changed actors or payloads conflict, and competing keys cannot create a second active
agreement. The command remains internal. Public transport, lifecycle changes and stable link
generation are separate slices.

## Initial independent lifecycle history

Migration 0326 adds append-only pause, resume and end events for activated affiliate
agreements. An activation with no later events is revision zero and reads as active;
each side's pause must be cleared by that side, and end is terminal. The internal
reader rejects gaps and invalid transitions instead of treating uncertain history
as active. Event times are assigned by the database at insert, so callers cannot
schedule or backdate a lifecycle change. Collaboration status is not consulted.

This is storage and an internal read only. Authorized transition commands, expiry
policy, replacement-terms history, public status reads and link readiness wiring
remain separate work. No live link or earning flow is enabled by this migration.

The internal lifecycle command permits the current hotel offer manager or creator
owner to pause, resume or end their activated agreement. It checks persisted
resource links before retry recovery, requires the expected event revision and
stores the event with an idempotency receipt in one transaction. A side may only
clear its own pause; end is terminal. It does not change collaboration history,
accepted terms or existing earnings. No public route or earning-link gate uses
this command yet.

The internal link creation command now requires an active agreement for a new
link. Existing creators can still retrieve their stable link while paused; the
internal token eligibility reader rejects paused and ended agreements and can
make the same link eligible again after resume. Click capture must use that
reader in a READ COMMITTED transaction before recording an eligible click. No public redirect
or click capture is enabled by this reader alone.
