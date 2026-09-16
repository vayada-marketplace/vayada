# Affiliate agreement status in Marketplace (VAY-1503)

This slice adds retained affiliate agreement terms and assent status to the
existing collaboration detail surface. It consumes
`GET /api/marketplace/collaborations/:collaborationId/affiliate-assent`; it does
not add a second marketplace, publish terms, create participation, accept terms,
activate links or claim earning eligibility.

## Read behavior

Open collaboration details trigger one scoped agreement read for the current
collaboration. The request uses the target API client and its existing WorkOS
session recovery. Closing the details view aborts the request.

A successful response displays every field in the exact retained disclosure,
plus hotel approval and creator acceptance. `matched` means both parties assented
to the same immutable terms version. Copy must state that link activation and
earning eligibility are checked separately.

The endpoint deliberately returns the same 404 for missing and inaccessible
records. The UI must not distinguish those cases. When current collaboration
terms advertise an affiliate commission, show loading, unavailable and retryable
error states with no join claim. Otherwise only a successful historical agreement
changes the non-affiliate collaboration surface. Loading uses a stable skeleton.

## Presentation

The panel appears inside the existing collaboration detail modal for creators
and hotels, including completed or cancelled hosted collaborations when a
historical affiliate agreement resolves successfully. This keeps affiliate
history independent from the hosted collaboration lifecycle.

The retained disclosure is displayed verbatim in a wrapped terms block. The UI
does not parse or reserialize it because doing so can change large JSON numbers,
key order or other exact bytes. A later friendly renderer needs a separately
versioned structured disclosure contract. The UI never substitutes mutable legacy
collaboration fields for a successful retained agreement.

Pending copy identifies which decisions are recorded without offering an action
that the backend does not support. The layout is one column at every viewport
inside the existing responsive modal. Status text and retry controls remain
available without relying on color alone.

## Validation

Unit coverage exercises target-client endpoint construction, loading, success,
pending, matched, hidden non-affiliate 404, advertised-affiliate unavailable,
retryable failure and stale-request cleanup. Browser validation uses authorized
creator and hotel accounts against the target API after deployment. A positive
agreement view requires a real supported agreement record; synthetic UI data is
not deployment evidence.
