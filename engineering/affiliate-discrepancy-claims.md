# Affiliate discrepancy claims

VAY-1516. This claim layer extends authenticated support without becoming a
second ledger. Marketplace owns claim scope and visibility; Booking and Finance
remain authoritative for reservation, earning, allocation, payout and payment
evidence.

A creator may submit one claim for an attributed booking and optional payout.
The server derives creator organization, profile and affiliate identity from
`RequestContext`, then verifies the agreement and winning non-synthetic booking
attribution before storing anything. Reads always reapply that creator scope.
The duplicate key is creator organization + kind + agreement + booking + payout;
retries return the original claim and never replace its message or evidence.

Claims and final resolutions are append-only. Creator evidence is a bounded list
of opaque internal references, not URLs or proof by itself. A denial retains a
reason. A confirmed earning must reference an existing eligible Finance earning
revision matching the claim's creator, agreement, property and booking. A
confirmed payment must additionally reference an existing payout allocation for
that earning. Resolution records recognition of authoritative evidence only: it
does not insert or update earning journal, allocation, payout, balance or payment
rows and does not dispatch a payout.

Hotel owner/operators with `marketplace.collaboration.review` may resolve claims
for their linked property. Platform staff with `platform.finance.manage` may
resolve any claim. Creator submission/read uses
`marketplace.collaboration.read`. Every command rechecks persisted scope, is
idempotent, and records actor organization/user, request, reason and evidence.

Creator responses expose the claim reference, kind, status, masked booking
reference, timestamps and final reason/evidence references. They do not expose
guest data, raw booking rows, payment-provider references, or claims belonging to
another creator workspace.
