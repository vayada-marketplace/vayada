# Historical owner evidence visibility

VAY-2017 historical reads require an explicit read-only repeatable-read or
serializable transaction. The reader sets a safe catalog search path before
checking session settings and retains relation locks on all five snapshot/ledger
tables until the caller ends that transaction. Views, inheritance, either RLS
flag, missing privileges, and conflicting or incomplete selected rows fail closed.
`row_security=off` rejects policy-filtered reads even when a caller's existing
snapshot predates concurrent RLS enablement; it does not bypass policies.

On failure the reader rolls back only its own savepoint, releasing partial locks.
`OWNER_SOURCE_ROLLBACK_FAILED` means cleanup is uncertain: the caller must abort
the outer transaction and discard the connection if rollback cannot be confirmed.
Success does not commit, and keeps the catalog search path and row-security
setting for the transaction.
The caller must configure bounded query/lock timeouts and pool acquisition.

This is historical association evidence, not current ownership or access approval.
The runtime must still authenticate the database endpoint/resource and independently
approve the exact ledger, row hashes, ordinals, environment and eight-owner scope.
It must obtain fresh live ownership/restriction evidence separately. Pending status
does not grant access, and no connection is activated by this reader.

The disposable PostgreSQL 16/17 tests use a restricted login and synthetic ledger
provenance. They test real reads, retained locks, partial cleanup, hidden duplicate
rows, table representation/privilege denials and session-setting spoof resistance;
they are not an extraction-completeness or production cutover rehearsal.
