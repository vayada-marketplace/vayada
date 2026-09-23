# Live affiliate link and click capture — accepted product contract

VAY-1504 / VAY-1506, consuming VAY-1505 and VAY-1056. Product direction was
accepted on 21 September 2026: record eligible link taps and redirect without an
extra guest screen. Privacy-owner approval, retention ownership, URL-safety
evidence and runtime activation remain separate gates. **This document does not
authorize live capture or a public redirect by itself.**

## Starting point

Marketplace now stores one stable opaque link per activated agreement and can
read whether the agreement is active under a locked `READ COMMITTED` transaction.
The link is still an internal reference: the `/r/:token` route adapter is not
registered by the runtime. Server-owned click occurrences and original-booking
click-history bindings exist as dormant primitives. The existing Booking Web affiliate-click event is diagnostic: its
browser-supplied referral/session fields do not establish creator attribution.
Production link creation also defaults to blocked until its server-owned
readiness adapter is wired; synthetic test readiness is not live evidence.
The visit scope reader resolves the exact activated publication, checks its
accepted disclosure digest, and obtains the destination version and attribution
window under the caller's click transaction. Malformed or over-90-day terms
remain blocked. It does not enable capture or redirects.

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
3. For an eligible link with current referral readiness, Vayada records the click,
   issues an opaque reference for this visit and immediately redirects to the
   exact approved booking destination. There is no
   separate Vayada consent or continue page. The referral reference, not a
   browser-supplied creator ID, accompanies the redirect. Every new request to
   the shared link is a new click when successfully recorded; identical GETs cannot reliably distinguish a
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
   evidence remains current. A failed or uncertain click-store write follows the
   same guest rule: never send its reference as an earning reference. A confirmed
   rollback creates no click record; an ambiguous commit may leave an orphan
   occurrence, which cannot establish attribution without destination admission
   and must be reconciled or removed under the approved retention schedule.
   Degraded visits deliver no transport reference. Before such a redirect,
   persist a destination-scoped incomplete interval. At original creation,
   Booking must keep attribution pending when any unresolved gap intersects the
   context's relevant attribution lookback, including after the outage ends, so
   an older context cookie cannot falsely credit a prior creator. If that gap
   cannot be recorded, do not redirect. Expose degraded
   tracking to the creator and hotel, not an extra guest stop. If URL safety
   evidence is stale or revoked, do not redirect.

## Recommended data and ordering boundary

- Generate the `clickId`, server timestamp and opaque transport reference
  server-side for each successfully captured eligible link GET. Use at least
  128 bits of unpredictable reference entropy. Record the occurrence before
  redirect; make
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
  certified transport; it carries no creator or guest details. Bind its first
  admission to the exact linked property and destination context, give it a
  short acceptance lifetime, remove it from the browser URL before loading
  third-party resources, and redact it from edge/application access logs.
- The current internal synthetic reader accepts a reference only for 15 minutes
  after its server-recorded click for a first destination admission. Expiry
  blocks new admission but a prior admission can still replay in the same
  context. It does not delete the click, shorten the hotel-selected attribution
  window or undo a booking context that already admitted it. Revisit this
  transport TTL during the live privacy and destination review.
- Resolve the active agreement and exact accepted terms in the same explicit
  `READ COMMITTED` transaction that inserts the click. Acquire the activation
  lock before reading lifecycle eligibility and hold it through commit. A pause that commits first blocks the
  click; a click that commits first keeps its historical eligibility.
- Record the accepted terms/version and property at click time. Later terms
  replacement, pause, end or collaboration completion must not rewrite the
  click. A diagnostic probe can never use this live path.
- Native Booking locks its own context row, then atomically persists that
  context and its last committed history position as the original booking's
  cutoff. Under that context lock, assign each admission a monotonic history
  position; a click admitted before booking creation is inside the cutoff and a
  later admission is outside it. The last-click selector orders eligible clicks
  by their server click time, not admission order, and sends exact time ties to
  review rather than arbitrarily changing the beneficiary. After successful
  admission, the destination must acknowledge the incoming click before showing
  a bookable page. If admission or storage fails, show the bookable page when
  current URL safety evidence permits, but make the existing context incomplete
  so an earlier creator cannot win by omission. If that marker cannot be
  durably written, treat attribution as degraded for the affected destination
  interval; original booking binding must keep potentially affected contexts
  pending until a durable gap record and reconciliation resolve the incident.
  Never infer completeness from an old cookie alone. Booking rejects
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

