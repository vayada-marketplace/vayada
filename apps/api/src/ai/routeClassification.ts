// Every next-api route sorted for the AI, exactly once (VAY-2507; decisions of 2026-11-20).
//
// A route is either the route of a registered action (actions/registry.ts; those are NOT listed
// here) or listed here with one class:
//   never           Flamur's never list (src/ai/neverList.ts): no action, for any role, on any
//                   surface. It wins over every entry and rule here and is checked on its own.
//   ask_first_later rare setup tasks: no action yet; each becomes Ask first when its screen does.
//   not_for_ai      not a user feature, or unsafe as it is today (broken, dead, a second writer,
//                   a read with side effects; VAY-2567 ranks 2-3).
//   later           a hotel user's route that is not an action yet. VAY-2567 ranks the order.
// A registered action whose route is listed here fails at module load (actions/registry.ts), and
// a route in the generated route list that is neither an action nor listed fails CI.
import { neverArea, type NeverArea } from "./neverList.js";
import { ROUTE_MANIFEST, type RouteKey } from "./routeManifest.generated.js";

export type { NeverArea } from "./neverList.js";

export type AskFirstLaterArea =
  | "custom_domain"
  | "channel_connection"
  | "product_tracks_and_modules"
  | "payment_settings_and_windows"
  | "data_retention"
  | "airbnb_guest_review";

export type NotForAiReason =
  /** Health checks, webhooks, CORS preflights: machine traffic. */
  | "infrastructure"
  /** The guest-facing booking site and other public pages (Concierge uses domain services). */
  | "public_guest_page"
  /** Partner apps call these with their own tokens (VAY-2436). */
  | "partner_api"
  /** Always fails today (500, 403 or 409). */
  | "broken"
  /** No website caller: not proven, so not exposed (design note §2.2). */
  | "no_caller"
  /** A second writer or reader for a job another route owns (one owning route per job). */
  | "duplicate"
  /** A "read" that writes rows, calls Channex or takes write locks (VAY-2567 rank 2). */
  | "side_effect_read"
  /** Returns data no projection may receive (deny-listed reads, design note §3.2). */
  | "data_deny_list"
  /** A signed file link or an upload session: not a value an AI should pass around. */
  | "file_link"
  /** Costs money per call (e.g. Google lookups). */
  | "paid_external_call"
  /** The AI calling the AI. */
  | "ai_calling_ai"
  /** Needs an owner browser session (inventory A): no delegated context passes it. VAY-2567
   * decides per route whether it moves to the never list or its gate changes. */
  | "owner_session"
  /** The server fetches a URL the caller gives. */
  | "server_fetch"
  /** Static or viewer-state plumbing with no job of its own. */
  | "plumbing";

export type RouteClass =
  | { class: "never"; area: NeverArea; note?: string }
  | { class: "ask_first_later"; area: AskFirstLaterArea; note?: string }
  | { class: "not_for_ai"; reason: NotForAiReason; note?: string }
  | { class: "later"; note?: string };

const askLater = (area: AskFirstLaterArea, note?: string): RouteClass => ({
  class: "ask_first_later",
  area,
  note,
});
const notForAi = (reason: NotForAiReason, note?: string): RouteClass => ({
  class: "not_for_ai",
  reason,
  note,
});
const later = (note?: string): RouteClass => ({ class: "later", note });

/** pricing-v2 reads take the inventory lock and the account row FOR UPDATE (VAY-2510 decides). */
const PRICING_LOCK = "write-grade locks on read; VAY-2510's load test decides";

/**
 * Whole areas sorted by path. An exact entry below overrides a rule; every rule must still sort
 * at least one route (tested).
 */
