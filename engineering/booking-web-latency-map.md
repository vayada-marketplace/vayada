# Booking Web Latency Map

_VAY-834 spike output for VAY-809. This document maps the guest-facing
booking-web latency path beyond custom domains and records which follow-up
ticket owns each hotspot._

## Purpose

VAY-809 started from a custom-domain page feeling slow, but the performance
target is the full booking-web guest flow. Custom domains are a high-signal
reproduction path because they exercise host resolution, canonical URL policy,
production API routing, and CORS. They are not the only pages that matter.

The main customer assumption for this work is:

- Guests and customers are primarily in Europe.
- Many hotels are in Southeast Asia.
- Date, availability, cutoff, and pricing behavior must stay hotel-local, but
  stable public profile data should not require fresh round trips on every page
  transition.

## Evidence Snapshot

Baseline from VAY-809:

- `https://booking.tigalombok.com/` initial load measured roughly 7.2s TTFB.
- Selecting a rate produced an `/addons?...&_rsc=...` route-transition request
  around 9.7s for a small response body.
- DevTools showed failed `https://api.vayada.com/api/booking-web/...` calls from
  `https://booking.tigalombok.com`.

Point-in-time curl check from the local machine on 2026-06-12:

```text
url=https://booking.tigalombok.com/?checkIn=2026-06-14&checkOut=2026-06-15&adults=2&children=0
status=200
dns=0.108s
connect=0.171s
tls=0.235s
ttfb=7.180s
total=7.191s
size=29448 bytes
```

Local `https://hotel-alpenrose.booking.localhost/en` timing was unavailable in
this worktree because portless was not running, so no local/prod timing
comparison is recorded here.

Untracked trace artifacts from the earlier investigation were inspected but not
checked in. They showed the production page falling through multiple API origins
after hydration (`api.vayada.com`, `booking-api.vayada.com`, and
`pms-api.vayada.com`) and many Next image requests using `w=3840` for room
media.

## Current Guest Flow

| Flow segment                    | Current behavior                                                                                                                                                                                                                                      | Latency risk                                                                                                                                                                                                                                                                     | Owner                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Host to slug                    | `apps/booking-web/lib/server/resolveSlug.ts` derives Vayada/local subdomains locally, then calls `bookingWebPublicApi.resolveHost(host)` for arbitrary/custom hosts. That client falls back to legacy Booking API domain resolution and hotel lookup. | Custom domains can block server render on a network lookup. A failed or wrong public API origin creates extra retries/fallbacks before the page can render.                                                                                                                      | VAY-829 and VAY-830                                |
| Root locale layout              | `apps/booking-web/app/[locale]/layout.tsx` runs `generateMetadata`, resolves the slug, then calls `fetchPublicHotel`. The layout resolves the slug and calls `fetchPublicHotel` again for structured data and provider setup.                         | Every booking-web page, including checkout pages, inherits this work. `fetchPublicHotel` currently uses `cache: "no-store"` for both the public API call and legacy fallback, so stable hotel/profile metadata is fetched fresh on each server render.                           | VAY-829 and VAY-832                                |
| Public hotel metadata           | `apps/booking-web/lib/server/publicHotelMetadata.ts` fetches `/api/booking-web/hotels/{slug}?locale=...`, then falls back to legacy `/api/hotels/{slug}?lang=...`.                                                                                    | The stable profile path is serial and uncached. In the Europe guest -> Southeast Asia hotel case, each extra server/API round trip is amplified by regional distance and backend origin placement.                                                                               | VAY-829                                            |
| Client bootstrap                | `HotelProvider` fetches hotel, rooms, and add-ons after hydration with `Promise.all`. Hotel and room calls try the Booking Web public API first, then fall back to legacy Booking/PMS routes. Add-ons still call legacy Booking API directly.         | Guests can see a slow or partially empty page after the document arrives. Public API failures add fallback latency and CORS noise. Availability/offer calls must remain fresh, but stable hotel and add-on configuration can be treated differently from live room availability. | VAY-830, VAY-834 follow-up if new hotspot is found |
| Room search refresh             | Home page filters call `refetchRooms`, which hits offers first and falls back to PMS room availability.                                                                                                                                               | This is dynamic and hotel-date-sensitive; caching must be bounded by offer freshness, inventory sync, and hotel-local date rules. It should be measured separately from stable metadata.                                                                                         | VAY-834 follow-up if needed                        |
| Select This Rate                | `apps/booking-web/app/[locale]/page.tsx` and `RoomDetailModal` call `router.push(...)` to `/addons` or `/book` without an immediate pending state.                                                                                                    | Even when the backend is slow, the UI does not acknowledge the click immediately. The RSC transition also reruns inherited layout work.                                                                                                                                          | VAY-831                                            |
| Add-ons                         | `/addons` has static noindex metadata, but it still inherits root locale layout metadata/profile work. Add-on data comes from `HotelProvider`.                                                                                                        | The route transition can wait on stable profile work before rendering a task page. Add-on images may add avoidable network cost after render.                                                                                                                                    | VAY-832 and VAY-833                                |
| Book/details                    | `/book` has static noindex metadata but inherits root layout work and uses `HotelProvider` add-ons plus checkout form state.                                                                                                                          | Same inherited metadata cost as `/addons`; dynamic booking form state should not be cached as if it were public profile data.                                                                                                                                                    | VAY-832                                            |
| Payment                         | `/payment` has static noindex metadata but inherits root layout work. It fetches payment/checkout configuration and creates/uses payment authorization state.                                                                                         | Payment config may be cacheable only in narrow cases; payment intent, booking draft, and authorization state must remain fresh.                                                                                                                                                  | VAY-834 follow-up if needed                        |
| Confirmation and manage booking | Booking confirmation, my-booking, lookup, cancellation, and change-request pages use guest-specific booking data.                                                                                                                                     | These are not the original `Select This Rate` path, but they are part of the broader guest flow. Guest-specific data must not share public metadata caching rules.                                                                                                               | VAY-834 follow-up if needed                        |
| Images                          | Several `next/image` usages omit `sizes`. The inspected trace showed room media requested through `/_next/image?...&w=3840&q=75`; add-on image components also omit `sizes`.                                                                          | Oversized image variants compete with API and RSC work, especially for European guests loading Southeast Asia property media from remote storage/CDN paths.                                                                                                                      | VAY-833                                            |

