# Initial hotel policy evidence

A newly created property has no Catalog policy summary until Booking saves its
first guest policy. Setup still needs an exact current-owner revision to display
this unconfigured state.

For an authorized property, `hotel_catalog.policy:<propertyId>:r0` means neither
a policy summary nor its owner revision ledger exists in the same read snapshot.
It is evidence of an initial state, not a configured policy. Booking continues to
report `guest-policy:absent` and setup reports `not_started`; guest-policy readiness
remains blocked until the policy is configured.

The first policy save creates revision 1 through the existing database trigger.
Deleting a saved policy retains its ledger, so deletion still returns missing
owner state. Location revisions remain positive, organization scoping is unchanged,
and no rows or migrations are introduced by this read behavior.

This fixes the setup-route 503 found during the prepared hotel import deployed
smoke test. Existing saved policies keep their revision semantics.
