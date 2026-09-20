# Published offer targets for Channex

VAY-1972, the delivery mapping decision for VAY-1545. Follows the trusted reader
contract and VAY-1970's verified nightly candidates. This describes required
implementation; it does not enable provider writes.

## Identity

The current `pms.channel_rate_plan_mappings.rate_plan_id` references
`pms.rate_plans`. Replacement offers instead have string IDs scoped to a room
inside an immutable published pricing configuration. Creating synthetic old
rate-plan rows to satisfy that foreign key would restore a retired dependency.

A replacement logical target is `(connection_id, room_type_id, offer_id)`, scoped
to the canonical property through database constraints. Its stable identifier
does not contain the publication revision, offer name, meal label or OTA name.
The same string offer ID in different rooms is a different target. Canonical
room and connection property must agree. Titles are display data, never adoption
keys. Publication membership is established through the trusted reader.

New targets use one shared base provider rate per published offer. Connected
channels map to that target through Channex; adding a channel does not create a
new Vayada target category. Channel discovery, native modifier display and
capability evidence remain separate concerns. Existing legacy mappings and
reservation identities remain retained; no automatic adoption by name or offer
position is permitted. An adoption must prove the exact external property, room
and rate identity plus ownership and supported semantics before activation.

## Target versions and retained history

Persist a stable logical target plus immutable numbered target versions, with
an active-version pointer and at most one pending replacement intent. Reserve a
version number with that intent before provider work; numbers increase
monotonically and are never reset or reused, including failed attempts. Seal the
immutable version only after exact external identity is established. It records:

- Canonical property, connection, room and offer identity.
- Connection binding generation and exact external property/room/rate IDs.
- Provider sell mode, complete occupancy options and one explicit primary option.
- Currency, meal identity and supported restriction/guest representation evidence.
- Adjustment ownership and the provider configuration evidence that supports it.

An external rate cannot silently become another logical offer's identity. Retain
superseded versions for audit and inbound identity resolution. External rate ID
resolves the logical offer, not necessarily a unique configuration version when
several versions reuse that ID. Never infer booking-time configuration from the
current pointer or receipt timestamp. Preserve provider booking facts and the
reservation's frozen evidence. Attach a historical target version only when an
explicit, verified correlation proves it; otherwise record that version as
unknown rather than reconstructing price/terms from current configuration.
Reusing an external rate retains the same logical offer identity. An offer
disappearing from the current publication
invalidates outgoing work immediately but does not delete historical mappings.

The old mapping and replacement mapping stores must not both claim an external
rate without an explicit, audited ownership transfer. The migration/writer must
enforce this across stores; independent uniqueness indexes are insufficient.

## Staging and activation

Resolve the active published offer and current owner evidence first. Create a
pending replacement intent with a durable operation identity and reserved version
number before provider work. Retries reuse that operation and reserved number.
The intent retains the proposed configuration and may initially have no external
rate ID; it is not an immutable verified mapping or an active target. Record
provider create/reconciliation evidence on the operation, then seal the version
with exact IDs. Resume a crash between evidence capture and sealing idempotently;
never edit a sealed version to fill a previously unknown identity. If create times out before an external ID
is recorded, reconcile provider state before retrying creation; titles alone
cannot prove ownership. Do not interpret a timeout as proof of no mutation.

Prefer a new pending provider target when a configuration change cannot be
proved safe in place. The prior complete active version remains the active
pointer while pending work is incomplete. This protects local readiness; it
cannot undo an in-place provider mutation. An ambiguous or partial in-place
update therefore suspends delivery/readiness until readback resolves actual
provider state. Never claim the old provider configuration survived by assumption.

Activation requires exact configuration readback, complete required initial ARI
acceptance/readback, and a compare-and-swap against the expected active version,
pending version, binding generation and current publication/owner evidence.
Stale completion cannot advance the active pointer. Failure retains historical
identity and a visible failed/reconciling operation; it cannot mark readiness.

VAY-1530 supplies meal identity mapping/readback. VAY-1545 then proves combined
guest-aware inclusive amounts. VAY-1528 supplies equivalent restriction/reset
semantics. Unknown occupancy, child, meal or restriction support blocks activation;
do not infer support from a matching label or a successful HTTP response.

## Amount ownership and dispatch

For the new shared-base target, Vayada sends the inclusive calculator total
without a channel markup. Native channel adjustments have one separate owner;
they are not baked into this shared rate. A three-person room total is one room
total, not three times that total. Meal amounts use the represented guests.
Retained old target adjustment behavior is not automatically migrated or applied
to the new target. No operation may combine both adjustment owners.

Durable dispatch records bind each property-local date/occupancy item to the job
lease, publication and source evidence, connection binding generation, target
version and exact external IDs. Serialize writes for the external rate so a new
generation cannot overtake an unresolved prior request. Release database locks
before HTTP, but retain durable ownership of the dispatch/reconciliation state.

Recheck fresh authority and target/publication evidence before sending and before
recording success. Database generation checks prevent stale local completion;
they cannot cancel an in-flight provider request. Lease loss, transport ambiguity,
partial rejection or warnings require reconciliation per affected item before a
later generation proceeds. HTTP status alone never marks the whole batch accepted.

## Implementation and proof

1. Add target/version persistence and ownership constraints, with transaction tests
   for cross-property references, competing pending versions, external-ID ownership,
   immutable history, interrupted create/sealing and stale activation. Test delayed
   initial reservation delivery and modifications across an in-place change: no
   unsupported historical-version inference. No provider writes in that schema step.
2. Add the job-authorized target planner/writer using the existing reader and
   candidate adapter. Test removal, replacement, exact occupancy/currency/meal
   identity, one primary option and unsupported states without partial activation.
3. Implement serialized dispatch, per-item response classification and readback
   reconciliation. Test stale leases, reverse completion order, partial warnings,
   unknown create results and failure after an in-place mutation.
4. Run bounded provider configuration and inclusive-amount readback only within an
   authorized fixture window. Verify OTA behavior separately where supported;
   simulator or Channex acceptance is not Expedia onboarding evidence.

Keep `PRICING_UNAVAILABLE` until these gates and the meal/restriction dependencies
are satisfied. Preserve shared fixtures owned by other active tasks. No production
change, reservation, payment, deployment or merge follows from this decision.

## Explicit primary occupancy (VAY-1983)

The hotel chooses the standard adult guest count during channel setup. This is a
provider setup choice, not a pricing formula or an inferred room-capacity default.
Do not derive it from included-guests base counts; those can vary by calendar row.

The reservation entrypoint requires `primaryOccupancy`, an integer from one to the
current published room's adult capacity. The pending proposal retains the choice;
changing it with the same operation key is a conflict. Existing intents without a
choice cannot become valid by retrying with a guessed default. They require an
explicit replacement operation through the later cancellation/reconciliation flow.

Provider options must eventually mark exactly this guest count primary while
retaining every supported occupancy price. Missing, unsupported or stale choices
block activation. This slice adds backend validation/storage; the hotel-facing
control, provider configuration and activation remain separate implementation work.

## Closed configuration planning (VAY-1985)

Pending proposals now retain a manual per-person configuration fragment with all
adult occupancy options, the explicit selected primary, currency and meal type.
Linked local prices are materialized manually; provider rate inheritance is off.
No rate amounts or zero-price placeholders are introduced by this planner.

Every default weekday starts stop-sell closed. This fragment is not a complete
create request: exact provider identity, scoped request construction and closure
readback are still required. Channex defaults alone do not establish a closed rate.
Daily ARI, equivalent restrictions and initial price/readback must be complete
before sales open. Provider capability/OTA support is not implied by this plan.

Rooms permitting children currently return an explicit unsupported state; their
child capacity is never silently removed. The local 100-option bound matches the
nightly adapter and is not a claimed provider limit.

## Configuration metadata readback (VAY-1988)

The GET-only verifier derives expectations from the strict planner and checks
meal identity against the same response through the existing meal helper. It
requires exact property/room/rate identity, currency and manual per-person mode,
all independent occupancy options with the chosen primary, disabled rate and
stop-sell inheritance, no automatic pricing and seven closed default weekdays.
Provider option ordering and unrelated metadata do not affect comparison.

Missing explicit evidence fails closed: option derivation must be null, automatic
pricing must be null, and no parent must be explicit in attributes or the parent
relationship without a contradictory identity. A provider response omitting those
fields is unavailable until its semantics are verified; absence is not inferred
to mean independent pricing. Caller expectations are captured before provider IO.

