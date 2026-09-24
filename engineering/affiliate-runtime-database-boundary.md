# Affiliate runtime database boundary (VAY-1506 / VAY-1508)

_Grant inventory, 23 September 2026. No credential, SQL grant, route flag or
public tracking is enabled by this document._

## Decision

Do not grant the general `TARGET_DATABASE_URL` role blanket `UPDATE` on hotel,
Marketplace or Booking tables to make live affiliate tracking work. The click
path takes row locks. PostgreSQL requires `UPDATE` privilege even for `SELECT
... FOR SHARE`; a grant on mutable `hotel_catalog.properties` or
`hotel_catalog.property_slugs` would permit actual edits outside the affiliate
route. A column-scoped `UPDATE` grant still permits edits to that column. See
[PostgreSQL's SELECT privilege rule](https://www.postgresql.org/docs/current/sql-select.html).

Use a separately named, non-owner affiliate capture credential for the eventual
public link and destination-admission paths. It must be selected by server
configuration, have no fallback to the general or migration-owner URL, and open
only when capture is explicitly enabled. Native booking creation remains on its
Booking credential and needs a separately reviewed, narrowly scoped way to lock
an immutable click context and insert an original-booking binding. Direct
`INSERT` into the binding table would allow forged credit if that credential
were compromised; application `WHERE` clauses alone do not contain that risk.
The same problem exists earlier: direct `INSERT` into click occurrences,
contexts or admissions can fabricate the evidence that a booking later binds.
The capture credential must not receive those direct insert grants until a
database-enforced write boundary proves link, agreement, property, terms,
reference lifetime and context-history provenance. A separate role alone does
not make fabricated affiliate evidence safe.

This is a proposed boundary, not permission approval. Resolve the mutable
hotel-row locks, capture writes and binding-write authority before provisioning
any grant.

## Direct SQL inventory

The table lists operations in the currently dormant native path. `lock` means
both `SELECT` and PostgreSQL `UPDATE` privilege are needed unless the query is
changed to a reviewed lock-only capability. It does **not** grant permission to
perform a real update.

| Step                    | Relations                                                                                                                                                                                    | Direct operation                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Link eligibility        | `marketplace.affiliate_links`                                                                                                                                                                | SELECT                                                                                   |
| Active agreement        | `marketplace.affiliate_agreement_activations`, `marketplace.affiliate_agreement_lifecycle_events`                                                                                            | lock; append-only triggers reject updates                                                |
| Accepted terms          | `marketplace.affiliate_published_terms`                                                                                                                                                      | lock; immutable trigger rejects updates                                                  |
| Destination URL safety  | `booking.affiliate_destination_versions`, `hotel_catalog.properties`, `hotel_catalog.property_slugs`                                                                                         | lock; **property and slug rows are mutable**                                             |
| Custom-domain exclusion | `hotel_catalog.property_domains`                                                                                                                                                             | SELECT; coordinated per-property advisory lock                                           |
| Referral certification  | `booking.affiliate_referral_transport_certifications`, `booking.affiliate_validation_probes`, `booking.affiliate_referral_production_preflights`                                             | lock                                                                                     |
| Referral revocations    | `booking.affiliate_validation_probe_revocations`, `booking.affiliate_referral_production_preflight_revocations`                                                                              | SELECT                                                                                   |
| Eligible click          | `marketplace.affiliate_click_occurrences`                                                                                                                                                    | guarded INSERT needed; later admission uses a lock                                       |
| Destination admission   | `booking.affiliate_click_contexts`                                                                                                                                                           | SELECT, guarded INSERT, lock                                                             |
| Ordered history         | `booking.affiliate_click_admissions`                                                                                                                                                         | SELECT, guarded INSERT                                                                   |
| Final Booking host      | `distribution.active_public_booking_revision`, `distribution.public_booking_content_revisions`, `hotel_catalog.property_slugs`, `hotel_catalog.property_domains`, `hotel_catalog.properties` | SELECT plus the existing property lock and coordinated domain/publication advisory locks |
| Quote cookie check      | `booking.affiliate_click_contexts`, `booking.affiliate_click_admissions`, `hotel_catalog.property_slugs`                                                                                     | SELECT                                                                                   |
| Original booking        | existing Booking checkout relations                                                                                                                                                          | existing checkout grants plus context lock and guarded binding INSERT                    |
| Frozen cutoff           | `booking.affiliate_original_booking_bindings`                                                                                                                                                | guarded INSERT; mutation trigger rejects updates/deletes                                 |

The public `/r/:token` route is unregistered; the Booking arrival route and
cookie binding are disabled. The table covers the direct source files, not a
complete effective-privilege or trigger/function inventory. In particular,
booking writer dependencies and any degraded-gap records must be included
before the final grant matrix is declared complete.

## Grant and activation gates

1. Migration `0416_affiliate_destination_lock_boundary.sql` adds restrictive
   row-level policies for `hotel_catalog.properties` and `property_slugs`. A
   non-owner login using the exact future capture role can take the row locks
   required by destination validation but cannot update either relation with
   arbitrary SQL. Preserve the property/domain advisory-lock ordering and
   current-host check. Grants and the rest of the capture allowlist remain
   separate release gates.
2. Define capture-write authority so arbitrary SQL through the affiliate
   credential cannot insert a made-up occurrence, context or admission. The
   database must derive or verify the active agreement, accepted terms,
   property, click reference, admission lifetime and monotonic history in the
   retained transaction. Current foreign keys and immutable-update triggers
   do not prove that an inserted history row came from an eligible link. Do not
   grant direct INSERT on these tables as a shortcut. Migration
   `0417_affiliate_guarded_click_capture.sql` completes the occurrence portion:
   its owner-executed command derives beneficiary scope from the public link,
   validates ordered active agreement history and generates the click identity,
   reference and timestamp. Public execution is revoked. Migration
   `0418_affiliate_guarded_click_admission.sql` completes the context and
   admission portion: its owner-executed command resolves the immutable live
   click from the opaque reference, validates its property and transport
   lifetime, generates new context IDs internally, and serializes replay or
   conflicts without direct table writes. Public execution is revoked.
3. Migration `0419_affiliate_guarded_original_binding.sql` adds the
   booking-binding write boundary. Each booking receives an immutable creation
   transaction marker. The owner-executed command accepts only a booking made
   at top level in its current transaction, derives the property and original booking facts,
   locks and validates the live context, and freezes the recent admission
   cutoff. Public execution is revoked. Keep idempotent original-booking
   creation and the immutable binding on one connection.
4. Finish the transitive SQL/trigger inventory and encode an exact allowlist,
   its denied privileges, immutable-trigger state, non-owner/no-BYPASSRLS role
   checks, and schema/function/sequence rights in a release-specific preflight.
   Run it as the exact proposed login on PostgreSQL 16 and 17. Negative cases
   must try cross-property writes, changing accepted terms or click history,
   inserting a forged click/context/admission or binding, and mutating
   unrelated Booking, Finance or identity data.
5. Provision through a reviewed owner-only grant runner, not an application
   migration that silently widens `vayada_next_api_runtime`. Verify the deployed
   secret mapping, role and database after release. Keep capture disabled until
   privacy approval, retention operations, HTTPS cookie forwarding and the
   click-to-booking round trip also pass.

No target, migration or test database credential is available in this local
workspace, so the deployed role's effective privileges have not been checked.

The first executable preparation check is
`assertAffiliateCaptureRoleHasNoWriteGrants`. It requires a `NOINHERIT` login
and rejects owner or DDL powers, membership, direct table or column writes,
sequence rights, or delegated table/column reads. PostgreSQL grants `TEMP` on a
database to `PUBLIC` by default; an owner must revoke that default before a
candidate role can pass. The fixture makes that revocation only inside a
rolled-back test transaction. It verifies that direct click, admission, binding
and mutable-hotel grants are rejected. This is a
**deny-only staging check**: passing it does not establish the required read
grants, guarded write capability, full function/trigger safety, deployment
credential mapping, or permission to turn on capture.

`assertAffiliateCaptureRoleHasGuardedWriteCapabilities` adds the next gate. It
requires schema usage and non-delegable execution of
`marketplace.capture_affiliate_click` and `booking.admit_affiliate_click`. It
rejects execution of `booking.bind_live_affiliate_original` and every other
callable non-system `SECURITY DEFINER` function, procedure, or window function.
Trigger and event-trigger routines are excluded because clients cannot invoke
them directly. The gate also verifies that `PUBLIC` cannot execute any of the
three named commands and reruns the deny-only direct-write check. It does not
restrict `SECURITY INVOKER` routines, which remain limited by the caller's
underlying grants. This still does not define the transitive read allowlist or
provision a production role.

`assertAffiliateCaptureRoleHasVisitReadCapabilities` encodes the known direct
SQL surface used by link eligibility, accepted terms, native destination
safety and referral-readiness checks. It requires `SELECT` on exactly those
relations and non-delegable `UPDATE` only where PostgreSQL row locks require
it. Every immutable relation in that lock list must retain its enabled mutation
trigger in `ENABLE ALWAYS` mode, including when a login starts in replication
mode; the two mutable hotel-catalogue relations must retain the complete known
row-level policy set. The check rejects any additional direct read or write
access. The visit path now derives its referral runtime configuration from
exactly one fresh, unrevoked certification/preflight pair for the accepted
destination; zero or multiple candidates fail closed, using relations already
covered by this allowlist. Final-host resolution now adds only the active
Booking publication pointer and immutable content revision; its canonical
slug/domain and property reads were already present. It rechecks the property
under the existing domain-safety, Booking-publication and property locks before
admission, and does not read a PMS relation. Passing this gate still does not
authorize capture or provision the role.

The API has a closed-by-default arrival composition gate. It requires
`AFFILIATE_CAPTURE_ENABLED=true`, an `AFFILIATE_CAPTURE_DATABASE_URL` whose
unoverridden login is exactly `vayada_next_affiliate_capture`, and an internal
arrival token of at least 32 bytes. Startup runs the complete visit-role
preflight before mounting the token-protected Booking arrival endpoint. It does
not register `/r/:token` or enable cookie-to-booking binding; those remain
separate release gates, so setting these API variables alone cannot start
public tracking.

The API application can now compose `/r/:publicToken` only when its caller
supplies both the guarded visit operation and a quota consumer. The production
server deliberately supplies neither, because no production quota provider is
configured yet. This keeps the route absent by default while allowing the full
redirect contract to be tested through the same `buildApp` boundary used by
the server. A process-local counter is not an acceptable production substitute.

Cookie-to-booking binding has its own closed-by-default
`AFFILIATE_BOOKING_BINDING_ENABLED` gate. It cannot open without the complete
capture runtime and the target Booking writer connection. Before route
composition, the API connects with that exact writer credential and proves it
is a restricted non-owner login, has only guarded access to affiliate evidence,
can read the live context for the canonical hotel, can execute but not delegate
`booking.bind_live_affiliate_original`, and still has the required immutable
triggers. Failure aborts startup. This gate does not register the public link
route or provision database grants.
