# Channex operational assignment handoff (VAY-1981)

The PMS-owned Channex importer persists canonical booking facts and operational
room assignments in the same database transaction, before acknowledging the
provider revision. Validation and operational conflicts roll back the mutation
and persist a failed attempt, sanitized error code and audit event. Non-retryable
failures dead-letter immediately; retryable failures use bounded backoff until
the job attempt limit, then dead-letter. Failed mutations are never ACKed.
Successful, replayed and stale outcomes are durably recorded before ACK; an ACK
failure retries through the existing durable replay path. Booking Engine checkout and global cutover controls do not
change. This extends the PMS boundary in `typescript-backend-structure.md` and
uses the canonical occupancy lifecycle introduced by VAY-1318.

Each provider room requires an active room and rate mapping on the exact property
and connection. The mapped rate must belong to that room. Inactive or closing
room types, missing calendar coverage, closed arrival inventory and insufficient
physical capacity reject the entire mutation. Provider room order is the existing
channel mapping slot identity; each slot becomes a one-based pending assignment
with exact stay evidence, source `channel`, and no physical room selection.
Migration 0185 permits that pending channel shape only with the versioned
`channex-operational-assignment.v1` marker; manual and migration constraints remain.

Acquire `lockPmsInventoryMutationScope` before reading booking mappings, applied
revisions, assignments, occupancy or reconciliation inputs, and hold it through
all corresponding writes in the same transaction.
Reconcile old and new occupied spans, linked inventory and durable inventory
outbox effects atomically. Connect channel booking mappings to assignment IDs.
No external side effect is performed inside the transaction; existing workers
continue to enforce their own ownership modes.

Exact revision replay does not rewrite operational state. Provider modifications
may change pending untouched assignments; changed dates, room types or room count
on a staff-touched reservation fail with an operational conflict for explicit
resolution. Financial/customer-only revisions preserve room and operational
status. Cancellation releases pre-arrival occupancy atomically, but cannot undo
check-in, checkout or a staff no-show. The existing booking worker compares provider `inserted_at` evidence against
`providerInsertedAt` in the connection-scoped mappings and cancellation tombstone
under that lock. A strictly older timestamp is recorded as stale; an identical
revision ID is a replay. Equal timestamps with different IDs retain existing
arrival-order behavior. Terminal reservations cannot be resurrected. This slice
does not change the separate domain `buildInboundRevisionIdempotencyKey` helper
or introduce ordering from its `revisionSequence` discriminator. Multi-room failures roll back all changes.

A separate `--repair-assignments` mode on the privileged staging import CLI
requires the same exact staging property, booking, revision, approval reference,
active binding and disabled global processing as import. It requires an already
successful scoped import job and matching latest canonical mapping, fetches the
exact authoritative revision again. Every active mapping must have
`external_revision_id` equal to the requested revision, and the refetched
provider revision ID must equal that same value; sequence numbers, raw payloads
and job keys cannot substitute for that identity. It initializes only a wholly missing
assignment set. Partial existing state fails visibly; a completed matching repair
is a no-op that preserves staff edits. It never resets jobs, changes canonical
booking attribution, or re-ACKs the provider. Audit evidence and inventory changes
commit together. A provider revision no longer available is a visible blocker.

Verification uses PostgreSQL integration tests for initial import, atomic mapping
and inventory failure, replay/concurrency, modifications, cancellation and bounded
repair. Deployed verification reuses the VAY-1535 synthetic reservation, preserves
all unrelated fixtures and keeps workers disabled and booking sync observe-only.
