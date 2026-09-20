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

The guest should reach the booking page with one tap. This follows the direct
affiliate-link journey documented by
[Stay22](https://community.stay22.com/allez-deep-links-everything-you-need-to-know)
and [Travelpayouts](https://support.travelpayouts.com/hc/en-us/articles/360027634052-How-to-create-and-use-affiliate-links).
Their link documentation does not settle Vayada's privacy basis; the gate below
does.

1. A creator shares the same `/r/:token` link on any platform. An optional
   campaign label describes the share but never changes the beneficiary.
2. Vayada resolves the token to its persisted agreement, exact accepted terms,
   linked property and exact Booking-owned destination version. It never accepts
   a destination URL, creator, property or eligibility flag from the browser.
   Paused, ended and malformed links fail closed without exposing a destination
   or recording an eligible click. Initial publication requires verified
   destination readiness.
3. For an eligible link, Vayada issues an opaque reference for this visit and
   immediately redirects to the exact approved booking destination. There is no
   separate Vayada consent or continue page. The referral reference, not a
   browser-supplied creator ID, accompanies the redirect. Every new request to
   the shared link is a new click; identical GETs cannot reliably distinguish a
   browser retry from a real revisit. Repeated destination admission of one
   already issued click reference is idempotent. Referrer absence means
   `source=unknown`, never an inferred platform.
4. The booking destination resolves that reference with Vayada and, where an
   approved privacy basis permits, adds it to its first-party booking context.
   Native Booking must bind that context at original booking creation. An
   external destination must prove the same reference round trip and booking
   binding through its own certified integration. If the reference is lost or
   browser storage is unavailable, the booking may proceed but Vayada cannot
   claim complete attribution. Do not treat an existing Booking analytics
   choice as affiliate permission without privacy approval.
5. If referral readiness later becomes temporarily unavailable, redirect only
   to the previously verified exact destination while separate URL safety
   evidence remains current. This visit is untracked; expose degraded tracking
   to the creator and hotel, not an extra guest stop. If URL safety evidence is
   stale or revoked, do not redirect.

## Recommended data and ordering boundary

- Generate the `clickId`, server timestamp and opaque transport reference
  server-side for each link GET. Record that occurrence before redirect; make
  resolution and destination admission of its issued reference idempotent.
  Do not store guest name, email, IP address, raw user agent or full referrer URL
  in the attribution record. A separately permitted normalized source label is
  optional and has no effect on beneficiary.
- The transport reference identifies one click, not a persistent Vayada browser
  cookie. The destination creates or reuses its own first-party context when
  permitted and appends validated click references from repeat creator-link
  visits to that context. This allows a complete ordered history within that
  evidenced destination context, including visits through different creators'
  links. Do not assume this works across devices, destinations or providers.
  Passing the reference to another domain requires privacy review and a
  certified transport; it carries no creator or guest details.
- Resolve the active agreement and exact accepted terms in the same explicit
  `READ COMMITTED` transaction that inserts the click. Hold
  the activation lock through commit. A pause that commits first blocks the
  click; a click that commits first keeps its historical eligibility.
- Record the accepted terms/version and property at click time. Later terms
  replacement, pause, end or collaboration completion must not rewrite the
  click. A diagnostic probe can never use this live path.
- Native Booking locks its own context row, then atomically persists that
  context and its last committed history position as the original booking's
  cutoff. A click admitted to the destination context before booking creation
  is inside the cutoff; a later admission is outside it. The destination must
  acknowledge the incoming click before showing a bookable page, so it cannot
  silently omit that visit from an otherwise complete history. Booking rejects
  guest-supplied creator/agreement/terms and preserves the original binding on
  edits and replacements. A missing, expired or unprovable context stays
  pending, not a negative attribution finding. External destinations need an
  equivalent certified ordering and completeness proof.
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

## Privacy and retention proposal requiring approval

Product direction now permits recording a link tap without an extra guest
screen. The following live-data conditions remain to be verified.

An immediate redirect does not itself establish permission to record a click,
send a cross-domain reference, store a browser identifier or join a click to a
booking. Before live capture, the privacy owner must confirm a lawful basis and
notice valid **before the redirect request** for the click record and reference
transport. Consent obtained later at the destination cannot authorize those
earlier operations. If either operation requires prior guest consent, this
no-interstitial earning path cannot launch as proposed; Vayada may still send
the guest to a safe destination without an attributable click. The destination
must separately meet its own basis and any consent requirement for first-party
context storage and the booking join. Declining cannot prevent booking, and
Vayada must not invent a payable attribution from a lost or unapproved context.
No extra Vayada screen is proposed. Exact withdrawal and erasure behavior also
requires approval before live capture.

Cap the hotel-selected attribution window at **90 days** for newly published
live terms; there is no default and hotels still choose the exact duration.
Current terms parsing and storage permit longer windows. Existing published
terms, accepted agreements, eligible clicks and resulting earnings remain
immutable. An agreement on longer terms cannot activate live earning links
until compliant terms are published and explicitly accepted; this does not
silently shorten its historical terms. Older content can keep earning because
a new eligible click starts a new chosen window while the agreement remains
active. Propose a maximum unbound destination-context lifetime of **90 days
after its last admitted click**, without extending any individual click's
selected window. Keep an unbound, minimized click occurrence for **30 days**
after its own attribution window ends to reconcile delayed creation evidence,
then delete or irreversibly de-identify it. The destination must preserve a
provable completeness floor for the lookback interval; context expiry or loss
means a later booking cannot claim complete history. Once an original booking
is bound, retain only the minimal click and terms references needed for
attribution review under an approved Finance and privacy retention schedule;
do not invent that schedule here. The privacy owner must approve the retention
periods and external provider's equivalent handling before a public route or
capture store is enabled.

## Delivery gates

1. Accept immediate redirect, the window cap, retention and transport model.
   Record privacy-owner approval for click processing, destination storage and
   cross-domain transport, plus an exact retention/erasure owner before live data.
2. Implement and test immutable click occurrence, issued-reference replay and
   explicit synthetic/test exclusion without a public route or guest data.
3. Resolve exact accepted terms and Booking destination through owner-domain
   ports. Implement the independent URL safety checker and require current
   exact-version host/redirect evidence for every redirect, including degraded
   ones. Require current referral round-trip capability for earning redirects;
   a saved URL alone is insufficient for either gate.
4. Implement native destination click admission and original-booking
   context/cutoff binding. Test concurrent click admission versus booking
   creation, repeats, tampering, lost context and booking replacement. External
   destinations remain blocked until individually certified.
5. Only then enable the public redirect path. Test immediate arrival, declined
   or unavailable destination storage, referrerless and blocked-storage
   browsers, pause/end races, same-link repeat visits and no accidental Finance
   effect. Existing referral URLs and users need a separate preservation-aware
   cutover plan.

This proposal does not choose a provider, promise cross-device attribution or
infer an external completed stay from a redirect or reservation.