export const ROUTE_CLASS_RULES: readonly { match: RegExp; routeClass: RouteClass }[] = [
  { match: /^OPTIONS /, routeClass: notForAi("infrastructure", "CORS preflight") },
  {
    match: /^GET (\/[a-z-]+)*\/(health|ready)$/,
    routeClass: notForAi("infrastructure", "health check"),
  },
  { match: /^POST \/webhooks\//, routeClass: notForAi("infrastructure", "provider webhook") },
  // The area rules never take a preflight or a health check (the two rules above do).
  { match: /^(?!OPTIONS)[A-Z]+ \/partner\//, routeClass: notForAi("partner_api") },
  {
    // Named paths only: a new /api/ai route (e.g. AI connections) must be sorted by a person.
    match: /^(?!OPTIONS)[A-Z]+ \/api\/(booking-web\/|ai\/hotels\/)/,
    routeClass: notForAi("public_guest_page"),
  },
];

/**
 * Every other non-action route, one entry each. Seeded on 2026-11-20 from the API review
 * (VAY-2567, research/10 appendix A), the authority inventory (engineering/ai-actions-authority-
 * inventory.md) and Flamur's lists of 2026-11-20. A new route lands here as later() unless it
 * belongs to one of the areas above.
 */
export const ROUTE_CLASSES: Partial<Record<RouteKey, RouteClass>> = {
  "GET /api/booking/account-booking-page": later(),
  "PUT /api/booking/account-booking-page": later(),
  "GET /api/booking/hotels/:hotelId/addon-items": later(),
  "POST /api/booking/hotels/:hotelId/addon-items": later(),
  "DELETE /api/booking/hotels/:hotelId/addon-items/:addonItemId": later(),
  "PATCH /api/booking/hotels/:hotelId/addon-items/:addonItemId": later(),
  "DELETE /api/booking/hotels/:hotelId/custom-domain": askLater("custom_domain"),
  "GET /api/booking/hotels/:hotelId/custom-domain": askLater("custom_domain"),
  "PUT /api/booking/hotels/:hotelId/custom-domain": askLater("custom_domain"),
  "GET /api/booking/hotels/:hotelId/policy-check": notForAi("no_caller"),
  "GET /api/booking/hotels/:hotelId/promo-codes": later(),
  "POST /api/booking/hotels/:hotelId/promo-codes": later(),
  "DELETE /api/booking/hotels/:hotelId/promo-codes/:promoCodeId": later(),
  "PATCH /api/booking/hotels/:hotelId/promo-codes/:promoCodeId": later(),
  "GET /api/booking/hotels/:hotelId/property-link": notForAi(
    "plumbing",
    "actions pass the canonical property id",
  ),
  "POST /api/booking/hotels/:hotelId/public-bookability": notForAi(
    "duplicate",
    "internal refresh step; without when=live it publishes a first page",
  ),
  "GET /api/booking/hotels/:hotelId/reservations": notForAi(
    "data_deny_list",
    "platform fee and payout under booking.reservation.read",
  ),
  "GET /api/booking/hotels/:hotelId/reservations/:bookingId/change-request": notForAi(
    "duplicate",
    "the PMS mount owns change and extras requests",
  ),
  "POST /api/booking/hotels/:hotelId/reservations/:bookingId/change-request/:changeRequestId/accept":
    notForAi("duplicate", "the PMS mount owns change and extras requests"),
  "POST /api/booking/hotels/:hotelId/reservations/:bookingId/change-request/:changeRequestId/decline":
    notForAi("duplicate", "the PMS mount owns change and extras requests"),
  "GET /api/booking/hotels/:hotelId/reservations/:bookingId/extras-request": notForAi(
    "duplicate",
    "the PMS mount owns change and extras requests",
  ),
  "POST /api/booking/hotels/:hotelId/reservations/:bookingId/extras-request/:requestId/accept":
    notForAi("duplicate", "the PMS mount owns change and extras requests"),
  "POST /api/booking/hotels/:hotelId/reservations/:bookingId/extras-request/:requestId/decline":
    notForAi("duplicate", "the PMS mount owns change and extras requests"),
  "GET /api/booking/hotels/:hotelId/settings/addons": later(),
  "PUT /api/booking/hotels/:hotelId/settings/addons": later(),
  "GET /api/booking/hotels/:hotelId/settings/benefits": later(),
  "PUT /api/booking/hotels/:hotelId/settings/benefits": later(),
  "GET /api/booking/hotels/:hotelId/settings/booking-acceptance": later(),
  "PUT /api/booking/hotels/:hotelId/settings/booking-acceptance": later(),
  "GET /api/booking/hotels/:hotelId/settings/design": later(),
  "PATCH /api/booking/hotels/:hotelId/settings/design": later(),
  "GET /api/booking/hotels/:hotelId/settings/guest-form": later(),
  "PUT /api/booking/hotels/:hotelId/settings/guest-form": later(),
  "GET /api/booking/hotels/:hotelId/settings/last-minute": later(),
  "PUT /api/booking/hotels/:hotelId/settings/last-minute": later(),
  "GET /api/booking/hotels/:hotelId/settings/localization": later(),
  "PUT /api/booking/hotels/:hotelId/settings/localization": later(),
  "GET /api/booking/hotels/:hotelId/settings/property": later(),
  "PATCH /api/booking/hotels/:hotelId/settings/property": later(),
  "GET /api/booking/hotels/:hotelId/settings/room-filters": later(),
  "PUT /api/booking/hotels/:hotelId/settings/room-filters": later(),
  "GET /api/booking/hotels/:hotelId/settings/same-day-booking": later(),
  "PUT /api/booking/hotels/:hotelId/settings/same-day-booking": later(),
  "GET /api/booking/properties/:propertyId/booking-design": later(),
  "PUT /api/booking/properties/:propertyId/booking-design": later(),
  "GET /api/booking/properties/:propertyId/booking-design/readiness": later(),
  "GET /api/booking/properties/:propertyId/booking-guest-policy": notForAi(
    "no_caller",
    "legacy guest policy; guest rules and terms replace it",
  ),
  "PUT /api/booking/properties/:propertyId/booking-guest-policy": notForAi(
    "no_caller",
    "legacy guest policy; guest rules and terms replace it",
  ),
  "POST /api/booking/properties/:propertyId/booking-guest-policy/preview": notForAi(
    "no_caller",
    "legacy guest policy; guest rules and terms replace it",
  ),
  "GET /api/booking/properties/:propertyId/booking-guest-policy/readiness": notForAi(
    "no_caller",
    "legacy guest policy; guest rules and terms replace it",
  ),
  "GET /api/booking/properties/:propertyId/dashboard/bookings-by-source": later(),
  "GET /api/booking/properties/:propertyId/dashboard/conversion-funnel": later(),
  "GET /api/booking/properties/:propertyId/dashboard/page-views": later(),
  "GET /api/booking/properties/:propertyId/dashboard/sparklines": later(),
  "GET /api/booking/properties/:propertyId/dashboard/stats": later(),
  "GET /api/booking/properties/:propertyId/guest-rules": later(),
  "PUT /api/booking/properties/:propertyId/guest-rules": later(),
  "GET /api/booking/properties/:propertyId/guest-terms": later(),
  "PUT /api/booking/properties/:propertyId/guest-terms": later(),
  "GET /api/booking/properties/:propertyId/location-map": later(),
  "PUT /api/booking/properties/:propertyId/location-map": later(),
  "PUT /api/booking/properties/:propertyId/location-map/nearby": later(),
  "GET /api/booking/properties/:propertyId/notifications": later(),
  "POST /api/booking/properties/:propertyId/notifications/read": notForAi(
    "plumbing",
    "read markers",
  ),
  "POST /api/booking/properties/:propertyId/notifications/read-all": notForAi(
    "plumbing",
    "read markers",
  ),
  "GET /api/booking/properties/:propertyId/partner-connections": later(),
  "GET /api/booking/properties/:propertyId/room-sorting": later(),
  "PUT /api/booking/properties/:propertyId/room-sorting": later(),
  "POST /api/contact": notForAi("public_guest_page", "landing page contact form"),
  "GET /api/finance/properties/:propertyId/cancellation-policy": later(),
  "GET /api/finance/properties/:propertyId/financials/access": later(),
  "GET /api/finance/properties/:propertyId/financials/dashboard": later(),
  "GET /api/finance/properties/:propertyId/financials/expense-categories": later(),
  "POST /api/finance/properties/:propertyId/financials/expense-categories": later(),
  "DELETE /api/finance/properties/:propertyId/financials/expense-categories/:categoryId": later(),
  "PATCH /api/finance/properties/:propertyId/financials/expense-categories/:categoryId": later(),
  "GET /api/finance/properties/:propertyId/financials/expenses": later(),
  "POST /api/finance/properties/:propertyId/financials/expenses": later(),
  "DELETE /api/finance/properties/:propertyId/financials/expenses/:expenseId": later(),
  "GET /api/finance/properties/:propertyId/financials/expenses/:expenseId": later(),
  "PATCH /api/finance/properties/:propertyId/financials/expenses/:expenseId": later(),
  "GET /api/finance/properties/:propertyId/financials/expenses/:expenseId/receipt":
    notForAi("file_link"),
  "GET /api/finance/properties/:propertyId/financials/folios": later(),
  "POST /api/finance/properties/:propertyId/financials/folios": later(),
  "DELETE /api/finance/properties/:propertyId/financials/folios/:folioId": later(
    "owner only, in-app only, on demand (inventory F20)",
  ),
  "GET /api/finance/properties/:propertyId/financials/folios/:folioId": later(),
  "PATCH /api/finance/properties/:propertyId/financials/folios/:folioId": later(),
  "POST /api/finance/properties/:propertyId/financials/folios/:folioId/ready": later(
    "owner only, in-app only, on demand (inventory F20)",
  ),
  "GET /api/finance/properties/:propertyId/financials/ota-commission-settings": later(),
  "PUT /api/finance/properties/:propertyId/financials/ota-commission-settings/:channel": later(),
  "GET /api/finance/properties/:propertyId/financials/profit-loss": later(),
  "DELETE /api/finance/properties/:propertyId/financials/recurring-expenses/:ruleId": later(),
  "GET /api/finance/properties/:propertyId/financials/recurring-expenses/:ruleId": later(),
  "PATCH /api/finance/properties/:propertyId/financials/recurring-expenses/:ruleId": later(),
  "GET /api/finance/properties/:propertyId/financials/revenue": later(),
  "GET /api/finance/properties/:propertyId/manual-payment-methods": later(),
  "PUT /api/finance/properties/:propertyId/payment-methods": askLater(
    "payment_settings_and_windows",
  ),
  "GET /api/finance/properties/:propertyId/payment-readiness": later(),
  "GET /api/finance/properties/:propertyId/payment-settings": later(),
  "PATCH /api/finance/properties/:propertyId/payment-settings": askLater(
    "payment_settings_and_windows",
  ),
  "GET /api/finance/properties/:propertyId/payment-windows": later(),
  "PUT /api/finance/properties/:propertyId/payment-windows": askLater(
    "payment_settings_and_windows",
  ),
  "GET /api/hotel-setup/imports/prepared": notForAi(
    "duplicate",
    "side door around the profile command",
  ),
  "POST /api/hotel-setup/properties": notForAi("owner_session", "creates a property"),
  "POST /api/hotel-setup/properties/:propertyId/airbnb-import/complete": askLater(
    "channel_connection",
    "Airbnb import",
  ),
  "GET /api/hotel-setup/properties/:propertyId/airbnb-import/sources/:sourceId": askLater(
    "channel_connection",
    "Airbnb import",
  ),
  "GET /api/hotel-setup/properties/:propertyId/airbnb-import/sources/:sourceId/review": askLater(
    "channel_connection",
    "Airbnb import",
  ),
  "POST /api/hotel-setup/properties/:propertyId/airbnb-import/sources/:sourceId/review": askLater(
    "channel_connection",
    "Airbnb import",
  ),
  "POST /api/hotel-setup/properties/:propertyId/airbnb-import/start": askLater(
    "channel_connection",
    "Airbnb import",
  ),
  "GET /api/hotel-setup/properties/:propertyId/checklist/v2": notForAi("owner_session"),
  "POST /api/hotel-setup/properties/:propertyId/checklist/v2/acknowledgements":
    notForAi("owner_session"),
  "PUT /api/hotel-setup/properties/:propertyId/checklist/v2/viewer": notForAi("owner_session"),
  "GET /api/hotel-setup/properties/:propertyId/first-run": notForAi("owner_session"),
  "GET /api/hotel-setup/properties/:propertyId/import": notForAi(
    "duplicate",
    "side door around the profile command",
  ),
  "POST /api/hotel-setup/properties/:propertyId/import": notForAi(
    "duplicate",
    "side door around the profile command",
  ),
  "GET /api/hotel-setup/properties/:propertyId/launch-settings": later(),
  "PUT /api/hotel-setup/properties/:propertyId/launch-settings": notForAi("owner_session"),
  "PUT /api/hotel-setup/properties/:propertyId/media/logo": notForAi("owner_session"),
  "PUT /api/hotel-setup/properties/:propertyId/media/presentation": later(),
  "GET /api/hotel-setup/properties/:propertyId/nearby": notForAi(
    "paid_external_call",
    "Google lookups",
  ),
  "GET /api/hotel-setup/properties/:propertyId/nearby/curation": later(),
  "PUT /api/hotel-setup/properties/:propertyId/nearby/curation": later(),
  "POST /api/hotel-setup/properties/:propertyId/nearby/refresh": notForAi(
    "paid_external_call",
    "Google lookups",
  ),
  "GET /api/hotel-setup/properties/:propertyId/profile": later(),
  "PUT /api/hotel-setup/properties/:propertyId/profile": notForAi("owner_session"),
  "GET /api/hotel-setup/properties/:propertyId/public-profile": later(),
  "PUT /api/hotel-setup/properties/:propertyId/public-profile": later(),
  "GET /api/hotel-setup/properties/:propertyId/publications/booking": later(),
  "POST /api/hotel-setup/properties/:propertyId/publications/booking": later(),
  "GET /api/hotel-setup/properties/:propertyId/route": later(),
  "PUT /api/hotel-setup/properties/:propertyId/setup-drafts/:stepId": later(),
  "POST /api/hotel-setup/properties/:propertyId/setup-drafts/:stepId/reset": later(),
  "GET /api/hotel-setup/properties/:propertyId/steps/present-hotel": later(),
  "PUT /api/hotel-setup/properties/:propertyId/steps/present-hotel": later(),
  "GET /api/hotel-setup/property-types": notForAi("plumbing", "static list"),
  "PUT /api/hotel-setup/tracks": askLater("product_tracks_and_modules"),
  "POST /api/maps-links/resolve": notForAi("server_fetch"),
  "POST /api/media/imports": notForAi("server_fetch"),
  "GET /api/media/pms/properties/:propertyId/messaging/threads/:threadId/attachments/:attachmentId":
    notForAi("file_link"),
  "POST /api/media/upload-sessions": notForAi("file_link", "upload sessions"),
  "POST /api/media/upload-sessions/:sessionId/finalize": notForAi("file_link", "upload sessions"),
  "GET /api/pms/properties": notForAi("broken", "always answers 500"),
  "GET /api/pms/properties/:hotelId/reservations/:bookingId/change-request": later(),
  "POST /api/pms/properties/:hotelId/reservations/:bookingId/change-request/:changeRequestId/accept":
    later(),
  "POST /api/pms/properties/:hotelId/reservations/:bookingId/change-request/:changeRequestId/decline":
    later(),
  "GET /api/pms/properties/:hotelId/reservations/:bookingId/extras-request": later(),
  "POST /api/pms/properties/:hotelId/reservations/:bookingId/extras-request/:requestId/accept":
    later(),
  "POST /api/pms/properties/:hotelId/reservations/:bookingId/extras-request/:requestId/decline":
    later(),
  "GET /api/pms/properties/:propertyId/booking-acceptance": notForAi(
    "duplicate",
    "second writer; Booking Admin settings/booking-acceptance owns it",
  ),
  "PUT /api/pms/properties/:propertyId/booking-acceptance": notForAi(
    "duplicate",
    "second writer; Booking Admin settings/booking-acceptance owns it",
  ),
  "GET /api/pms/properties/:propertyId/booking-modules": later(),
  "PATCH /api/pms/properties/:propertyId/booking-modules/:moduleId": askLater(
    "product_tracks_and_modules",
  ),
  "GET /api/pms/properties/:propertyId/calendar-auto-open": later(),
  "PATCH /api/pms/properties/:propertyId/calendar-auto-open": later(),
  "GET /api/pms/properties/:propertyId/calendar-settings": later(),
  "PATCH /api/pms/properties/:propertyId/calendar-settings": later(),
  "GET /api/pms/properties/:propertyId/calendar-shuffles": later(),
  "GET /api/pms/properties/:propertyId/channex": later(),
  "GET /api/pms/properties/:propertyId/channex/alerts": later(),
  "POST /api/pms/properties/:propertyId/channex/alerts/:alertId/:action": later(),
  "GET /api/pms/properties/:propertyId/channex/alerts/:alertId/diagnostics": later(),
  "POST /api/pms/properties/:propertyId/channex/commands": askLater("channel_connection"),
  "POST /api/pms/properties/:propertyId/channex/iframe-session": askLater("channel_connection"),
  "PUT /api/pms/properties/:propertyId/channex/inventory-rules": later(),
  "PUT /api/pms/properties/:propertyId/channex/markups": later(),
  "GET /api/pms/properties/:propertyId/channex/offer-preview": notForAi(
    "side_effect_read",
    "write-grade locks",
  ),
  "GET /api/pms/properties/:propertyId/channex/operations/:operationId": later(),
  "POST /api/pms/properties/:propertyId/channex/published-offers/provision":
    askLater("channel_connection"),
  "GET /api/pms/properties/:propertyId/check-in-checklist": later(),
  "PUT /api/pms/properties/:propertyId/check-in-checklist": later(),
  "GET /api/pms/properties/:propertyId/check-in-settings": later(),
  "PUT /api/pms/properties/:propertyId/check-in-settings": later(),
  "GET /api/pms/properties/:propertyId/check-out-inspection": later(),
  "PUT /api/pms/properties/:propertyId/check-out-inspection": later(),
  "GET /api/pms/properties/:propertyId/guest-data-settings": later(),
  "PUT /api/pms/properties/:propertyId/guest-data-settings": askLater("data_retention"),
  "GET /api/pms/properties/:propertyId/guest-reviews": notForAi(
    "side_effect_read",
    "calls Channex on every read; VAY-2567 rank 2",
  ),
  "GET /api/pms/properties/:propertyId/guest-reviews/:reviewId": notForAi(
    "side_effect_read",
    "checks with Channex; VAY-2567 rank 2",
  ),
  "POST /api/pms/properties/:propertyId/guest-reviews/:reviewId": askLater(
    "airbnb_guest_review",
    "a permanent public review of a guest",
  ),
  "GET /api/pms/properties/:propertyId/guest-stay-times": later(),
  "GET /api/pms/properties/:propertyId/guests": later(),
  "GET /api/pms/properties/:propertyId/guests/:guestProfileId": later(),
  "PATCH /api/pms/properties/:propertyId/guests/:guestProfileId": later(),
  "POST /api/pms/properties/:propertyId/guests/:guestProfileId/merge": later(),
  "POST /api/pms/properties/:propertyId/guests/:guestProfileId/notes": later(),
  "DELETE /api/pms/properties/:propertyId/guests/:guestProfileId/notes/:noteId": later(),
  "POST /api/pms/properties/:propertyId/guests/:guestProfileId/separate": later(),
  "POST /api/pms/properties/:propertyId/inventory-materialization": later(),
  "GET /api/pms/properties/:propertyId/linked-inventory-groups": later(),
  "POST /api/pms/properties/:propertyId/linked-inventory-groups": later(),
  "DELETE /api/pms/properties/:propertyId/linked-inventory-groups/:groupId": later(),
  "PUT /api/pms/properties/:propertyId/linked-inventory-groups/:groupId": later(),
  "GET /api/pms/properties/:propertyId/mandatory-charge-confirmation": notForAi("no_caller"),
  "POST /api/pms/properties/:propertyId/manual-bookings": later(),
  "GET /api/pms/properties/:propertyId/manual-bookings/addons": later(),
  "GET /api/pms/properties/:propertyId/manual-bookings/capabilities": later(),
  "POST /api/pms/properties/:propertyId/manual-bookings/preview": later(),
  "GET /api/pms/properties/:propertyId/messaging/direct-bookings": later(),
  "GET /api/pms/properties/:propertyId/messaging/quick-replies": later(),
  "POST /api/pms/properties/:propertyId/messaging/quick-replies": later(),
  "POST /api/pms/properties/:propertyId/messaging/quick-replies/:quickReplyId/archive": later(),
  "POST /api/pms/properties/:propertyId/messaging/quick-replies/:quickReplyId/preview": notForAi(
    "side_effect_read",
    "writes",
  ),
  "POST /api/pms/properties/:propertyId/messaging/quick-replies/:quickReplyId/update": later(),
  "GET /api/pms/properties/:propertyId/messaging/threads": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads": later(),
  "GET /api/pms/properties/:propertyId/messaging/threads/:threadId": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/assignment": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/assist":
    notForAi("ai_calling_ai"),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/done": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/follow-up": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/messages": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/notes": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/provider-actions/close":
    later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/provider-actions/no-reply-needed":
    later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/provider-actions/preapprove":
    later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/read": later(),
  "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/reopen": later(),
  "GET /api/pms/properties/:propertyId/messaging/unread-count": later(),
  "GET /api/pms/properties/:propertyId/module-activations": notForAi("owner_session"),
  "PATCH /api/pms/properties/:propertyId/module-activations/:moduleId": askLater(
    "product_tracks_and_modules",
  ),
  "GET /api/pms/properties/:propertyId/navigation-modules": later(),
  "PATCH /api/pms/properties/:propertyId/navigation-modules/:moduleId": askLater(
    "product_tracks_and_modules",
    "Feature Hub navigation switch",
  ),
  "GET /api/pms/properties/:propertyId/operating-calendar": later(),
  "PUT /api/pms/properties/:propertyId/operating-calendar": later(),
  "POST /api/pms/properties/:propertyId/operating-calendar/impact-preview": notForAi(
    "side_effect_read",
    "write-grade locks",
  ),
  "GET /api/pms/properties/:propertyId/operating-calendar/revisions/:calendarRevision":
    notForAi("no_caller"),
  "GET /api/pms/properties/:propertyId/payment-settings": later(),
  "GET /api/pms/properties/:propertyId/plan-limits": later(),
  "GET /api/pms/properties/:propertyId/pricing-source": later(),
  "PUT /api/pms/properties/:propertyId/pricing-source/currency": notForAi("owner_session"),
  "GET /api/pms/properties/:propertyId/pricing-source/currency-capabilities": later(),
  "PUT /api/pms/properties/:propertyId/pricing-source/currency-change": notForAi("owner_session"),
  "GET /api/pms/properties/:propertyId/pricing-source/currency-change/blockers":
    notForAi("owner_session"),
  "GET /api/pms/properties/:propertyId/pricing-source/recurring": notForAi(
    "no_caller",
    "recurring pricing",
  ),
  "GET /api/pms/properties/:propertyId/pricing-source/recurring-booking-evidence": notForAi(
    "no_caller",
    "recurring pricing",
  ),
  "GET /api/pms/properties/:propertyId/pricing-source/recurring/:sourceId": notForAi(
    "no_caller",
    "recurring pricing",
  ),
  "GET /api/pms/properties/:propertyId/pricing-v2": notForAi("side_effect_read", PRICING_LOCK),
  "GET /api/pms/properties/:propertyId/pricing-v2/card-readiness": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "POST /api/pms/properties/:propertyId/pricing-v2/charges": later(),
  "GET /api/pms/properties/:propertyId/pricing-v2/drafts/:draftId": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "PUT /api/pms/properties/:propertyId/pricing-v2/drafts/:draftId": later(),
  "GET /api/pms/properties/:propertyId/pricing-v2/drafts/:draftId/charge-review": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "GET /api/pms/properties/:propertyId/pricing-v2/drafts/:draftId/rooms/:roomTypeId/offers/:offerId/terms":
    notForAi("side_effect_read", PRICING_LOCK),
  "PUT /api/pms/properties/:propertyId/pricing-v2/drafts/:draftId/rooms/:roomTypeId/offers/:offerId/terms":
    later(),
  "GET /api/pms/properties/:propertyId/pricing-v2/guest-display-rate": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "GET /api/pms/properties/:propertyId/pricing-v2/not-selling": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "GET /api/pms/properties/:propertyId/pricing-v2/payment-methods": notForAi(
    "side_effect_read",
    PRICING_LOCK,
  ),
  "POST /api/pms/properties/:propertyId/pricing-v2/prepare": later(),
  "POST /api/pms/properties/:propertyId/pricing-v2/publish": later(),
  "GET /api/pms/properties/:propertyId/pricing-v2/rooms/:roomTypeId/offers/:offerId/terms":
    notForAi("side_effect_read", PRICING_LOCK),
  "PUT /api/pms/properties/:propertyId/pricing-v2/rooms/:roomTypeId/offers/:offerId/terms":
    notForAi("broken", "always answers 403; the draft terms route owns it"),
  "GET /api/pms/properties/:propertyId/profile": notForAi("broken", "always answers 500"),
  "PATCH /api/pms/properties/:propertyId/profile": notForAi("broken", "always answers 500"),
  "GET /api/pms/properties/:propertyId/reservations": later(),
  "GET /api/pms/properties/:propertyId/reservations/:bookingId/no-show-report": later(),
  "POST /api/pms/properties/:propertyId/reservations/:bookingId/no-show-report": later(),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/accept": later(),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests": notForAi(
    "data_deny_list",
    "full guest personal data",
  ),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests": later(),
  "DELETE /api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests/:guestId":
    later(),
  "PATCH /api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests/:guestId":
    later(),
  "PATCH /api/pms/properties/:propertyId/reservations/:guestBookingId/assignments": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/cancel": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/check-in": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/check-out": later(),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/mark-paid":
    notForAi("broken", "always answers 409"),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/paid":
    notForAi("broken", "always answers 409"),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/waive":
    later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/confirmation-email": later(),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/confirmation-email/:jobId":
    notForAi("data_deny_list", "platform job rows"),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/correct-prices":
    notForAi("no_caller"),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/correct-stays":
    notForAi("no_caller"),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-profiles": notForAi(
    "side_effect_read",
    "writes guest profiles",
  ),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/host-actions/apply": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/host-actions/card-refund-retry":
    later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/host-actions/preview": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/mark-paid": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/no-show": later(),
  "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/notes": later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/notes": later(),
  "DELETE /api/pms/properties/:propertyId/reservations/:guestBookingId/notes/:noteId": later(),
  "PATCH /api/pms/properties/:propertyId/reservations/:guestBookingId/notes/:noteId": later(),
  "PATCH /api/pms/properties/:propertyId/reservations/:guestBookingId/primary-guest/nationality":
    later(),
  "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/refund": notForAi(
    "no_caller",
    "Ask first after hardening (VAY-2560)",
  ),
  "PATCH /api/pms/properties/:propertyId/reservations/:guestBookingId/status": notForAi(
    "no_caller",
    "skips the check-in and check-out records",
  ),
  "GET /api/pms/properties/:propertyId/reviews": later(),
  "GET /api/pms/properties/:propertyId/reviews/:reviewId/reply": notForAi(
    "side_effect_read",
    "checks with Channex; VAY-2567 rank 2",
  ),
  "POST /api/pms/properties/:propertyId/reviews/:reviewId/reply": later(),
  "GET /api/pms/properties/:propertyId/room-blocks": later(),
  "POST /api/pms/properties/:propertyId/room-blocks": later(),
  "DELETE /api/pms/properties/:propertyId/room-blocks/:blockId": later(),
  "PATCH /api/pms/properties/:propertyId/room-blocks/:blockId": later(),
  "GET /api/pms/properties/:propertyId/room-publication-snapshot": later(),
  "GET /api/pms/properties/:propertyId/room-types": later(),
  "DELETE /api/pms/properties/:propertyId/room-types/:roomTypeId": later(),
  "GET /api/pms/properties/:propertyId/room-types/:roomTypeId": later(),
  "PATCH /api/pms/properties/:propertyId/room-types/:roomTypeId": later(),
  "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/amenities": later(),
  "POST /api/pms/properties/:propertyId/room-types/:roomTypeId/close": notForAi("no_caller"),
  "GET /api/pms/properties/:propertyId/room-types/:roomTypeId/closure-impact": notForAi(
    "side_effect_read",
    "write-grade locks; no caller",
  ),
  "POST /api/pms/properties/:propertyId/room-types/:roomTypeId/duplicate": later(),
  "GET /api/pms/properties/:propertyId/room-types/:roomTypeId/flexible-rate-plan":
    notForAi("no_caller"),
  "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/media": later(),
  "POST /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units": later(),
  "DELETE /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId":
    later(),
  "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId": later(),
  "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId/operational-label":
    later(),
  "GET /api/pms/properties/:propertyId/room-types/:roomTypeId/retirement-impact": later(),
  "PATCH /api/pms/properties/:propertyId/rooms/reorder": later(),
  "GET /api/pms/properties/:propertyId/same-day-booking": later(),
  "PUT /api/pms/properties/:propertyId/same-day-booking": later(),
  "GET /api/pms/setup/properties/:propertyId/room-type-bindings/:draftRoomId": later(),
  "GET /api/pms/setup/properties/:propertyId/room-types": later(),
  "POST /api/pms/setup/properties/:propertyId/room-types": later(),
  "DELETE /api/pms/setup/properties/:propertyId/room-types/:roomTypeId": later(),
  "GET /api/pms/setup/properties/:propertyId/room-types/:roomTypeId": later(),
  "PUT /api/pms/setup/properties/:propertyId/room-types/:roomTypeId": later(),
  "GET /api/pms/setup/properties/:propertyId/room-types/:roomTypeId/capacity": later(),
  "PUT /api/pms/setup/properties/:propertyId/room-types/:roomTypeId/physical-units/reconcile":
    later(),
  "GET /api/pms/setup/properties/:propertyId/room-types/:roomTypeId/units": later(),
  "POST /api/support": later(),
};

/** The class of a route that is not an action's, or undefined when nobody sorted it. */
export function classifyRoute(route: string): RouteClass | undefined {
  // The never list wins over everything: no entry or rule here can take a route off it.
  const never = neverArea(route);
  if (never) return { class: "never", ...never };
  const exact = (ROUTE_CLASSES as Record<string, RouteClass | undefined>)[route];
  if (exact) return exact;
  return ROUTE_CLASS_RULES.find((rule) => rule.match.test(route))?.routeClass;
}

/** All routes of the generated route list with their class (undefined = an action or unsorted). */
export function classifiedRoutes(): { route: RouteKey; routeClass: RouteClass | undefined }[] {
  return ROUTE_MANIFEST.map((route) => ({ route, routeClass: classifyRoute(route) }));
}
