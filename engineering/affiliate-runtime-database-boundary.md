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

| Step                    | Relations                                                                                                                                        | Direct operation                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Link eligibility        | `marketplace.affiliate_links`                                                                                                                    | SELECT                                                                        |
| Active agreement        | `marketplace.affiliate_agreement_activations`, `marketplace.affiliate_agreement_lifecycle_events`                                                | lock; append-only triggers reject updates                                     |
| Accepted terms          | `marketplace.affiliate_published_terms`                                                                                                          | lock; immutable trigger rejects updates                                       |
| Destination URL safety  | `booking.affiliate_destination_versions`, `hotel_catalog.properties`, `hotel_catalog.property_slugs`                                             | lock; **property and slug rows are mutable**                                  |
| Custom-domain exclusion | `hotel_catalog.property_domains`                                                                                                                 | SELECT; coordinated per-property advisory lock                                |
| Referral certification  | `booking.affiliate_referral_transport_certifications`, `booking.affiliate_validation_probes`, `booking.affiliate_referral_production_preflights` | lock                                                                          |
| Referral revocations    | `booking.affiliate_validation_probe_revocations`, `booking.affiliate_referral_production_preflight_revocations`                                  | SELECT                                                                        |
| Eligible click          | `marketplace.affiliate_click_occurrences`                                                                                                        | guarded INSERT needed; later admission uses a lock                            |
| Destination admission   | `booking.affiliate_click_contexts`                                                                                                               | SELECT, guarded INSERT, lock                                                  |
| Ordered history         | `booking.affiliate_click_admissions`                                                                                                             | SELECT, guarded INSERT                                                        |
| Final Booking host      | public hotel-profile repository and its hotel/catalog sources                                                                                    | current-host read; transitive repository SQL still needs a reviewed inventory |
| Quote cookie check      | `booking.affiliate_click_contexts`, `booking.affiliate_click_admissions`, `hotel_catalog.property_slugs`                                         | SELECT                                                                        |
| Original booking        | existing Booking checkout relations                                                                                                              | existing checkout grants plus context lock and guarded binding INSERT         |
| Frozen cutoff           | `booking.affiliate_original_booking_bindings`                                                                                                    | guarded INSERT; mutation trigger rejects updates/deletes                      |

The public `/r/:token` route is unregistered; the Booking arrival route and
cookie binding are disabled. The table covers the direct source files, not a
complete effective-privilege or trigger/function inventory. In particular,
the host-profile repository, production readiness configuration, booking writer
dependencies and any degraded-gap records must be included before the final
grant matrix is declared complete.

## Grant and activation gates

1. Choose a database-enforced lock-only boundary for mutable hotel rows (for
   example, a narrowly audited capability or restrictive row-level policy) and
   prove a non-owner login cannot edit any hotel row, even with arbitrary SQL.
   Preserve the property/domain advisory-lock ordering and current-host check.
2. Define capture-write authority so arbitrary SQL through the affiliate
   credential cannot insert a made-up occurrence, context or admission. The
   database must derive or verify the active agreement, accepted terms,
   property, click reference, admission lifetime and monotonic history in the
   retained transaction. Current foreign keys and immutable-update triggers
   do not prove that an inserted history row came from an eligible link. Do not
   grant direct INSERT on these tables as a shortcut.
3. Define the booking-binding write boundary so a runtime credential cannot
   insert a binding for an arbitrary booking, context, property or cutoff. A
   security-definer function is not sufficient if it merely trusts caller IDs;
   its authority and same-transaction proof must be reviewed. Keep idempotent
   original-booking creation and the immutable binding on one connection.
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
