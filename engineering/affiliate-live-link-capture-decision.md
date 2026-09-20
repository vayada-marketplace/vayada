# Live affiliate link and click capture — proposed MVP decision

VAY-1504 / VAY-1506, consuming VAY-1505 and VAY-1056. Proposal for product and
privacy review, 20 September 2026. **No live capture or public redirect is
authorized by this document.**

## Starting point

Marketplace now stores one stable opaque link per activated agreement and can
read whether the agreement is active under a locked `READ COMMITTED` transaction.
The link is still an internal reference: `/r/:token` has no public handler and
there is no trusted click occurrence store or original-booking click-history
binding. The existing Booking Web affiliate-click event is diagnostic: its
browser-supplied referral/session fields do not establish creator attribution.
Production link creation also defaults to blocked until its server-owned
readiness adapter is wired; synthetic test readiness is not live evidence.

The [referral validation contract](affiliate-referral-validation.md) explicitly
leaves browser storage, consent basis, retention and cross-domain transport for
decision before live capture. The
[agreement contract](marketplace-affiliate-agreements.md) requires an active
agreement at click time and preserves earlier eligible clicks across an ordinary
pause or end. The [booking evidence contract](affiliate-booking-evidence-contract.md)
keeps a click, booking, completed stay and payable commission separate.

## Recommended guest flow

1. A creator shares the same `/r/:token` link on any platform. An optional
   campaign label describes the share but never changes the beneficiary.
2. Vayada resolves the token to its persisted agreement, exact accepted terms,
   linked property and exact Booking-owned destination version. It never accepts
   a destination URL, creator, property or eligibility flag from the browser.
   Paused, ended and malformed links fail closed without exposing a destination
   or recording an eligible click. Initial publication requires verified
   destination readiness. If readiness later becomes temporarily unavailable,
   show a degraded continue screen and permit an untracked visit only to the
   previously verified exact destination while its separate URL safety evidence
   remains current; show the degraded state to the creator and hotel. Never
   record an eligible click during the outage. If URL safety evidence is stale
   or revoked, do not redirect.
3. For a first visit without an accepted affiliate-tracking choice, show a short
   Vayada-hosted continue screen. The guest can opt in to referral tracking or
   continue to the hotel without it. Declining still permits a normal hotel
   visit; it produces no creator-attributable click or booking claim. Do not
   reuse the separate Booking analytics choice as affiliate consent.
4. With opt-in, the server creates or reuses a first-party opaque browser
   context on the Vayada origin. Each visit still gets a fresh opaque nonce.
   One continue request atomically appends one click to that context and its
   retry receipt, then redirects to the exact allowed destination. Retrying
   that nonce returns the same click; opening any stable creator link again
   issues a new nonce and appends another click to the same context. Referrer
   absence means `source=unknown`, never an inferred platform.
5. Vayada passes only the opaque browser-context reference through an
   explicitly certified destination transport. Native Booking may accept that
   reference as a server-validated query parameter and bind it during original
   booking creation. An external destination must prove it returns the reference
   through its own certified round trip. An unsupported destination cannot
   activate earning links. No generic cookie or unapproved query parameter is
   assumed to work across providers.

## Recommended data and ordering boundary

- Generate the nonce, `clickId`, server timestamp and monotonic click-history
  position server-side. Do not store guest name, email, IP address, raw user
  agent or full referrer URL in the attribution record. A separately permitted
  normalized source label is optional and has no effect on beneficiary.
- The context groups consented visits from that browser across creator and
  hotel links; the nonce identifies one visit. Its first-party cookie is set
  only after the guest opts in. The context reference sent to a certified
  destination is a cross-domain disclosure that requires separate privacy
  review; it carries no creator or guest details. Append clicks under a lock
  on the context row. Passing a reference through a destination does not
  create another context or duplicate a click.
