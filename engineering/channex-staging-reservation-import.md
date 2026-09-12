# One-reservation staging import (VAY-1535)

This operator-only command extends the durable booking importer described in
typescript-backend-structure.md. It is a staging exception, not a booking
cutover: no server route, scheduler, ownership-mode change or schema migration.

The operator supplies one sanctioned test booking UUID, its exact Channex
revision UUID, the expected provider property UUID, and an approval reference.
The API runtime must be next, global workers disabled, booking sync
observe_only, and the existing isolated staging property configured against
exactly https://staging.channex.io. Credentials come from the runtime environment.

The command locks and checks the connected property binding and active claim,
captures its generation, and enqueues one deterministic, separately marked job.
Only an invocation with that exact scope may claim this job. Ordinary workers
exclude these jobs, including abandoned attempts. The importer pulls the exact
authoritative revision, validates its booking/property identity and Booking.com
source, then uses existing canonical persistence, tombstones and durable ACK
handling. Binding generation and active ownership are rechecked before writing
and acknowledging. No unrelated queue entry or provider revision is processed.

Each invocation makes at most one attempt. Repeating identical input reuses the
job and obeys retry timing; it cannot reset a completed or dead-lettered job.
The approval reference is retained in job metadata; existing audit events record
attempt outcomes. This privileged command is authorized by operator access to
the runtime and database, not by an unauthenticated product endpoint.

## Execution

Coordinate the shared sandbox lease and verify the deployed image contains this
command. Select a fresh, explicitly sanctioned test reservation; preserve review
fixtures and never use real guest bookings. Do not turn on global booking sync.

With the existing API environment injected, run from apps/api:

    node dist/cli/importChannexStagingReservation.js --provider-property-id PROVIDER_UUID --booking-id BOOKING_UUID --revision-id REVISION_UUID --approval-ref VAY-1535:approved-test

The sanitized result reports job ID, status and attempt counts. Succeeded
means the revision was durably handled and acknowledged, not that any no-show
report was sent. Pending/running/dead-lettered outcomes are not success. Inspect
the canonical reservation and provider mapping before continuing feature tests.
This command does not create a provider reservation, cancel it, report a no-show,
or restore an expired Booking.com channel.
