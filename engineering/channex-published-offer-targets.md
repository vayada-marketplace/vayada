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
