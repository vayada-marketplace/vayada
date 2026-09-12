# Channex operational assignment handoff (VAY-1981)

The PMS-owned Channex importer persists canonical booking facts and operational
room assignments in the same database transaction, before acknowledging the
provider revision. Booking Engine checkout and global cutover controls do not
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

Acquire the property inventory mutation lock before booking/assignment writes.
Reconcile old and new occupied spans, linked inventory and durable inventory
outbox effects atomically. Connect channel booking mappings to assignment IDs.
No external side effect is performed inside the transaction; existing workers
continue to enforce their own ownership modes.

Exact revision replay does not rewrite operational state. Provider modifications
may change pending untouched assignments; changed dates, room types or room count
on a staff-touched reservation fail with an operational conflict for explicit
resolution. Financial/customer-only revisions preserve room and operational
status. Cancellation releases pre-arrival occupancy atomically, but cannot undo
check-in, checkout or a staff no-show. Older revisions remain stale and cannot
resurrect a terminal reservation. Multi-room failures roll back all changes.

A separate `--repair-assignments` mode on the privileged staging import CLI
requires the same exact staging property, booking, revision, approval reference,
active binding and disabled global processing as import. It requires an already
successful scoped import job and matching latest canonical mapping, fetches the
exact authoritative revision again, and initializes only a wholly missing
assignment set. Partial existing state fails visibly; a completed matching repair
is a no-op that preserves staff edits. It never resets jobs, changes canonical
booking attribution, or re-ACKs the provider. Audit evidence and inventory changes
commit together. A provider revision no longer available is a visible blocker.

Verification uses PostgreSQL integration tests for initial import, atomic mapping
and inventory failure, replay/concurrency, modifications, cancellation and bounded
repair. Deployed verification reuses the VAY-1535 synthetic reservation, preserves
all unrelated fixtures and keeps workers disabled and booking sync observe-only.