The first implemented checker covers only the native Booking root URL on
`<canonical-slug>.next-booking.vayada.com`. It reads the immutable destination
version and current hotel, slug and custom-domain state in the caller's
transaction. Successful reads produce
`booking-affiliate-destination-safety.v1` evidence bound to the exact property,
destination version, URL and single-URL, zero-redirect chain. Redirect construction accepts this
evidence for at most 60 seconds and rejects a raw URL, an older policy version,
or any changed scope, URL, chain or evidence reference. The evidence must be
resolved and consumed inside the same transaction for each arrival; it is not a
persisted approval. That transaction holds the same per-property advisory lock
as custom-domain mutations, so approval and canonical-domain activation have a
defined order. Production catalog migration acquires those property locks in
sorted order before it can write canonical domains. The immediate redirect
check uses the database validation timestamp, avoiding false rejection from
database/API clock skew. External and custom-domain destinations remain blocked
until their owner supplies equivalent host-control and redirect-chain evidence.

## Native Booking arrival-to-checkout contract

The current Booking Web `?ref` flow is legacy diagnostic traffic. Middleware
stores its value in a 30-day `ref` cookie; `AffiliateClickTracker` posts a
browser-supplied referral code, session ID, landing URL and referrer to the
diagnostic click endpoint. Neither that cookie nor those fields may identify a
creator in the new attribution path. Native pricing checkout currently posts to
a same-origin `/api/booking-web/.../accept` URL, which Next.js rewrites to the
TypeScript Booking API. Its public command contains no affiliate context. The
synthetic server-only context argument added to the pricing writer is not a
guest-facing API field.

The reserved native query parameter is `vref`. Until the arrival/admission
handler and privacy gates are live, Booking Web removes every `vref` value on
booking page routes with a same-host, non-cacheable redirect before rendering
or canonicalizing the hotel host. Such a visit remains untracked. The current
native URL safety candidate accepts only the Booking root URL, which is covered
by this middleware. API, static, and dotted paths are outside that approved
destination contract; expanding allowed destination paths requires extending
the guard before any public affiliate redirect is enabled. The cleanup redirect
uses the browser-facing proxy host only when it is a recognized Booking host or
a domain resolved to a hotel; an unknown host fails closed.

For a live native destination, use the following sequence only after the
redirect, privacy and retention gates above are met:

1. The Marketplace redirect appends one opaque, short-lived click reference to
   the exact approved Booking URL using `vref`, distinct from `ref`.
   It must preserve the approved URL's existing query, reject fragments and a
   pre-existing conflicting reference parameter, and never take a destination
   URL from the visitor. The reference contains no creator, property, campaign
   or guest data. Its presence alone is not an eligible booking.
2. Resolve any approved fallback-host → canonical-host redirect **before**
   admitting the reference or setting a cookie. Preserve the opaque reference
   only across that verified host transition; never forward it to a new or
   unverified domain. The current canonical redirect is a cacheable 308: a
   reference-bearing transition must instead use a temporary, `no-store`
   redirect or land directly on the currently verified canonical host, so a
   later domain change cannot replay a cached destination. On the final host,
   Booking resolves the reference through
   the trusted Marketplace click reader and checks its property against the
   property resolved from that host. Where destination privacy rules permit,
   it creates or reuses a first-party Booking context, serializes admission of
   this click to that context, and stores only an opaque context handle in the
   host-only `__Host-vayada_affiliate_context` cookie with `Path=/`, `HttpOnly`,
   `Secure`, `SameSite=Lax` and a maximum age of 90 days. No `Domain` attribute
   is permitted. Re-delivery of the
   same reference to the same context is idempotent; delivery to another
   context is a conflict. A bad, expired, or mismatched reference cannot set
   or replace the cookie. The page must still load if admission or cookie
   storage is unavailable.
3. Process arrival before rendering the booking page, then redirect on the
   same host to the URL with only the transport reference removed. Preserve
   hotel, locale, dates and other approved booking parameters. This keeps the
   reference out of third-party asset requests and analytics URLs; also do not
   retain it in guest drafts, `localStorage`, `sessionStorage`, or the legacy
   `ref` cookie. If destination context storage is not permitted on arrival,
   continue untracked and discard this reference; later permission cannot
   retroactively credit this visit. The redirect adds no guest screen.
