// Every next-api route is sorted for the AI exactly once (VAY-2507; decisions of 2026-11-20).
import { describe, expect, it } from "vitest";

import { AI_ACTIONS } from "./actions/registry.js";
import { NEVER_ROUTES, NEVER_RULES, neverArea } from "./neverList.js";
import {
  classifyRoute,
  ROUTE_CLASS_RULES,
  ROUTE_CLASSES,
  type AskFirstLaterArea,
  type NeverArea,
  type RouteClass,
} from "./routeClassification.js";
import { ROUTE_MANIFEST } from "./routeManifest.generated.js";

const actionRoutes = new Set<string>(AI_ACTIONS.map((action) => action.route));
const exactEntries = Object.keys(ROUTE_CLASSES);

describe("AI route classification (VAY-2507)", () => {
  it("sorts every route: an action's, or exactly one class", () => {
    const unsorted = ROUTE_MANIFEST.filter(
      (route) => !actionRoutes.has(route) && !classifyRoute(route),
    );
    expect(
      unsorted,
      "New routes: sort them in src/ai/routeClassification.ts (later() for an ordinary hotel route)",
    ).toEqual([]);
  });

  it("never sorts an action's route (the registry also refuses at load)", () => {
    expect([...actionRoutes].filter((route) => classifyRoute(route))).toEqual([]);
  });

  it("has no entry for a route that no longer exists, and no rule that sorts nothing", () => {
    const manifest = new Set<string>(ROUTE_MANIFEST);
    expect(exactEntries.filter((route) => !manifest.has(route))).toEqual([]);
    expect(Object.keys(NEVER_ROUTES).filter((route) => !manifest.has(route))).toEqual([]);
    const free = ROUTE_MANIFEST.filter((route) => !(route in ROUTE_CLASSES) && !neverArea(route));
    expect(
      ROUTE_CLASS_RULES.filter((rule) => !free.some((route) => rule.match.test(route))),
    ).toEqual([]);
    expect(NEVER_RULES.filter((rule) => !ROUTE_MANIFEST.some((r) => rule.match.test(r)))).toEqual(
      [],
    );
    // No route falls under two rules: the order of the rules never decides.
    const twice = free.filter(
      (route) => ROUTE_CLASS_RULES.filter((rule) => rule.match.test(route)).length > 1,
    );
    expect(twice).toEqual([]);
  });

  it("puts nothing on top of the never list", () => {
    // Every never route is sorted never, and no classification entry or rule even mentions one.
    const neverRoutes = ROUTE_MANIFEST.filter((route) => neverArea(route));
    expect(neverRoutes.filter((route) => classifyRoute(route)?.class !== "never")).toEqual([]);
    expect(neverRoutes.filter((route) => route in ROUTE_CLASSES)).toEqual([]);
    expect(
      neverRoutes.filter((route) => ROUTE_CLASS_RULES.some((rule) => rule.match.test(route))),
    ).toEqual([]);
  });

  it("only ever grows the never list (shortening it needs Flamur's decision)", () => {
    // Raise these floors when routes are added to the never list; lowering them is a decision.
    expect(Object.keys(NEVER_ROUTES).length).toBeGreaterThanOrEqual(52);
    expect(NEVER_RULES.length).toBeGreaterThanOrEqual(5);
    expect(ROUTE_MANIFEST.filter((route) => neverArea(route)).length).toBeGreaterThanOrEqual(123);
  });

  // Flamur's never list (2026-11-20): one real route per area, so a renamed or reclassified route
  // in an area fails here.
  const NEVER: Record<NeverArea, string[]> = {
    ai_connections: ["GET /api/ai/activity"],
    bank_accounts_and_payouts: [
      "PUT /api/finance/properties/:propertyId/payout-destination",
      "GET /api/finance/properties/:propertyId/payout-destination",
      "PUT /api/finance/properties/:propertyId/bank-transfer-destination",
      "POST /api/finance/properties/:propertyId/payouts/:payoutId/dispatch",
      "POST /api/finance/properties/:propertyId/provider-accounts/stripe",
    ],
    team_members_and_permissions: [
      "POST /api/identity/staff/invitations",
      "PATCH /api/identity/staff/members/:membershipId",
      "GET /api/identity/staff/members",
      "POST /auth/admin-transfer/start",
      "POST /api/hotel-setup/hotel-account-invites/redeem",
    ],
    property_deletion: ["POST /api/hotel-setup/properties/:propertyId/delete"],
    login_and_security: ["POST /auth/password/login", "GET /auth/session"],
    legal_terms: [
      "POST /api/hotel-account/agreements/accept",
      "PUT /api/pms/properties/:propertyId/mandatory-charge-confirmation",
    ],
    billing_and_plan: [
      "GET /api/finance/properties/:propertyId/billing",
      "POST /api/finance/properties/:propertyId/select-commission",
      "POST /api/hotel-setup/properties/:propertyId/first-run",
    ],
    bulk_exports: ["POST /api/finance/properties/:propertyId/financials/exports"],
    privacy_export_and_delete: [
      "POST /api/identity/gdpr/export-request",
      "POST /api/identity/gdpr/delete-request",
    ],
    guest_id_documents: [
      "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-registrations",
    ],
    partner_app_approvals: ["POST /api/booking/partner-authorizations"],
    platform_and_staff: [
      "GET /api/platform/admin/bookings",
      "GET /api/identity/admin/users",
      "GET /api/finance/platform/vayada-payment/payouts",
    ],
  };

  it.each(Object.entries(NEVER))("keeps %s on the never list", (area, routes) => {
    for (const route of routes) {
      expect(ROUTE_MANIFEST as readonly string[], route).toContain(route);
      expect(classifyRoute(route), route).toMatchObject({ class: "never", area });
    }
  });

  // Rare setup tasks: no action now; each becomes Ask first when its screen does.
  const ASK_FIRST_LATER: Record<AskFirstLaterArea, string> = {
    custom_domain: "PUT /api/booking/hotels/:hotelId/custom-domain",
    channel_connection: "POST /api/pms/properties/:propertyId/channex/commands",
    product_tracks_and_modules: "PUT /api/hotel-setup/tracks",
    payment_settings_and_windows: "PUT /api/finance/properties/:propertyId/payment-windows",
    data_retention: "PUT /api/pms/properties/:propertyId/guest-data-settings",
    airbnb_guest_review: "POST /api/pms/properties/:propertyId/guest-reviews/:reviewId",
  };

  it.each(Object.entries(ASK_FIRST_LATER))("keeps %s for Ask first later", (area, route) => {
    expect(ROUTE_MANIFEST as readonly string[]).toContain(route);
    expect(classifyRoute(route)).toMatchObject({ class: "ask_first_later", area });
  });

  // VAY-2567 ranks 2-3 and design note §3.2: reads with side effects, routes returning data no
  // projection may receive, broken and side-door routes.
  const NOT_FOR_AI: [string, RouteClass["class"], string][] = [
    ["GET /api/booking/hotels/:hotelId/reservations", "not_for_ai", "data_deny_list"],
    [
      "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/additional-guests",
      "not_for_ai",
      "data_deny_list",
    ],
    [
      "GET /api/pms/properties/:propertyId/reviews/:reviewId/reply",
      "not_for_ai",
      "side_effect_read",
    ],
    ["GET /api/pms/properties/:propertyId/channex/offer-preview", "not_for_ai", "side_effect_read"],
    [
      "GET /api/pms/properties/:propertyId/reservations/:guestBookingId/guest-profiles",
      "not_for_ai",
      "side_effect_read",
    ],
    ["GET /api/pms/properties", "not_for_ai", "broken"],
    ["POST /api/booking/hotels/:hotelId/public-bookability", "not_for_ai", "duplicate"],
    ["GET /api/pms/properties/:propertyId/module-activations", "not_for_ai", "owner_session"],
  ];

  it.each(NOT_FOR_AI)("keeps %s away from the AI", (route, routeClass, reason) => {
    expect(ROUTE_MANIFEST as readonly string[]).toContain(route);
    expect(classifyRoute(route)).toMatchObject({ class: routeClass, reason });
  });

  it("reports how much of the website the AI can do", () => {
    const hotelRoutes = ROUTE_MANIFEST.filter(
      (route) => actionRoutes.has(route) || classifyRoute(route)?.class === "later",
    );
    const coverage = `${actionRoutes.size} of ${hotelRoutes.length} hotel routes are AI actions`;
    console.info(`AI action coverage: ${coverage}`);
    expect(actionRoutes.size).toBeGreaterThan(0);
  });
});
