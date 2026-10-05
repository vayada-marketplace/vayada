# Hotel setup logo writer (VAY-965)

Status: repair contract; production remains on the existing media path until the
complete scoped writer and release proofs pass.

## Observed failure and retained behavior

The two original Owner sessions now create canonical properties successfully.
The next `POST /api/media/upload-sessions` fails with PostgreSQL 42501 on
`platform.media_upload_sessions` through `vayada_next_api_runtime`. The failed
logo does not undo the committed property. Reuse that property on retry.

This is not an invitation to grant the ordinary API general media writes.
Its exact runtime preflight intentionally denies unapproved relation writes.
Preserve that boundary, and do not bypass the required logo or hide the error.

Reuse the protocol and implementation in
[platform media](platform-media-decision.md), `platformMediaRepository`,
`propertyMediaCommandRepository`, and `propertyMediaPublicationWorker`:

1. Authorize the canonical property and persist a signed upload session.
2. Upload to private staging with the existing signed upload contract.
3. Inspect bytes and generate safe private variants during finalization.
4. Persist media objects and variants with completion/replay evidence.
5. Assign the logo at the expected profile revision and reserve publication.
6. Publish safe variants, commit the assignment/read models, and reload status.

Upload/finalization alone never makes an image public. Preserve cleanup,
idempotency, uncertain-commit reconciliation, publication fencing and CAS.

## Execution and credential boundary

Keep the public URLs and wire contracts unchanged. Add a purpose-bounded private
logo command path using the existing private property-command transport pattern.
Forward only the original bearer, documented request body, canonical path IDs,
and existing idempotency headers. Context/role/actor overrides are rejected.
The private handler independently verifies the original session and requires
current Owner authority, `hotel_catalog.setup.manage`, the selected active
hotel-group organization and its active property link before any write or replay.
Creator Marketplace-only properties must not need a PMS link, pricing currency
or Operations entitlement to upload a logo. Any shared helper/resolver change
must retain the existing stricter checks for the four Operations purposes.

Use a separate native property-purpose assignment, `property_logo`, under the
existing property credential lifecycle. Do not enlarge creation, launch-settings,
currency, Feature Hub or ordinary API credentials. The fixed reader may resolve
only the reviewed assignment and actor-scoped session routing metadata. The
ordinary API receives no native credential, administrative connection or secret
publication rights. There is no ambient database or local-write fallback.

The private media routes reuse the existing media policy and finalizer. Their
enabled purpose is only `property.logo` and their resource is only
`hotel_catalog:property`. Imports, profile pictures, room media, cover/gallery,
Platform Admin overrides and non-logo assignment commands stay outside this repair.
The existing property-media library permits reuse of an already approved asset
within its property; this repair must not change that contract for other routes.

Preserve independent upload and assignment steps. Existing `platformMediaRoutes`
and property assignment code need a request-bound repository seam rather than a
second media protocol or caller-supplied persistence result. The native pool is
selected from server-owned property/organization/actor bindings. Scope and
current authority are locked and rechecked inside each existing write transaction.
Never accept raw SQL, processed object metadata or arbitrary storage keys as a
private command API.

## Native SQL inventory

Review column ACLs, RLS, generated-key helpers and trigger dependencies together.
Every native write/read is property-scoped and bound to the assigned active Owner;
shared rows additionally carry their fixed logo purpose/operation discriminator.
Bind the logo assignment to its operationally verified actor explicitly; a native
credential cannot supply another actor in session metadata or audit/job payloads.
Existing purpose assignments and their actor semantics remain unchanged.

| Phase               | Existing persistence                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/renew/replay | `platform.media_upload_sessions`: signed session metadata, actor, organization, canonical property target, expiry and status                       |
| Finalize/replay     | Same session; `platform.media_objects` and `platform.media_variants`: canonical private uploaded image and safe variants                           |
| Assign/replay       | `platform.idempotency_keys`; `platform.jobs`: only the property-media publication queue/type and this property's logo operation                    |
| Publication         | The reserved publication job, attempts/dead-letter evidence; selected media/variant approval; this property's logo assignment and profile revision |
| Read model          | Existing canonical public-profile and Marketplace offer projections required by the selected property's assignment                                 |
| Audit               | Existing upload/finalize and property-media receipts with exact assigned actor, organization, property and fixed action/resource shape             |

Freeze the exact column, policy, function and trigger inventory in the native
preflight before credential publication. Publication recovery may access only
jobs originating from the assigned property's logo commands, not arbitrary jobs
sharing a queue. Scope nested session completion metadata and job payloads as
well as top-level property columns. Foreign session/media/job IDs, forged actor,
cross-property variants, non-logo assignments and widened role membership fail
closed. Table-level grants are not a substitute for the column/RLS inventory.

The publication worker uses the same property-bound purpose credential and
existing lease/recovery protocol. A resumed job must recheck current assignment
and authority; a revoked Owner cannot publish through an earlier job. Do not
enable a global all-properties worker with this credential.

Recheck the fenced job, assignment and authority before external publication,
then recheck the lease, expected revision and authority before the database
publication commit. A lost storage or database acknowledgement requires exact
reconciliation; it is not permission to repeat publication blindly.

Cleanup after revocation is distinct from publication. A cleanup-only operational
path may delete only expired staging or unreferenced private artifacts whose
registry/session/job evidence binds them to this property and this logo attempt.
It cannot publish, attach, adopt another attempt, alter ownership or scan another
property. Preserve referenced/pending artifacts through uncertain outcomes.

## Storage and release

Reuse the existing bucket/CDN and safe key constructors. The private executor's
reviewed task role receives only the storage operations and staging/private/
public paths needed by this image protocol; no bucket policy, public ACL or
unrelated secret permissions change. Existing public serving credentials and
Finance configuration remain unchanged.

The private reader, role lifecycle, purpose allowlists, runtime preflights,
primary/rollback images, task IAM, task configuration and forwarding admission
must be reviewed as one release contract. Production forwarding stays blocked
until the exact new purpose credential and complete lifecycle are proved.
Retain the existing protected operational bootstrap and immutable secret-version
publication workflow. Do not turn on automatic provisioning as part of this fix.

The supported rollback image must either prove the same complete logo lifecycle
against the new inventory or block logo forwarding while retaining pending
sessions/jobs and their evidence. Older images cannot silently fall back to
ordinary persistence. Document which mode the reviewed immutable rollback uses
before any production admission; unrelated setup commands remain serving.

## Required checks

- Actual PostgreSQL 16/17 native fixtures: complete create/upload/finalize/assign/
  publication/reload, retry/replay and exact cleanup with PUBLIC helper execution
  revoked; ordinary API direct media writes remain denied.
- Native direct-SQL and route denials: missing/invalid session, non-Owner, missing
  permission/link, wrong actor/org/property/purpose, revoked assignment/Owner,
  malformed nested metadata, forged session/media/job IDs and unsafe variants.
- Failure checks: expired uploads, finalize race, private-byte inspection failure,
  uncertain COMMIT, revision conflict, storage/publication failure, cleanup retry,
  lease/recovery and replay after revocation. No duplicate property or assignment.
- Existing media contracts, property publication worker checks, API build/
  typecheck, and shared wizard/browser coverage remain green.
- Independent scope/adversarial review and normal protected release, followed by
  original Owner Save and reload on both already-created properties. Labeled mock
  facts remain labeled; later real business setup is left to the Owners.

VAY-965 remains In Progress until the complete live logo path passes and the
human accepts the result. Saved property details alone are not full Save proof.