- Resolve the active agreement and exact accepted terms in the same explicit
  `READ COMMITTED` transaction that inserts the click and retry receipt. Hold
  the activation lock through commit. A pause that commits first blocks the
  click; a click that commits first keeps its historical eligibility.
- Record the accepted terms/version and property at click time. Later terms
  replacement, pause, end or collaboration completion must not rewrite the
  click. A diagnostic probe can never use this live path.
- Booking locks that same context row, then atomically persists the original
  context reference and the last committed history position as its cutoff at
  original creation. This serializes click append and booking binding: a click
  that commits first is inside the cutoff; a later click is outside it. The
  cutoff is per context and original booking, never a mutable browser timestamp.
  Booking must reject guest-supplied creator/agreement/terms and preserve the
  original binding on edits and replacements. A missing, expired or unprovable
  context stays pending, not a negative attribution finding. Completeness is
  limited to consented visits in this browser context; it does not claim
  cross-device or deleted-cookie history.
- The last-eligible-click selector consumes only this trusted history plus the
  booking cutoff. It does not itself prove stay completion, accommodation
  revenue, commission or payment.

## Destination safety gate

Saved destination configuration checks URL shape only; it is not a safe redirect
decision. Before any normal or degraded public redirect, Booking must resolve the
immutable destination version and current, version-scoped safety evidence from
a trusted owner-domain checker. That checker must verify control of the approved
HTTPS host, the exact URL and allowed redirect chain, reject open-redirect
parameters and unsafe schemes/hosts, and revoke evidence on URL-version or
redirect-chain change. Its own network checks must use restricted egress and
must not fetch arbitrary hotel-supplied URLs. No current evidence, no redirect.
Referral round-trip readiness is a separate gate for an _earning_ redirect;
its outage does not imply that URL safety evidence was revoked. Native Booking
and external providers must pass the same safety rule, with provider-specific
evidence where needed.

## Retention proposal requiring approval

Cap the hotel-selected attribution window at **90 days** for newly published
live terms; there is no default and hotels still choose the exact duration.
Current terms parsing and storage permit longer windows. Existing published
terms, accepted agreements, eligible clicks and resulting earnings remain
immutable. An agreement on longer terms cannot activate live earning links
until compliant terms are published and explicitly accepted; this does not
silently shorten its historical terms. Older content can keep earning because
a new eligible click starts a new chosen window while the agreement remains
active. Set a maximum unbound browser-context lifetime of **90 days after its
last click**, without extending any individual click's selected window. Keep
an unbound, minimized click occurrence for a further **30 days** after context
expiry to reconcile delayed creation evidence, then delete or irreversibly
de-identify it. Context expiry or cookie loss means a later booking cannot claim
complete history from that context. Once an original booking is bound, retain
only the minimal click and terms references needed for attribution review under
an approved Finance and privacy retention schedule; do not invent that schedule
here. The privacy owner must approve the consent text, withdrawal effect and
all retention periods before a public route or capture store is enabled.

## Delivery gates

1. Accept the guest choice, window cap, retention and transport model. Record
   privacy-owner approval and an exact retention/erasure owner before live data.
2. Implement and test immutable click occurrence, nonce retry and explicit
   synthetic/test exclusion without a public route or guest data.
3. Resolve exact accepted terms and Booking destination through owner-domain
   ports. Implement the independent URL safety checker and require current
   exact-version host/redirect evidence for every redirect, including degraded
   ones. Require current referral round-trip capability for earning redirects;
   a saved URL alone is insufficient for either gate.
4. Implement native original-booking context/cutoff binding and test concurrent
   click versus booking creation, repeats, tampering, lost context and booking
   replacement. External destinations remain blocked until individually certified.
5. Only then enable the public continue/redirect path. Test no-consent,
   referrerless and blocked-storage browsers, pause/end races, same-link repeat
   visits and no accidental Finance effect. Existing referral URLs and users
   need a separate preservation-aware cutover plan.

This proposal does not choose a provider, promise cross-device attribution or
infer an external completed stay from a redirect or reservation.
