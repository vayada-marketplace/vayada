# All-hotel Financials exports (VAY-1134 / VAY-2029)

The user authorized ongoing exports for every hotel and waived the live CSV
download smoke on 2026-09-25. Existing route authorization continues to require
organization membership, property access and Financials permissions.

Reuse the API's existing export loop and dedicated database login. Ongoing mode
requires a fixed UTC activation timestamp, retained across deployments, instead
of a single property/export ID. Only jobs created and accepted at or after that
cutoff, with an unexpired snapshot, may be selected. Existing pending, failed
and stale-running requests remain untouched. Exact-ID one-shot behavior stays
separate. Existing row locks, retries, artifact intent, audit and private
protected downloads remain in force.

Keep the existing property allowlist and restrictive worker policies. Enroll
existing properties and automatically enroll future properties through an
owner-controlled insert trigger. The worker cannot modify enrollment or create
properties. Ongoing startup checks the enrollment trigger; exact-property
verification remains available for the older bounded mode.

Use verified RDS TLS for the queue and every worker read-model pool. Platform
provides the pinned CA before Node startup and maps only the dedicated worker
secret. Existing API private-media and folio-recipient KMS permissions are used.
The expense worker and unrelated release gates stay unchanged.

Deployment proceeds through reviewed app and platform PRs, immutable image
attestation, database/permission preflights and health checks. The live export
smoke is omitted at the user's request, so activation must not be described as
verified CSV success. Rollback disables the export worker and removes its
secret without deleting job, attempt, audit or artifact evidence.
