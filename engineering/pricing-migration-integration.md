# Pricing migration integration

VAY-1557: reconcile the unmerged pricing stack with main `758b73b11`.
Main's `0187_booking_ota_revenue_room_moves.sql` and
`0188_validate_booking_ota_revenue_room_moves.sql` retain their filenames and
SQL bytes. Only unmerged pricing migrations move:

| Previous pricing version | Replacement | Purpose |
| --- | --- | --- |
| 0187 | 0196 | Pricing storage |
| 0188 | 0197 | Booking offer terms |
| 0189 | 0198 | Mandatory charge declarations |
| 0190 | 0199 | FX observations |
| 0193 | 0200 | Draft policy candidates |
| 0194 | 0201 | Draft effective source evidence |

The SQL bodies remain unchanged. Each rename enters at its original schema
PR, then append-only parent merges carry the repair through dependent PRs.
Channex reserves 0191/0192/0195; its owner verified those migrations do not
reference pricing tables during application. Do not reuse those reservations.

Validate both a fresh database and an upgrade from main's complete migration
history. Rerunning must apply nothing. Check main's migration bytes and the
renamed pricing bytes against their original commits before publishing repairs.

Local databases previously migrated with pricing's old numbers have a different
ledger. Preserve them for historical evidence; use fresh isolated databases for
this repair. Do not rewrite their ledger, apply both histories, or treat them as
proof of a deployment upgrade. No pricing migration was deployed by this task.
If a shared environment is found with the old pricing history, stop that
rollout and reconcile its actual ledger separately before running migrations.

This repair does not authorize merging the pricing stack or deploying it.