## Region-Sensitive Constraints

The key risk is not only raw distance between Europe and Southeast Asia. It is
the number of serialized public-page dependencies in front of the guest:

1. Browser to booking-web server for the HTML or RSC response.
2. Booking-web server to host resolution and public profile APIs.
3. Browser to public/legacy APIs after hydration.
4. Browser to image optimizer, then image optimizer to remote media storage.
5. Dynamic offer/payment/booking calls whose freshness depends on hotel-local
   inventory, cutoff, and payment state.

The implementation should separate stable and dynamic data:

- Stable or slowly changing: host-to-slug mapping, canonical URL policy, public
  hotel profile, locale support, branding/favicon, structured data inputs, and
  add-on catalog metadata.
- Dynamic or guest-specific: room offers, availability, promo validation,
  checkout form submission, payment configuration when provider state matters,
  booking drafts, payment authorization, booking lookup, cancellation, and
  change-request state.

This split matters for Europe-to-Southeast-Asia usage because cached stable
metadata can make every guest-flow page faster without weakening availability
or payment correctness.

## Measurement Points

Use these points when validating VAY-829 through VAY-833:

| Segment                     | What to measure                                                                        | Good signal                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Initial document            | Navigation TTFB and total time for custom-domain and normal booking-host pages.        | TTFB materially below the VAY-809 ~7.2s baseline for `booking.tigalombok.com` under normal production conditions.            |
| Server profile work         | Count and timing of host resolution plus `fetchPublicHotel` per request.               | One host resolution at most and one public hotel metadata fetch per slug/locale/request; stable metadata uses a bounded TTL. |
| Hydration bootstrap         | Public API requests after first paint: hotel, offers, add-ons, exchange rates, events. | No failed `api.vayada.com/api/booking-web/...` custom-domain calls; fallbacks are exceptional, not normal.                   |
| Rate selection              | Click-to-pending-state and click-to-next-route-render for room card and room modal.    | Pending state appears immediately; RSC `/addons` or `/book` transition no longer waits on stable metadata work.              |
| Add-ons                     | Image request count, requested widths, decoded sizes, and layout shift.                | Add-on and room media request sizes match rendered dimensions and do not block primary booking interaction.                  |
| Checkout details            | Checkout config, add-ons, and form data timing.                                        | Public profile/cache fixes do not cache guest-specific checkout or payment state.                                            |
| Payment                     | Payment config and authorization request timing/error paths.                           | No regression to payment correctness or duplicate payment/booking submission.                                                |
| Confirmation/manage booking | Booking status/lookup/cancel/change timing and error states.                           | Broader guest-flow pages still work after metadata/cache changes, but guest-specific data remains uncached.                  |

## Recommendations

1. Start with VAY-829, because root layout metadata and host/profile lookups are
   on every booking-web page. Use request-scoped dedupe plus short TTL caching
   for stable public profile data.
2. Handle VAY-830 in parallel or immediately after VAY-829. Failed public API
   calls and CORS failures turn normal flows into fallback-heavy flows and make
   measurements noisy.
3. Then implement VAY-831 so guests get immediate feedback and checkout routes
   can be prefetched/warmed where safe.
4. Implement VAY-832 before treating checkout timing as fixed. The noindex
   checkout child layouts are static, but the root locale layout still performs
   SEO/public-profile work.
5. Implement VAY-833 to reduce image pressure across rooms and add-ons. The
   trace evidence points to oversized room media as well as add-on image
   components without `sizes`, so this should be evaluated across booking pages,
   not only add-ons.

Open additional child issues only if measurement finds a hotspot outside this
set, such as checkout-config latency, exchange-rate latency, or guest booking
lookup/cancellation latency. Those would be separate from the stable metadata
fix because they involve dynamic or guest-specific state.