This returns metadata evidence only. It does not verify option rate amounts, daily
ARI closure, restriction equivalence, OTA capability or activation readiness.
Binding evidence to the current pending intent and fresh authority, durable create
recovery, transactional sealing and initial ARI remain separate requirements.
Provider response shapes follow the [official rate-plan documentation](https://docs.channex.io/api-v.1-documentation/rate-plans-collection),
checked 2026-09-12; automated fixtures are not live provider proof.

## Durable creation uncertainty (VAY-1994)

Before a future HTTP create, persist one creation attempt for the pending intent.
Its immutable record retains the reserved target/version, binding generation,
external property/room and exact request body. It starts `unresolved`: this means
creation may have happened, including a crash immediately after recording it.
Neither a new worker nor a new intent may interpret that state as permission to
send another create. At most one unresolved creation exists per logical target.
Failing or superseding its intent does not clear this exclusion.

An exact external rate identity transitions the record to `identified` and claims
the existing cross-store ownership registry atomically. Conflicting ownership
rolls back identification. The attempt and its request remain retained, and an
identified attempt cannot change or be reused for another create. Recording an ID
is not configuration verification, an active target or proof of supported OTA
semantics. Immutable target versions are still sealed separately.

The storage boundary does not authorize provider access or validate request
semantics. The job-authorized writer must derive and persist the complete request
under current publication/owner/binding checks, commit before HTTP, and only the
successful fresh claimant may make the first send. Losing its commit response
leaves unresolved work; a retry cannot reconstruct a send permit from the row.
The HTTP dispatcher and capture/reconciliation services remain unimplemented.
There is deliberately no automatic reset or timeout-based takeover. Resolving a
known no-mutation rejection requires separate verified semantics before adding a
retry transition; titles alone cannot identify an ambiguous creation.

## Job-authorized creation claims (VAY-1995)

`claimPublishedChannexOfferCreate` shares the bounded published-pricing transaction
with reservation and the read-only service reader. It derives the closed request
from current published pricing, explicit primary occupancy, binding generation and
the active local room mapping under locks. The provider title is display data,
never a recovery/adoption key. Caller-supplied provider bodies and IDs are excluded.

Only a newly inserted creation attempt can produce a claim, after final authority
checks and commit. An existing attempt cannot reconstruct a claim, even after a
lost commit response. A prior unresolved creation for the target blocks replacement
work; identified attempts remain retained. Denials roll back new target/intent and
attempt writes. Reservation and read-only entrypoints keep their prior responses.

This entrypoint records local work; no runtime caller sends its body yet. Exact
provider room identity/capability preflight and fenced HTTP dispatch remain required.
Local mapping evidence alone cannot prove that the external room still belongs to
the expected provider property. Initial ARI, readback sealing and activation stay
separate gates. The returned creation claim is not activation permission.

## Provider room preflight (VAY-2000)

The GET-only `verifyChannexOfferRoom` checks the exact room/property identity and
whole-room representation against the strictly parsed published adult capacity.
Conflicting attribute/relationship IDs, unsupported room kind, non-null dorm
capacity, mismatched adult capacity and nonzero or missing child/infant capacity
fail explicitly. It captures expectations before IO and returns metadata only.

The provider room's `default_occupancy` is not the hotel's per-rate primary choice;
preflight never copies or substitutes it. The exact supported room response shape
follows the [official room-types documentation](https://docs.channex.io/api-v.1-documentation/room-types-collection),
checked 2026-09-12. Fixtures validate parsing, not live compatibility. Freshness
binding to the durable attempt/current authority, HTTP dispatch and outcome
capture still need composition. Passing this helper does not enable provider writes
or establish downstream OTA capability.

## Creation identity recording (VAY-2001)

`recordPublishedChannexOfferCreate` captures primitive property/room/rate IDs from
a provider response before asynchronous work, rejecting malformed or contradictory
identity fields. It verifies the same pending proposal and current authority, then
matches the retained attempt's generation, scope and exact derived request under
the active local room-mapping lock. Identification atomically claims external
ownership. Exact repeats while the intent remains pending are idempotent; a
different rate ID conflicts. No configuration version is sealed or activated.

Only responses correlated by the dispatcher to this attempt belong here; a GET
or title match is not creation/adoption proof.
This records identity, not HTTP/ARI acceptance. Unknown transport outcomes remain
unresolved, and late observations rejected by current authority require separate
reconciliation. Durable raw-receipt capture after authority loss is not implemented.
The database simulation composes room preflight, fresh claim, a mocked create,
identity recording and configuration readback; it is not a production dispatcher
or proof of live Channex/OTA behavior. Runtime sending remains disabled.

## Late creation receipts (VAY-2002 decision)

The next implementation must separate retained observations from authorized
completion. `pmsChannexManagementWorkerStore.complete` checks its lease before
writing its outcome, and `recordPublishedChannexOfferCreate` requires current
pricing authority. Neither is a late-response inbox. Do not weaken either check
or put receipt retention in the transaction that can roll back identification.
This section is a contract; receipt storage and dispatch are not implemented yet.

### Correlation and send boundary

Extend the fresh creation claim with immutable correlation to the original
`platform.job_attempts` row and worker. Persist that correlation in the same
transaction as the creation attempt, matching the verified lease. Existing
attempts lacking it remain held; never backfill a new worker as their sender.
The retained attempt already supplies target, intent, generation, exact external
scope and request body. Avoid copying these into an independently mutable receipt.

The dispatcher owns a closure containing the fresh committed claim and its
original correlation. It accepts no caller-selected provider body, receipt
destination or external IDs. Only that fresh invocation can send once; database
recovery, job replay and receipt retries cannot reconstruct a send permit.
Before POST, recheck current authority/proposal/mapping and verify provider room
preflight against those exact expectations. Recheck local authority after the
GET. Any mismatch or failed check leaves the durable attempt held without POST.
Release transaction locks before HTTP. The last local check cannot prevent a
provider mutation after a subsequent revocation; preserve that uncertainty and
require current authority again for identification and later activation.

### Append-only capture

Add a server-only receipt writer with no product route. It appends observations
to an existing attempt using the dispatcher's original job-attempt correlation,
even when the lease expires, the binding changes or the intent stops being
pending. Validate that persisted correlation, not current worker ownership.
Knowing a target ID or presenting a replacement lease is insufficient. This is
an internal trusted-code boundary, not proof supplied by a UUID alone.

Each observation has a UUID generated once when the transport outcome is
captured, the attempt foreign key, database capture time and an immutable outcome
envelope. Persisting the same UUID and identical envelope is idempotent, including
after a lost commit reply; the same UUID with different content is a conflict.
Different observations are retained separately, never last-write-wins. Conflicting
identities or outcomes keep reconciliation required; do not pick the first or
latest as truth. Updates, deletes and reassignment to another attempt are denied.

The existing unresolved-attempt index is insufficient once an attempt has become
`identified`. Fresh claims, sends, sealing and activation must also check retained
observations across the logical target's attempts. Missing required correlation
or receipts, incomplete/error/warning observations and incompatible identities
are a reconciliation hold even after identification. Derive this gate from retained
evidence rather than resetting immutable attempt state. Only the current fresh
dispatch closure's newly committed, not-yet-sent attempt is exempt from the
missing-receipt check for its first POST. Prior or recovered attempts are never
exempt; neither sealing nor activation has this exemption. Clearing a hold needs
a separately defined, audited reconciliation decision; this contract adds no reset.
Capture, identification and claim/gate checks serialize on the same logical target
row, acquired before intent/attempt locks, so concurrent inserts cannot evade the
check. A conflict arriving after an authorized send cannot cancel that request;
it blocks subsequent work and activation, retaining the in-flight uncertainty.

Capture must commit before calling current-authority identity recording. It must
not read unpublished/current pricing, claim external ownership, identify attempts,
seal versions, complete jobs, release unresolved exclusion or activate sales.
This narrow audit write remains permitted after authority loss; it does not grant
the old worker permission to continue provider IO. Reads of retained evidence
remain an internal reconciliation operation with property/connection scope.

### Bounded evidence

Retain a sanitized transport observation, not arbitrary response dumps. Limit
response consumption to 64 KiB decoded bytes and a finite request/body deadline;
this is a local resource bound, not a claimed Channex limit. The envelope records
HTTP status when received, an allowlisted bounded provider request ID, and one of
`complete_json`, `invalid_json`, `body_limit`, `body_interrupted` or
`transport_error`. Do not persist headers, cookies, authorization, URLs containing
credentials, stack traces, arbitrary error text or unknown response metadata.

For complete JSON, retain only the resource type and identity fields consumed by
`readChannexCreatedRateIdentity`, including both attribute and relationship IDs
and explicit missing/invalid markers. Do not coerce, trim or discard contradictory
IDs to make them valid. Identity strings have a local 512-byte bound; over-limit
values become invalid markers, never truncated IDs. Non-identity warnings are a
bounded presence/classification marker, not free-form text. This evidence is for
identity reconciliation only; it cannot replace configuration or ARI readback.
Malformed, oversized and interrupted bodies retain their outcome classification,
not a partial body mistaken for a complete response. No receipt means unknown,
not proof that a request was never sent. The earlier phrase “raw receipt” refers
to an unaccepted observation; it does not require storing unfiltered wire bytes.

### Failure and reconciliation

Only persistence of a captured observation may be retried using its original
UUID and envelope. A database outage or process crash after POST can still lose
the response before persistence; do not promise exactly-once provider creation.
The retained unresolved attempt blocks another POST, and an operational failure
must report reconciliation required using identifiers and sanitized codes only.

A retained receipt is evidence, not permission to identify. Reconciliation must
check its original dispatch correlation, all conflicting observations, exact
identity and current authority/proposal/binding through the existing recorder.
An HTTP error containing an ID or a warning is not successful creation proof;
keep it held for separately verified provider semantics. A failed, replaced or
stale intent may retain evidence without becoming eligible for the current
recorder. Transferring such an identity to a new intent needs a separate explicit
reconciliation contract; never adopt by title, clear a timeout or mutate history.

### Required implementation checks

- Real PostgreSQL tests: retain a receipt after lease expiry, publication/binding
  change and failed intent; identification denial does not roll back the receipt.
- Reject missing/wrong attempt or original job correlation. Concurrent duplicate
  capture yields one identical row; changed duplicate payload conflicts and
  distinct conflicting observations remain visible. History is immutable.
- A conflict appended after identification blocks a replacement claim and sealing;
  concurrent capture/identification/claim tests verify target-lock ordering and
  the retained-evidence gate. A conflict during HTTP prevents later activation.
- Simulated dispatcher: at most one POST after preflight/current checks; changed
  scope after GET prevents POST. Crash/lost commit before send grants no replay.
- After POST, timeout, body failure, oversized response, capture failure and lost
  receipt commit reply never cause another POST. Persistence-only retry preserves
  the receipt UUID; malformed evidence and warnings do not become success.
- Authority expiry after identification UPDATE rolls back identity/ownership while
  preserving the independently committed receipt; concurrent identification cannot
  transfer ownership. Active pointers and `PRICING_UNAVAILABLE` remain unchanged.

### Receipt storage foundation (VAY-2003)

Migration 0195 adds optional immutable original job-attempt/worker correlation to
creation attempts and append-only receipts referencing that exact tuple. Existing
uncorrelated attempts cannot acquire correlation through an update. Correlation
inserts require a matching job worker and property; the authorized claim service
must still verify current lease and persist this tuple before any send.

Receipt inserts lock the logical target and assign database capture time, without
requiring current lease or pending intent. Storage enforces outcome/status shape,
an 8 KiB identity object bound and a 512-byte provider-request-ID bound. These are
structural checks, not response sanitization or provider acceptance. Distinct
observations remain retained; duplicate UUID inserts cannot overwrite history.
The capture service must implement exact-envelope idempotency and sanitization.

This migration does not wire correlation into claims, implement the aggregate
receipt gate or send HTTP. Those services and their race tests remain required
before enabling dispatch. Uncorrelated old attempts grant no recovered send.

VAY-2004 now populates original correlation in the authorized fresh-claim INSERT
from the already locked job attempt and returns those persisted IDs only after
commit. A reclaimed worker cannot replace that correlation or recover a send
claim. Receipt sanitization/capture, aggregate gates and dispatch remain pending.

VAY-2005 adds a pure projection of already collected HTTP response text. It checks
the 64 KiB UTF-8 limit before parsing and keeps only tagged identity fields and
container presence, with 512-byte field bounds. Control characters are invalid
markers; other strings retain exact whitespace and contradictory values. Request
IDs allow ASCII letters, digits, dot, underscore, colon and hyphen only. Warnings
and errors become conservative boolean markers, never arbitrary message text.
The tagged evidence is not a provider response to pass directly to the identity
parser. Later reconciliation must interpret the markers explicitly. Streaming
limits/deadlines before this helper, transport-error capture, database idempotency
and aggregate gates still need implementation. Parsed JSON never implies success.

VAY-2006 adds `readChannexCreationResponse` after headers arrive. It snapshots
status/request ID, reads at most 64 KiB of stream bytes within five seconds and
uses fatal streaming UTF-8 decoding before the sanitizer. Oversize, read failure,
invalid UTF-8, timeout or an already consumed/locked body produce no partial
identity evidence. Cancellation is best-effort and is never awaited. This bounds
body consumption only: the future dispatcher must also bound fetch before headers.
No HTTP request is initiated by this helper; database capture and gates remain.

VAY-2007 adds `prepareChannexReceiptPersistence`: it snapshots original dispatch
correlation, consumes/sanitizes the supplied Response once, and returns a closure
that retries only database persistence. The closure matches exact property,
connection, creation attempt, original job attempt and worker, locks the target,
then inserts or compares the immutable receipt. Exact repeats return the retained
UUID; changed evidence conflicts. Database capture commits independently of job
completion and never identifies or activates a target. It remains valid after
lease, intent or binding changes because it grants audit retention only.

The caller must bound pool acquisition. Statements have a five-second timeout,
locks a 150 ms timeout, and target contention fails immediately. A lost commit
reply may be retried using the same closure without consuming or sending HTTP
again. This entrypoint is trusted server code, not public authorization. Transport
errors before a Response, aggregate reconciliation gates and dispatcher wiring
remain pending. Retaining conflicting observations does not resolve them.

VAY-2008 adds the fresh-claim retained-evidence gate. All prior attempts must be
identified with original correlation and at least one complete HTTP 201 receipt;
every retained receipt must be warning-free and match that attempt's exact
property/room/rate through the existing identity parser. Tagged missing/invalid
fields are interpreted explicitly. More than 1000 joined evidence rows is a local
work-limit hold, never permission to ignore older history. A target with no prior
attempts passes this history check, subject to the existing authority checks.

Receipt persistence also performs a no-value-change target UPDATE under its lock.
This advances the PostgreSQL row version so an older SERIALIZABLE claim snapshot
cannot miss a committed receipt merely because it acquired the row lock later.
Runtime receipt writers must use this persistence path; the storage-only INSERT
trigger's row lock does not provide snapshot invalidation. The gate assumes its
caller already holds the target lock. Dispatcher, sealing and activation must
apply the same gate separately; this slice wires fresh creation claims only.

VAY-2009 adds `prepareChannexOfferDispatch`, which obtains a fresh claim internally
and returns a one-shot dispatch closure. It snapshots lease/selection, consumes
the closure before asynchronous work, and checks current authority, exact derived
request, generation and original job correlation before GET and after room
preflight. Only its own unresolved attempt with no receipt may be excluded from
the history gate. Prior/recovered attempts never gain a dispatch closure.

Injected GET/create ports receive abort signals and 15-second deadlines; this
composition has no runtime HTTP adapter. An ambiguous failure leaves retained
unresolved work. A received Response uses bounded receipt persistence: a failed
database write returns a persistence-only retry closure, never a second send.
Retained means audit capture, not identification or success. Pre-Response failure
receipts, configuration sealing and activation remain pending. Revocation after
the final local check cannot cancel a provider mutation; reconciliation is still
required for that in-flight window.

### Retained response identity handoff (VAY-2010)

`recordRetainedChannexOfferCreate` accepts an attempt ID with the current job
lease and target selection. It reads original correlated receipts under the
existing target lock, reuses tagged evidence parsing, and requires at least one
complete, warning-free HTTP 201 response with consistent exact identity across
all receipts. More than 1000 current-attempt receipts fails closed; other attempt
history uses the existing bounded gate. Current proposal, binding, room mapping,
request and owner checks still precede atomic identity ownership recording.

Exact pending retries return the same identity. Failed authority or conflicting
evidence never removes independently committed receipts. The older raw-observation
recorder remains an internal compatibility helper; retained evidence consumers
use this entrypoint. Neither path seals configuration or activates delivery.

### Pending configuration observations (VAY-2011)

`retainChannexOfferConfiguration` checks a current identified attempt and all
retained creation receipts before a bounded injected GET. It snapshots the lease
and selection, releases database locks for IO, and reuses the exact configuration
verifier. After GET it repeats proposal, binding, request, owner and receipt-history
checks before saving anything. Unresolved attempts cannot use GET to gain identity.

The pending intent's `result_evidence.configuration` holds a deterministic
`schemaVersion: 1` projection: attempt ID, intent ID, reserved version, binding
generation and the verifier's exact IDs/meal/configuration observation. Unrelated
evidence keys survive; matching retries are accepted and different existing
configuration evidence is held for reconciliation. Arbitrary provider metadata is
not retained.

This records a past metadata observation only. No version is sealed and no active
pointer changes. Later consumers must recheck current authority, receipt history
and required capability/ARI/readback evidence; this field never grants readiness
or proves that provider configuration remained unchanged afterward.

### Creation transport failure receipts (VAY-2012)

A thrown or timed-out injected creation call now uses the same correlated receipt
transaction to retain a fixed `transport_error` observation: null status/request
ID, empty identity evidence and a conservative warning flag. Exception strings
and arbitrary metadata are never copied. Room preflight and pre-send authority
failures do not create this receipt because creation was not invoked.

Successful persistence still returns reconciliation required and leaves the
attempt unresolved. Database failure exposes the same persistence-only retry
closure. No path restores the consumed send opportunity or treats an abort as
proof of no provider mutation. A provider that ignores abort may finish later;
this receipt records ambiguity, not cancellation or safe retry.

## Hotel configuration preview (VAY-2014 decision)

The first visible integration is a preview inside PMS Channel Manager. It uses
published replacement offers, not legacy rate-plan mappings. The pricing editor
remains owned by the pricing task; Booking authority migration 0202 is not a
prerequisite. Existing connected-channel status remains unchanged.

### Selection and read contract

Use `GET /properties/:propertyId/channex/offer-preview` with exactly
`roomTypeId`, `offerId`, `publicationRevision`, and `primaryOccupancy` query fields.
Require canonical UUID property/room IDs, a nonempty trimmed offer ID up to 200
characters, an integer revision from 1 through 2147483647, and an integer primary
count from 1 through 100. Reject duplicate, unknown, fractional and noncanonical numeric query values
with 400. Accept primary only within the selected published room's adult capacity;
the existing planner's 100-option bound and unsupported-child checks still apply.

Authorize through the real request context before reading pricing. Require both
`pms.operations.read` and `pms.rooms_rates.read`, active PMS property-management
entitlement, and owner/operator relationship to the exact selected property in the
selected hotel organization. Channel Manager's broader front-desk read access does
not automatically authorize pricing preview. Reuse `enforceRoutePolicy` and the
existing user/property-authorized pricing read boundary; do not call the worker
reader with a fabricated lease. Both permission checks and property authorization must be repeated by the storage
guard in the read transaction. Never accept caller-selected organization/actor IDs.

Read only the current published snapshot through the shared decoder and source
freshness guard. A missing publication returns 404; a revision mismatch or stale
source result returns 409 with a refresh-required code. Missing room/offer returns 404. Invalid stored evidence or unavailable storage returns a sanitized 503.
Do not silently use a draft, stale publication, another offer, or a legacy rate.
The bounded metadata preview does not establish current delivery-owner readiness.

Call `planChannexOfferConfiguration` with the server-read room and explicit choice.
Return a versioned response with property/room/offer IDs, publication revision,
primary count, and either `preview` plus the planner's validated configuration or
`unsupported` plus a stable allowlisted reason. Never return arbitrary errors,
provider credentials, operation IDs, jobs or external rate IDs. The response has
`canProvision: false` and `canSend: false`; no fields imply an active mapping.
The adapter must bound connection acquisition/query duration and response size;
project only this one offer's configuration (at most 100 occupancy options).

This endpoint makes no provider calls and writes no target, intent, preference,
job, audit/outbox mutation or mapping. No creation/reservation helper is needed.
Use `Cache-Control: no-store`; publication/source checks describe the time of the
read, not a continuing promise of freshness or actual Channex support.

### Hotel interaction

List rooms and offers from the existing authorized published-pricing read. Render
labels as text. Hide the preview controls when the user lacks either permission;
the server remains authoritative. Do not relabel existing legacy mappings.

The primary guest-count selector starts empty even when capacity is one. Label
it “Primary guest count” and explain that it is the default occupancy option for
the channel rate, not a price multiplier. The hotel must choose it. A room/offer,
property or publication change clears the choice and preview. Preview selection
is local component state only; reloading does not save or restore it. A later
provisioning command must explicitly persist a validated choice under its own
contract, not assume this preview saved a preference.

Disable preview until selection is complete; show loading while reading. Discard
responses for previous property/room/offer/revision/count selections. A stale
response prompts a published-pricing refresh and a new selection. Missing pricing
links to the existing pricing setup. Unsupported child/capacity cases and storage
errors have clear messages and do not display an old successful preview.

Show currency, meal identity, supported occupancy options and chosen primary in
human-readable form. State “Preview only — nothing has been sent to channels.”
Explain that live setup still requires connection/mapping, supported booking-rule
semantics, and verified initial price/restriction delivery. These are outstanding
requirements, not a diagnostic claim about this property's provider account.
Do not add a functional create/sync button or change existing sync controls in
this slice. Existing provider connection status is not inferred from this preview.

### Implementation verification

Require route tests for missing/invalid auth, either permission missing, inactive
entitlement, wrong/unlinked property, front-desk-only relationship and an allowed
owner/operator. Test strict query parsing, missing/stale publication, exact
selection, unsupported planner states, bounded output and no mutation/provider
calls. Use meaningful PostgreSQL source-freshness and tenant-isolation coverage.
UI tests and browser verification cover explicit selection, preview values,
loading/error/unsupported states, property/selection races and clearing stale
results. Report simulated preview evidence separately from provider validation.

## Restriction equivalence and reset acceptance (VAY-1528)

This contract defines the evidence still required before generic published-offer
activation. It does not certify Channex fields or any connected OTA. VAY-1528
owns the mapper and its verification; VAY-1545 consumes that result. The missing
BookingCom channel in the VAY-2013 staging fixture is a separate provider blocker,
not a reason to substitute different booking rules or introduce OTA rate variants.

### Reuse the canonical result

`projectReplacementRoomNight` already returns `night.restrictions` and
`night.restrictionOfferId`; `prepareChannexAdultNightPrices` retains them inside
each candidate projection. Reuse that effective result from the authorized
published snapshot. Do not implement a second season resolver in the exporter.
Exact dates override seasons, which override the restriction owner's base rules.
Linked prices do not imply provider-side restriction inheritance: the calculator
resolves the restriction owner independently and the exporter materializes it.

| Canonical value     | Required booking meaning                                                            | Canonical unrestricted value |
| ------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `minArrivalNights`  | Compare total stay length with the arrival date's minimum only                      | `1`                          |
| `maxStayNights`     | Compare total stay length with every occupied night's maximum; the tightest applies | `null`                       |
| `closedToArrival`   | Reject arrivals on the specified date, not stays crossing that date                 | `false`                      |
| `closedToDeparture` | Reject departures on the checkout date, which is not an occupied night              | `false`                      |
| `stopSell`          | Reject a stay occupying any affected night of the selected offer                    | `false`                      |

These are canonical values, not asserted wire reset values. The mapper must
establish the exact provider setting and clearing representation for each field,
including how an inherited/default provider value is overridden. Missing fields,
HTTP acceptance, or similarly named provider fields do not establish equivalence.
Do not translate `null` maximum to a large finite number or silently use an
arrival-only maximum for the occupied-night rule.

### Minimum verification matrix

Use bounded synthetic fixtures with exact property/room/offer/date identities.
Run canonical calculator expectations first, then the mapped provider state,
and separately record observed channel enforcement where a channel is available.

| Fixture                                                    | Required result                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Friday arrival minimum 3                                   | Friday–Sunday rejected; Friday–Monday accepted                                                      |
| Sunday minimum 3; Saturday arrival minimum 1               | Saturday–Monday accepted, absent other restrictions                                                 |
| Base maximum 14                                            | A 14-night stay accepted; a 15-night stay rejected                                                  |
| Saturday maximum 14; Sunday maximum 2                      | Saturday–Tuesday rejected despite arrival maximum 14; Saturday–Monday accepted                      |
| Sunday closed to arrival                                   | Sunday arrival rejected; Saturday–Monday accepted                                                   |
| Monday closed to departure                                 | Saturday–Monday rejected even though Monday is outside its occupied nights                          |
| Sunday stop-sell on offer A only                           | A's Saturday–Monday stay rejected; unrelated offer B unaffected                                     |
| Parent minimum 3; child price −10% inheriting restrictions | Child two-night stay rejected; explicit child minimum 2 accepts; clearing override restores 3       |
| Date override inside a seasonal interval                   | Date wins on that date; season resumes the next date; base resumes after the inclusive seasonal end |
| Remove or shorten a rule after delivery                    | Previously affected dates receive their current fallback, including explicit unrestricted values    |

For maximum stays, the varying Sunday example is mandatory: a constant maximum
cannot distinguish arrival-only behavior from occupied-night behavior. Test CTD
on the actual checkout date; inspecting only occupied-night payloads misses it.
A conflicting rule vector must fail validation, not be repaired or weakened by
the exporter. Existing price and availability evidence must remain unchanged by
restriction-only updates.

### Delivery and capability boundary

A later implementation must cover the union of previously delivered affected
dates and newly affected dates within the managed horizon. Re-read current
published rules on retry; removal is a new complete desired vector, not omission
of the old fields. Keep unresolved delivery ownership until ambiguous requests
are reconciled so an older write cannot restore a cleared restriction. Newly
opened dates require complete rules before readiness. The scheduling contract
must also cover checkout dates for allowed arrivals near the horizon boundary;
never assume CTD is covered merely because every priced night was sent.

Record setting and clearing evidence separately, correlated to the external
property, room, rate, connection/binding generation, current publication and
restriction owner. Provider readback proves stored provider state only. Channel
support must identify the actual connected channel and verified semantics; an OTA
code or a generic Boolean supplied by a caller is not capability evidence.
Unknown or non-equivalent semantics keep the affected channel/offer unavailable;
they do not certify the whole connection or unrelated channels. Preserve the
existing activation and current-authority checks in this document.

The next implementation slice is the bounded field/reset mapper plus its
canonical-equivalence fixtures after provider semantics are verified. Durable
initial delivery/readback and activation consume that verified mapping afterward.
No provider request, readiness transition, or runtime sender is enabled by this
contract change.

### Current pending-target restriction observation (VAY-1528)

`readCurrentChannexNightRestrictions` composes the nightly readback with the
existing current-publication and identified-creation boundary. It obtains the
room configuration, terms revisions and provider IDs from that boundary, calls
one bounded GET, then repeats the lease, publication, owner, binding, mapping,
pending-intent and complete creation-receipt checks. The reservation, provider
identity and publication must still match before the observation is returned.
Caller-owned selection and lease objects are copied before asynchronous work.

The returned observation carries its attempt, target, intent and version. It is
not persisted, a provider write acknowledgement, an OTA semantics certificate,
a future send permit or an activation decision. A sender must still establish
its own current authority and complete initial ARI requirements. No runtime
sender is connected by this entrypoint.

### Durable initial rate/restriction attempts (VAY-1545)

Before any initial rate/restriction POST, commit one attempt for one property-local
calendar date, containing the complete occupancy-rate array and explicit daily
restrictions. A date's occupancies travel together; neither an accepted subset nor
HTTP 200 alone proves completion. The request body is immutable and bounded to
64 KiB. Its exact semantic validation remains the materializer's responsibility.
The operation references an identified creation attempt, its pending intent and
version, binding generation, exact provider property/room/rate IDs, and the
original job-attempt/worker correlation. The creation attempt already links the
immutable publication/source proposal; do not copy or reinterpret pricing rules.

A unique unresolved attempt for the external property/rate pair serializes all
its dates and generations, including a connection replacement that references
the same provider IDs. This deliberately favors correctness over throughput for
initial uploads. Another rate remains independent. Losing a lease, expiring a
job, changing the intent or losing the response never releases this exclusion.
No automatic resend or timeout reset is allowed. Original dispatch evidence must
be retained independently of current lease state before reconciliation.

The database permits only an unresolved-to-reconciled transition with retained,
nonempty reconciliation evidence; identities, request, timestamps and terminal
rows remain immutable. That storage transition is not a public API or readiness
proof. The later service must establish definitive completion of the original
request (including potential late completion), complete response/warning/partial
item accounting, exact price/restriction readback and current ownership before
releasing exclusion. Readback by itself cannot prove an old request will not
finish later. Unknown outcomes remain unresolved for explicit recovery.

Storage insertion requires the identified creation, exact pending intent,
current binding and same-property job-attempt correlation. The service must also
check its live lease, complete creation receipt history, publication/owner
freshness, capability and exact materialized payload under the existing target
lock. Storage alone authorizes no HTTP, retry, sealing or activation. A fresh
claim must return a one-use dispatch closure; a retried claim never restores it.
Do not enable a caller until its receipt and reconciliation paths are complete.

This lane covers rate-plan prices and restrictions. Room availability has a
separate room-scoped owner shared by every rate plan; a rate-plan exclusion must
not pretend to serialize it. Complete initial ARI additionally needs current
room availability evidence, bounded horizon/date coverage, all occupancy and
restriction observations, and activation CAS. Sales remain unavailable until
all existing configuration, semantics and activation gates pass.

Storage tests must prove immutable request/correlation, same-property scope,
identified pending creation, binding matching, one unresolved rate across dates,
concurrent claim exclusion, other-rate independence, and no implicit release
following intent failure. A real sender and its late-response tests follow this
storage dependency; this contract does not authorize provider writes.

### Current-publication initial ARI claim (VAY-1545)

`claimPublishedChannexInitialAri` commits local ownership for one validated date.
It reuses the locked current publication, owners, explicit primary occupancy,
identified creation and complete receipt gate. Exact retained configuration
observation must match that attempt, intent, version, binding and manual plan.
The existing nightly calculator supplies every adult occupancy's inclusive room
total and explicit restriction values. Zero totals cannot form provider rates;
there is no partial occupancy claim or additional channel markup.

The immutable request follows the official [ARI multi-occupancy format](https://docs.channex.io/api-v.1-documentation/ari):
one `values` item with property/rate IDs, date, `rates` occupancy/decimal pairs and
six explicit restriction fields. Identity comes from the current creation gate.
Insertion and final owner/lease checks share one transaction; losing authority
rolls back the attempt. An existing unresolved provider-rate attempt returns
`ari_reconciliation_required`, including a retry for the same date. The result
contains only durable correlation IDs, never the request or a callable sender.

This is local ownership only. Provider capability, property-local current-date
and horizon admission, closure while staging, fresh bounded dispatch, retained
original-response evidence and authoritative reconciliation remain required
before any runtime sender can consume it. No HTTP, readback completion, release
of unresolved ownership, room availability or activation is added here.

### Original ARI response evidence (VAY-1545)

ARI responses are observations, not completed delivery. Preserve HTTP status,
a bounded safe request ID, at most100 distinct UUID task IDs from an entirely
valid task list, and conservative warning presence. Missing/malformed tasks,
malformed/nonempty warning metadata and root errors/warnings do not
produce clean evidence. Omitted warnings require explicit `meta.message=Success`
as observed in a retained original provider response; absent success metadata
remains ambiguous. Explicit null/object/string warnings never mean empty warnings. Do not retain response messages, echoed payloads,
credentials or exception text. Even a clean200 task acknowledgement does not
release unresolved ownership or grant activation.

The September14 closed-flow receipt retained an ambiguous warning flag despite
later exact task and value observations. That historical flag cannot establish
which condition occurred. Capture a bounded `warningReason` enum for future
responses: `invalid_tasks`, `root_errors`, `root_warnings`, `invalid_meta`,
`invalid_warnings`, or `provider_warnings`, in that precedence order. Use null
for a clean response or a non-JSON outcome already explained by `outcome`.
This records the first blocker only, never provider text or a complete warning
inventory. Preserve the existing `hasWarnings` calculation and admission gate.
Persist the classification with the same immutable receipt; old rows remain
unclassified, with no backfill from later GETs or fabricated response evidence.

The [official ARI response contract](https://docs.channex.io/api-v.1-documentation/ari)
shows an empty `meta.warnings` array on clean acceptance and warns that HTTP200
can include rejected items. A retained September14 original response also shows
`meta: {message: "Success"}` with warnings omitted. Accept that exact alternate
success metadata with the same valid-task/root-error checks. Do not accept null
or other malformed warning values, or infer success from missing metadata.
Successful task/readback evidence cannot make a warning-bearing original receipt
clean, and earlier classified receipts are not rewritten by this parser change.

Creation and ARI share a response-body reader with the existing64KiB UTF-8 and
five-second bounds; their evidence parsers remain separate. Original-response
receipts must bind to the upload attempt/job/worker and remain append-only after
lease loss. Receipt insertion must fence the target row so an older transaction
cannot reconcile from a stale receipt snapshot. Repeat persistence uses the same
receipt ID and exact evidence; it never reissues HTTP. Storage and bounded
capture precede a runtime dispatcher and authoritative reconciliation service.

### Closed initial ARI staging (VAY-1545)

Every new initial ARI request explicitly sends `stop_sell: true`, including when
the current published offer is sellable. Rates and the other five restriction
values still come from the unmodified calculator projection. The staging closure
belongs to provisioning; it does not overwrite the hotel's desired restriction.
A caller cannot opt out of closure. This prevents the initial rate payload from
opening a pending rate ahead of availability, semantics and activation checks.

The initial desired-rule readback helper cannot certify this staging payload:
it compares the hotel's desired stop-sell, which may be false. A future stage
readback must compare the exact persisted closed request; desired-state readback
and opening sales belong to the later activation operation. No stage receipt or
readback alone authorizes that transition.

Earlier retained attempts may contain `stop_sell: false`. Their requests are
immutable and are not rewritten or released by this change. Any future dispatcher
must reject a recovered or open initial payload; only a newly claimed one-use
operation with explicit closure can be eligible for its remaining guards. No
runtime sender, provider write, receipt reconciliation or activation is enabled.

### Property-local initial ARI dates (VAY-1545)

New initial claims require a current locked property-location timezone and use
the database clock to establish the hotel's calendar date. Missing or invalid
timezone and malformed dates fail closed; there is no server-timezone fallback.
The admitted interval includes local today through today plus548 calendar days,
reusing the existing full-ARI default exported by the scheduler. Calendar-day
arithmetic is independent of daylight-saving day length. This bounds initial
provisioning; it does not change scheduler configuration overrides or assert
that inventory is open for those dates.

This admission runs before storing upload ownership under the current-authority
transaction. The location row remains locked until commit. It is not a durable
send permission: future dispatch must repeat admission using current timezone,
clock and applicable scheduling policy immediately before IO, alongside closed
payload, receipt, ownership and capability checks. Old claims receive no resend
opportunity or new date authority from this change.

### Closed initial ARI dispatch boundary (VAY-1545)

`prepareChannexInitialAriDispatch` creates a one-use sender only after a fresh
claim commits. Before and after bounded live room/rate metadata reads it repeats
the current authority, configuration evidence, hotel-local date admission and
exact immutable payload checks. The reads verify manual adult occupancy options,
room capacity, meal type and closed configuration. They do not certify downstream
OTA restriction or child-pricing semantics. The uploaded payload keeps
`stop_sell: true`; this service has no runtime adapter or activation path.

An existing receipt or any other ARI attempt for the provider property/rate blocks
sending. This deliberately also blocks subsequent dates after a raw storage-level
reconciliation: authoritative completion and history handling must exist before
that restriction can be relaxed. Recovery cannot recreate a sender for an old
claim. A preflight failure consumes the closure and leaves ownership unresolved.

The POST is attempted once with a bounded deadline. A response, including a late
response after lease loss, is sanitized and retained; a thrown or timed-out POST
retains fixed transport-failure evidence. A storage failure returns only a receipt
persistence retry, never another POST. Neither a task acknowledgement nor a saved
receipt releases ownership or opens sales. Current verification uses injected
provider ports and isolated PostgreSQL, with no real Channex mutations.

### Exact staged restriction observation (VAY-1545)

The staged restriction reader compares the six explicit restriction fields from
one immutable initial request with the provider values for its exact rate/date.
It never recalculates desired hotel rules: a desired open rate is deliberately
staged closed. Require exactly one values item, valid provider UUIDs and calendar
date, explicit valid minima/maximum/booleans and `stop_sell: true` before GET.
Reject missing fields, mismatches and error/warning envelopes. Snapshot scope and
expected fields before IO. This helper returns a restriction observation only;
it does not validate rates, current authority, receipt history or task completion.
The future domain caller must load the immutable attempt itself, supply bounded
authenticated IO and repeat authority/history checks before retaining evidence.

As checked on 2026-09-14, the public [ARI API](https://docs.channex.io/api-v.1-documentation/ari)
documents the restriction GET and a task acknowledgement from POST. The
[property tasks UI](https://docs.channex.io/application-documentation/property-tasks)
describes processing logs, but the documentation index/search did not establish a
supported terminal-task API or the complete multi-occupancy price GET shape.
Do not invent either interface. These remain explicit verification gaps, not
proof that Channex lacks them. An exact restriction observation cannot release
an unresolved attempt, establish complete price delivery or activate sales.

### Current immutable-attempt restriction reader (VAY-1545)

The domain reader accepts creation/ARI attempt IDs, never caller-supplied provider
identity, date or restrictions. Under existing published-owner/lease/target locks,
load the unresolved ARI attempt belonging to the current identified creation and
require the exact retained configuration. Before IO, match the request body’s
property/rate/date against its immutable identity columns and service date; storage
validity alone does not establish request scope. Read its immutable request and snapshot
all ARI attempt IDs/states and receipt IDs for the provider property/rate. Use the
bounded authenticated restriction GET adapter, then repeat current authority,
publication, target/configuration and complete history checks. Reject any change
across IO. A current worker may observe an older worker's upload; it cannot send
it again. Past-date observation is allowed because readback grants no write.

Return a correlated restriction observation without retaining completion evidence,
reconciling ownership or activating the target. Transport ambiguity and task
acknowledgements remain unresolved regardless of matching restrictions. Price and
original-task completion verification are separate requirements.

### Original task finish observation (VAY-1545)

Read-only staging investigation on 2026-09-14 found `GET /api/v1/tasks/:taskId`
in Channex's public web client (`assets/index-C8PX-x_S.js`, Tasks.find), then
verified HTTP 200 with the existing property-scoped API key. Task
`5ff7d7b6-f455-4309-a19d-383442c09c50` returned `type: task`, matching top-level
and attributes IDs, `task: Property.UpdateRestrictions`, `success: true`, empty
errors, received/executed/finished timestamps and the original values payload.
The signed-in property task UI independently displayed the same result and finish
time, with no changes to sync to OTAs. These are historical fixture observations;
no new upload or provider mutation was made. Sanitized evidence is in local
`vayada-testing/evidence/vay1545-task-api/task-observation.json`.

The adapter requests only a validated task UUID, snapshots the expected original
payload, requires every value to belong to the expected property, and accepts only
matching IDs/type/task/exact payload, explicit success, empty errors and ordered
valid received/executed/finished timestamps. It returns only identifiers and the
three timestamps. Discard user/IP/source details, provider error text, raw payload
and channel events. Missing, pending, failed, mismatched or ambiguous responses
remain unavailable. Task IDs must ultimately come from immutable original receipts,
not job payloads or caller completion flags; a future domain service must enforce
that provenance and current ownership before using observations.

Observed timestamps use timezone-less UTC with microseconds, consistent with the
client's UTC display conversion. Preserve those strings and compare all six
fraction digits. This is an observed task finish marker, not a provider guarantee
that execution cannot ever be replayed, a supported-public-API stability promise,
or OTA delivery proof. Do not release ownership or activate from this adapter.
The public task API's lifecycle/retry guarantees and occupancy price readback
still require verification before definitive reconciliation. Never substitute a
browser session token for the scoped API key. Keep the runtime sender disabled.

### Receipt-bound task observation (VAY-1545)

The domain task reader accepts creation/ARI attempt IDs only. Reuse the current
immutable-attempt, configuration and full-history reader. Require exactly one
retained complete-JSON HTTP 200 receipt with no warnings and a nonempty distinct
UUID task list (at most 100). Missing receipts, transport errors, malformed bodies,
warning/partial responses or multiple receipts remain a hold; this slice does not
choose a preferred receipt or consolidate duplicate observations.

Fetch every original task under one aggregate 15-second deadline, checking abort
before each GET. Compare each result to the immutable request; if any task fails,
return no partial observation set. Repeat authority and full-history reads after
IO and reject changes. All task IDs come from the retained receipt, never the
caller. Return correlated task observations only, without persistence, ownership
release, retry permission or activation. Even all matching finish markers do not
establish provider lifecycle/replay guarantees or complete price/OTA delivery.

### Closed initial upload reconciliation (VAY-1545, September15 decision)

The user accepted Channex's documented sequential FIFO processing plus the exact
successful finished original task as the completion boundary. This supersedes
above requirements for a separate provider no-replay guarantee before this
closed initial upload can be reconciled. It is an accepted integration assumption,
not a newly obtained provider guarantee or OTA delivery proof.

`reconcileCurrentChannexInitialAri` accepts internal attempt identifiers and a
provider GET port, never caller-supplied completion evidence. Under current
publication/lease/target authority, require one clean immutable original receipt.
Read every original task against the full immutable request, then every occupancy
price and the six exact closed restrictions under one bounded deadline. No
partial observation set qualifies. Recheck the complete attempt/receipt history,
publication, reservation and provider configuration in the final locked
transaction. Persist a bounded verification attestation (original receipt ID, task/price counts,
SHA-256 of sanitized observations and exact restriction observation) and mark only that unresolved attempt
reconciled atomically; loss of current authority rolls back the transition.

Missing/ambiguous receipts, task or price/rule mismatch, late receipts and changed
ownership remain unresolved. Concurrent calls cannot both reconcile; a repeated
call returns unavailable without fetching or sending again. This command does
not restore a dispatch closure or weaken the initial sender's history guard.
Room availability, complete horizon coverage, guest/meal/channel semantics and
activation remain separate requirements. No runtime caller is enabled here.

### Worker completion of retained closed uploads (VAY-1545)

For mutating `sync_ari` jobs, the provider adapter first invokes closed-upload
reconciliation using the worker's actual ID and persisted job attempt. Discover
unresolved uploads only from that authorized job property's stored targets and
intents; provider IDs and completion evidence never come from job payloads.
Recheck current authority for every candidate. Process at most ten candidates;
more work schedules a normal bounded worker retry, skipping already reconciled
attempts. Ambiguous/stale candidates remain held; failed GETs permit read-only
retry, never recovery of a sender. The provider port authenticates bounded GETs
only to its configured origin. Non-mutating ARI capability prevents this stage.

This runs before the existing plan, including after process restart. A completed
batch does not complete the sync job: provisioning/new pricing dispatch remains
unavailable until its own coverage, availability and activation paths exist.
No rates are created, posted or opened by this worker stage. Other operation
types retain their existing behavior. The dedicated pool closes with the server.

### Sequential closed dates after verified completion (VAY-1545)

Replace the initial sender's blanket ban on all prior uploads with an exact
history gate. Under the current target lock, every earlier upload for the
provider property/rate must belong to the same identified creation, be reconciled
with the version1 finished-task attestation, and retain exactly its original
clean receipt. Missing/late/ambiguous receipts, unclassified storage-only releases
and other creation generations remain a hold. Repeat this check before each
preflight and immediately before POST. Current lease/publication/configuration,
date admission and closed payload checks remain required.

A reconciled date for this creation is not sent again and does not create a new
attempt. A different admitted date can obtain a fresh one-use claim once the
history passes. Unresolved exclusion still serializes all dates of the rate.
This supports initial closed date coverage, not overwriting a completed date,
recovery of an old sender, activation or a cross-generation ownership transfer.

### Next initial date selection (VAY-1545)

`prepareNextChannexInitialAriDispatch` derives the next date under the existing
current-publication/lease/target lock. Require the exact retained configuration
and the same verified-history gate as explicit-date dispatch. Read the locked
property timezone and database clock, walk local calendar dates from today
through the inclusive default initial horizon, and select the earliest date
without reconciled evidence. Never use server UTC today or job-supplied dates;
do not skip missing prices or unsupported configurations to manufacture coverage.

Selection returns no provider permission by itself. A selected date enters the
existing fresh one-use claim/dispatch path, which repeats authority, date and
history admission. Concurrent changes may turn preparation unavailable. An empty
set returns only `initial_dates_reconciled` as of this read; it is not complete
room availability, OTA readiness or activation. Missing timezones, unresolved
history and stale configuration return unavailable without claiming an upload.

### Worker closed-upload continuation

A normal `sync_ari` worker may discover identified pending targets from the leased
property, prepare the next missing closed date, and consume its fresh one-use
dispatch. Restriction-only jobs never enter this pricing-upload stage. Each run
sends at most one upload; retained receipts require reconciliation on the next run.

`initial_upload_retained` is partial progress, never full sync success. Under an
unexpired current lease, the store verifies the receipt belongs to that job's
current attempt and property, completes only that attempt, and requeues the job.
It credits one additional allowed attempt for this durable progress while keeping
attempt numbers monotonic and the remaining failure budget unchanged. It does
not complete command idempotency or update target sync success. If the worker
crashes after retaining its receipt, stale-lease recovery credits that same
uncredited attempt before checking exhaustion; the next attempt has a new ID,
so the old receipt cannot earn another credit. Ambiguous receipts remain held
by reconciliation and cannot authorize another POST. Coverage of closed dates
alone still cannot activate a target or report full sync completion.

### Full-horizon worker proof and next room-availability boundary

The PostgreSQL worker regression covers all 549 dates of the inclusive initial
horizon with fresh worker/provider instances, one failed completion GET and one
crash after receipt persistence but before continuation credit. It requires one
closed POST and reconciled attempt per date, monotonic attempts, preserved retry
budget and no active target pointer or sync-success callback. Provider responses
are simulated and target-state side effects are mocked: this is queue/receipt/
reconciliation proof, not real-process, live-provider, room-availability or OTA
proof. Finishing closed-date coverage leaves full sync unsuccessful: the job
currently ends with `dead_lettered` / `invalid_state` because activation remains
unavailable.

The next availability implementation must use a separate room-scoped durable
owner. All rates sharing an external room share its availability; rate-attempt
exclusion cannot serialize those writes. Bind immutable attempts to the leased
property, connection binding generation, canonical room and external property/
room IDs, hotel-local date, exact available count and current inventory source
evidence. Exclude unresolved writes by external property/room across dates,
rate targets and binding generations. The queue's property lock is additional
serialization, not a substitute for durable unresolved ownership.

The authoritative daily source is PMS materialized inventory with its current
coverage/readiness and source evidence. Consume `pms.inventory_days` through a
PMS-owned reader under `lockPmsInventoryMutationScope`; retain inventory/calendar
and contributing generated/channel/manual/block/booking/linked revisions and
source freshness. Missing coverage or stale source evidence is unavailable,
never an inferred zero. Preserve explicit closed/linked-stop-sell semantics and
canonical available counts; do not recalculate them from room totals, booking
counts or `pmsRoomInventoryReadModel`'s physical-room count. The implementation
must establish current readiness, not merely observe non-null revision columns.

Define lock order against materialization, bookings, linked inventory and current
Channex authority before implementing the reader/claim. Release transaction locks
before provider IO. Require a fresh one-use sender, original receipt/task
reconciliation, exact room/date availability readback and current source checks
before accepting progress. Booking, blocks, capacity, operating-calendar and
linked-inventory changes invalidate stale availability evidence and must enqueue
fresh work. Reconciliation of an old write may establish its completion, but
cannot establish readiness for changed inventory. Full activation must combine
current room coverage with rate/configuration/guest/meal/channel evidence and the
existing publication/binding/version compare-and-swap. This section defines the
next implementation boundary; it grants no sender or activation permission.

### PMS current daily inventory reader

Expose an internal PMS repository reader for one property/room/date. This is
point-in-time source evidence, not job authorization, provider identity, a send
permit or activation. Validate the requested calendar date; do not substitute
zero for a missing row or missing materialized coverage.

Match materialization lock order: inventory mutation scope, property-profile
evidence guard, room-facts scope, sorted physical-room-unit scopes, then current
configuration, coverage and inventory rows. Confirm the configuration under
those locks on the same client; calling the separate-pool calendar reader while
holding its room-facts lock would self-block. Use the canonical inventory planner
invariant validator and current profile/room-facts/unit/calendar evidence. Retain
the exact day, source revision vector and configuration/coverage identity.

Booking/block/manual/channel/linked fields are current canonical owner state:
their writers advance values and revisions atomically under the inventory lock.
They do not have a second asynchronous revision registry to compare. Legacy
`source_freshness` JSON is not current materialized evidence and cannot replace
these checks. Closed or linked-stop-sell days may return an explicitly verified
zero; malformed/inconsistent data returns unavailable. Every future dispatch and
activation consumer must recheck this point-in-time evidence in its own current
transaction and also prove Channex authority/room ownership.

The reader pins the shared inventory advisory key at session scope with a
nonwaiting try-lock before BEGIN, then enters the profile guard and pins room
facts before creating the SERIALIZABLE snapshot and acquiring its normal
transaction locks. Room-facts writers need their own pin because they do not all
take the inventory lock. Contention returns `55P03` for retry; do not wait inside
an existing snapshot and accept a superseded append-only calendar. Always release
both session pins before returning the connection to the pool; failed rollback
or unlock discards the connection. This pin does not authorize provider IO.

### Current job and room binding for availability evidence

Prepare availability evidence from a server-held job lease and local room/date,
never a caller-supplied property or provider ID. Resolve the current authorized
property and active room mapping first. The PMS day reader then holds its owner
locks in a SERIALIZABLE transaction and invokes a narrow internal authorization
guard on that same client. The guard cannot supply or change inventory values.

Recheck full Channex authority and the exact mapping ID, external room/property,
connection ID, claim ID and binding generation while the inventory day is still
locked. Use NOWAIT for reverse-order authority and mapping row locks. Recheck full
authority again at the final boundary for wall-clock lease/entitlement expiry.
Require a hotel-local admitted initial date. Guard rejection rolls back; neither
captured mapping nor inventory evidence escapes a failed commit. No provider
request or durable claim is authorized by this read: the next room-scoped
claim/dispatch must repeat these checks and retain unresolved ownership.

### Durable room-availability ownership

Before provider IO, retain one immutable attempt for the external property and
room. Derive its property, connection, binding generation, local room, and
external identifiers from the active mapping and the persisted `sync_ari` job
attempt under the same current running lease, worker, property resource and
five-minute database clock boundary; caller-supplied identity is never
authoritative. Store the hotel-local date, canonical available count, exact
inventory source evidence, and bounded provider request body. Attempts are
append-only except for a single `unresolved` to `reconciled` transition with
nonempty reconciliation evidence. Retained IDs do not reference mutable
mapping/room rows, so later retirement cannot erase history or block safe room
deletion.

Only one unresolved attempt may own an external property/room pair, across all
dates and binding generations. This provider-resource exclusion survives local
mapping replacement and job failure. A separate room may progress independently.
Storage is inert: it grants neither dispatch nor completion. The claim service
must insert while the current inventory and Channex authority guard is held;
dispatch must consume that exact unresolved attempt once, and an original
receipt plus exact room/date readback must reconcile it.

`claimChannexRoomAvailability` performs the first insert inside the PMS current-day
transaction after repeating full Channex authority and exact room mapping checks.
It derives a one-date `/api/v1/availability` body from the committed canonical
count and retains the complete current-day source evidence used to build it. A
provider-room conflict returns reconciliation-required and never reuses the
existing owner. The returned request belongs only to the new attempt; it is not
a send permit, receipt, readback result, or activation decision.

Each room-availability attempt accepts at most one immutable original-dispatch
receipt. The receipt keeps exact attempt/job/worker correlation and only bounded
HTTP status, request ID, task IDs, parser outcome, and warning classification;
provider text is never retained. A transport exception is stored as ambiguous
`transport_error`. Receipt presence cannot reconcile the attempt or permit retry.

Availability receipt persistence consumes and sanitizes the original response
before opening its bounded database transaction. It accepts only the exact
attempt/job/worker/property/connection correlation and is idempotent only for
the same receipt ID and observation. Authority loss after provider IO cannot
discard the evidence; conflicting receipt identity or content remains blocked.

`prepareChannexRoomAvailabilityDispatch` creates a one-use in-memory sender only
from a newly committed claim. Before POST it rereads the exact PMS day and full
Channex authority, requires them to equal the claimed evidence, and confirms the
same unresolved attempt still owns the exact persisted request without a receipt.
The closure sends once, then retains either the sanitized original response or
an ambiguous transport failure. It cannot reopen an existing attempt and is not
wired into the runtime worker by this contract step.

Exact availability readback accepts only the immutable one-room, one-date
request shape and performs a property-scoped `/api/v1/availability` read for
that date. It rejects root errors or warnings, malformed metadata, missing room
or date entries, booleans, fractional/negative counts and noncanonical numeric
strings. The sanitized observation contains only external property/room IDs,
date and exact nonnegative count; it is not reconciliation by itself.

Availability task verification reuses the original ARI task envelope, identity,
payload and ordered timestamp checks but requires the provider task type
`Property.UpdateAvailability`. A restrictions task cannot prove an availability
write, and task completion remains observation rather than reconciliation.

Room-availability reconciliation first reads one clean original receipt and the
exact retained request under current PMS inventory, mapping and Channex authority
locks. It releases those locks for bounded task completion and exact room/date
availability readback, then repeats the complete candidate in a fresh current-day
transaction. Only unchanged PMS source evidence, provider identity, request,
receipt and authority may perform the single unresolved-to-reconciled transition.
The same transaction writes an immutable one-to-one reconciliation attestation
bound to the original receipt, claim-time inventory digest, observation digest,
and complete terminal evidence. Because availability dispatch is not runtime-wired,
the digest migration aborts if unexpected attempt history exists instead of
stranding unprovable rows. Ordinary application writes create the attestation only
through this authoritative path; direct database writers are privileged and trusted.
The bounded evidence retains observation digests and the sanitized availability
result. Reconciliation neither activates a channel nor grants another send.

The room-availability coordinator walks active mapped rooms in canonical local
room-ID order and dates in ascending order. Its interval starts at the hotel's
current local date and ends at the authoritative PMS materialization coverage
boundary. That coverage is at most 366 inclusive dates and is intentionally
independent from the 549-date closed-rate staging horizon. A missing or malformed
coverage row or inventory day fails closed; it is never inferred as zero.

A reconciled day is skipped only while its complete current inventory evidence,
mapping and binding identity, exact one-date request, clean original receipt,
task count and version-1 reconciliation evidence still match. Any source revision,
count, configuration, room binding or provider identity change makes the day
eligible for a new one-use claim. The exact immutable reconciliation attestation
must also match; directly changing an attempt to terminal state is insufficient.
Selection and claim do not schedule runtime work, perform provider IO, establish
full channel readiness or activate sales.

Inventory-owned changes reach this availability lane through
`pms.inventory.ari_changed`. Reservation holds and releases, canonical inventory
materialization, room closure, physical-capacity changes, room blocks, assignment
transfers, host actions, and linked-inventory reconciliation retain that outbox
intent in the same transaction as their source mutation. Inventory outbox work
enqueues an unrestricted `channex.sync_ari` job; rule and calendar-restriction
triggers continue to enqueue `restrictionsOnly` work.

Manual-booking creation and the manual no-show, cancellation, and stay-correction
paths return the exact primary room-type dates changed by occupied-inventory
reconciliation. In the owning transaction, those dates are sorted and collapsed
into contiguous ranges per room type before room-scoped ARI outbox intents are
written. Command identity and range form stable event keys, so a replay cannot
multiply intents. A stay correction that moves across room types emits separate
source and target room intents. Linked-room effects remain covered independently.

The management worker treats a persisted room-availability receipt as bounded
partial progress, alongside a retained closed-rate receipt. Exact job attempt,
worker, property and progress-lane correlation is required before the running
attempt is completed and requeued with one continuation credit. Stale-lease
recovery grants that credit once from either retained receipt lane; a receipt
from an earlier attempt cannot credit the replacement attempt.