4. At native quote acceptance, the same-origin Booking API receives the
   first-party cookie through the existing Next.js rewrite. It resolves the
   opaque handle to a Booking-owned context for the quote's property and passes
   that context to the pricing writer as a **server-derived** internal argument.
   The writer locks the context, inserts the original booking and freezes its
   admitted-click cutoff in one transaction. The public request body and
   `Idempotency-Key` cannot supply or override the handle, click, creator,
   agreement, terms or cutoff. A missing or invalid cookie leaves attribution
   pending/unbound without blocking an otherwise valid booking.
5. If the rewrite does not reliably forward a host-only cookie or preserve its
   `Set-Cookie` response on every supported custom domain, use a narrowly scoped
   same-origin Next route for arrival and acceptance instead. Do not broaden
   the cookie to `.vayada.com`: hotel custom domains cannot use it and a shared
   domain would widen the tracking scope. Test cookie behavior over HTTPS on a
   real custom-domain fixture before enabling live traffic.

Native readiness must prove the entire reference → first-party context →
original-booking cutoff round trip, including a second visit through another
creator's link, replay, a bad property, blocked storage, and a late click that
cannot move an existing cutoff. It must also cover fallback → custom-domain
canonicalization, changed or revoked custom domains, and arrival without
destination storage permission. A single
click event or the old `?ref` path is
not such proof. The older Booking Web upsert checkout path needs its own
atomic binding before it may claim native affiliate conversions. Until both
privacy approval and these transport checks exist, keep the live capture route
disabled and the existing synthetic records excluded from Finance.

The new pricing quote acceptance writer can freeze a server-owned live context
and its admission cutoff with the original booking. The public acceptance route
derives that context from a first-party cookie only behind a disabled gate.
The dormant Booking API arrival boundary now resolves the supplied final host
through the public hotel profile, requires it to equal that hotel's canonical
booking host, and only then passes the profile's property ID to click admission.
Booking Web now has a disabled-by-default admission path in its `vref` cleanup
redirect. With explicit arrival configuration it asks the Booking API at its
configured absolute server origin for an
admitted context and sets only a host-only `__Host-vayada_affiliate_context`
cookie on success; denial or service failure continues the clean redirect
untracked. The API endpoint is internal-token protected and only registered
when an arrival adapter is explicitly supplied. Production startup does not
supply one, so the route cannot yet receive live clicks. Runtime database
grants, privacy approval, final-host revalidation and HTTPS browser transport
checks remain launch gates before enabling the Booking Web flag.
The quote-acceptance route now has a separate disabled-by-default cookie binding
gate. When enabled, it reads exactly one UUID handle from the host-only cookie,
checks that a live context belongs to the quote's current canonical hotel and
has an admission within the last 90 days, then passes the handle to the pricing
writer as an internal argument. Missing, malformed, duplicate, foreign, stale
or unavailable context evidence leaves the booking unbound. The writer still
locks the context, rechecks the 90-day lifetime after any lock wait, and
freezes an eligible admitted-click cutoff with the original booking. Production
startup does not enable this gate. End-to-end HTTPS cookie
forwarding and a real click-to-booking test are still required before launch.

## Product retention choice requiring privacy approval

Product accepted a maximum hotel-selected attribution window of 90 days and
30 additional days to reconcile an unmatched click after its own window ends.
This is a product decision, not privacy-owner approval or authorization to
collect live guest data. New terms over 90 days cannot be published; previously
published terms and any resulting earnings remain unchanged. Automatic deletion
must wait for a reliable original-booking binding so it cannot remove evidence
needed for an attributed booking.

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
5. Only then enable the public redirect path, with an explicit edge rate limit or
   quota on persisted click writes so crawlers and abusive requests cannot create
   unbounded durable records. Test immediate arrival, declined
   or unavailable destination storage, referrerless and blocked-storage
   browsers, pause/end races, same-link repeat visits and no accidental Finance
   effect. Existing referral URLs and users need a separate preservation-aware
   cutover plan.

The `/r/:publicToken` route adapter exists for isolated tests but is not
registered by the runtime. Registration requires a production quota provider
that rejects before any click write, production visit wiring,
and completion of the privacy and readiness gates above. The API suppresses
default request logs for `/r/` and URLs carrying `vref`.

The normal-visit transaction now combines the accepted scope reader, current
native URL-safety evidence, referral round-trip readiness, and one immutable
click write. It defaults to blocked without a server-owned readiness
configuration; test-only readiness responses do not authorize production use.
Optional campaign labels are stored only as advisory occurrence metadata. The
normal transaction does not yet provide the durable incomplete interval needed
for a safe degraded redirect, so it remains disconnected from the public route.

This proposal does not choose a provider, promise cross-device attribution or
infer an external completed stay from a redirect or reservation.
