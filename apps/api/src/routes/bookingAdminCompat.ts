import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type BookingAdminCompatRoutesOptions = {
  allowedOrigins?: string[];
};

type HotelSummary = {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
};

type PropertySettings = {
  id?: string;
  slug: string;
  property_name: string;
  reservation_email: string;
  phone_number: string;
  whatsapp_number: string;
  address: string;
  city?: string;
  country?: string;
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  default_currency: string;
  default_language?: string;
  supported_currencies: string[];
  supported_languages: string[];
  check_in_time: string;
  check_out_time: string;
  check_in_from?: string;
  check_in_until?: string;
  check_out_from?: string;
  check_out_until?: string;
  pay_at_property_enabled: boolean;
  pay_at_hotel_methods: string[];
  online_card_payment?: boolean;
  bank_transfer?: boolean;
  paypal_enabled?: boolean;
  paypal_email?: string;
  paypal_payment_window_hours?: number;
  special_requests_enabled?: boolean;
  arrival_time_enabled?: boolean;
  guest_count_enabled?: boolean;
  refer_a_guest_enabled?: boolean;
  map_view_enabled?: boolean;
  free_cancellation_days: number;
  email_notifications: boolean;
  new_booking_alerts: boolean;
  payment_alerts: boolean;
  ota_booking_alerts: boolean;
  terms_text?: string;
  cancellation_policy_text?: string;
  show_room_detail_map?: boolean;
  points_of_interest?: unknown[];
};

type ModuleActivation = {
  moduleId: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
};

export async function registerBookingAdminCompatRoutes(
  app: FastifyInstance,
  options: BookingAdminCompatRoutesOptions = {},
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    writeCompatCorsHeaders(request, reply, options.allowedOrigins ?? []);
  });

  app.options("/settings/setup-status", async (_request, reply) => reply.code(204).send());
  app.options("/settings/property", async (_request, reply) => reply.code(204).send());
  app.options("/hotels", async (_request, reply) => reply.code(204).send());
  app.options("/dashboard/stats", async (_request, reply) => reply.code(204).send());
  app.options("/dashboard/bookings-by-source", async (_request, reply) => reply.code(204).send());
  app.options("/dashboard/conversion-funnel", async (_request, reply) => reply.code(204).send());
  app.options("/dashboard/sparklines", async (_request, reply) => reply.code(204).send());
  app.options("/dashboard/page-views", async (_request, reply) => reply.code(204).send());
  app.options("/module-activations", async (_request, reply) => reply.code(204).send());
  app.options("/module-activations/:moduleId", async (_request, reply) => reply.code(204).send());
  app.options("/settings/custom-domain/status", async (_request, reply) => reply.code(204).send());
  app.options("/settings/custom-domain", async (_request, reply) => reply.code(204).send());
  app.options("/addons", async (_request, reply) => reply.code(204).send());
  app.options("/addons/:addonId", async (_request, reply) => reply.code(204).send());
  app.options("/promo-codes", async (_request, reply) => reply.code(204).send());
  app.options("/promo-codes/:promoCodeId", async (_request, reply) => reply.code(204).send());

  app.get("/settings/setup-status", async (request) => {
    const hotels = getLinkedBookingHotels(request);
    return {
      setup_complete: hotels.length > 0,
      missing_fields: [],
      prefill_data: null,
    };
  });

  app.get("/hotels", async (request) => getLinkedBookingHotels(request));

  app.get("/settings/property", async (request) => {
    const [hotel] = getLinkedBookingHotels(request);
    return toPropertySettings(hotel);
  });

  app.get("/dashboard/stats", async () => ({
    revenue: 0,
    revenue_previous: 0,
    bookings: 0,
    bookings_previous: 0,
    avg_nightly_rate: 0,
    avg_nightly_rate_previous: 0,
    page_views: 0,
    page_views_previous: 0,
    next_arrival: null,
    live_since: null,
  }));

  app.get("/dashboard/bookings-by-source", async () => ({
    total_revenue: 0,
    sources: [],
  }));

  app.get("/dashboard/conversion-funnel", async () => ({
    steps: [],
  }));

  app.get("/dashboard/sparklines", async () => ({
    revenue: [],
    bookings: [],
    avg_rate: [],
    page_views: [],
  }));

  app.get("/dashboard/page-views", async () => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      window_start: today,
      window_end: today,
      previous_window_start: today,
      previous_window_end: today,
      buckets: [],
      previous_buckets: [],
      total: 0,
      previous_total: 0,
      has_previous_data: false,
    };
  });

  app.get("/module-activations", async (request) => {
    const [hotel] = getLinkedBookingHotels(request);
    return {
      hotelId: hotel?.id ?? "booking_hotel",
      activeModules: [],
      activations: [],
    };
  });

  app.patch<{ Params: { moduleId: string }; Body: { isActive?: boolean } }>(
    "/module-activations/:moduleId",
    async (request) => toModuleActivation(request.params.moduleId, request.body?.isActive === true),
  );

  app.get("/settings/custom-domain/status", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return {
      configured: false,
      verification_errors: [],
    };
  });

  app.post("/settings/custom-domain", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Custom domain writes are not available on next-api yet.",
    );
  });

  app.delete("/settings/custom-domain", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Custom domain writes are not available on next-api yet.",
    );
  });

  app.get("/addons", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return [];
  });

  app.post("/addons", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking add-on item management is not available on next-api yet.",
    );
  });

  app.patch("/addons/:addonId", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking add-on item management is not available on next-api yet.",
    );
  });

  app.delete("/addons/:addonId", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking add-on item management is not available on next-api yet.",
    );
  });

  app.get("/promo-codes", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return [];
  });

  app.post("/promo-codes", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking promo-code management is not available on next-api yet.",
    );
  });

  app.patch("/promo-codes/:promoCodeId", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking promo-code management is not available on next-api yet.",
    );
  });

  app.delete("/promo-codes/:promoCodeId", async (request, reply) => {
    if (!requireBookingAdminCompatHotelAccess(request, reply)) return reply;
    return sendCompatNotImplemented(
      reply,
      "Booking promo-code management is not available on next-api yet.",
    );
  });

  app.post("/hotels", async (_request, reply) =>
    reply.code(501).send({
      detail: "Booking setup creation is not available on next-api yet.",
    }),
  );
}

function sendCompatNotImplemented(reply: FastifyReply, detail: string) {
  return reply.code(501).send({ detail });
}

function requireBookingAdminCompatHotelAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): HotelSummary[] | null {
  const hotels = getLinkedBookingHotels(request);
  if (hotels.length > 0) return hotels;
  reply.code(403).send({ detail: "Missing booking hotel access." });
  return null;
}

function getLinkedBookingHotels(request: FastifyRequest): HotelSummary[] {
  const context = requireAuthContext(request);
  return context.linkedResources
    .filter(
      (link) =>
        link.status === "active" &&
        link.product === "booking" &&
        link.resourceType === "booking_hotel",
    )
    .map((link) => ({
      id: link.resourceId,
      name: link.resourceId,
      slug: link.resourceId,
      location: "",
      country: "",
    }));
}

function toPropertySettings(hotel: HotelSummary | undefined): PropertySettings {
  const fallbackId = "booking_hotel";
  const id = hotel?.id ?? fallbackId;
  const name = hotel?.name ?? id;
  const slug = hotel?.slug ?? id;
  return {
    id,
    slug,
    property_name: name,
    reservation_email: "",
    phone_number: "",
    whatsapp_number: "",
    address: "",
    city: hotel?.location ?? "",
    country: hotel?.country ?? "",
    instagram: "",
    facebook: "",
    tiktok: "",
    youtube: "",
    default_currency: "EUR",
    default_language: "en",
    supported_currencies: ["EUR"],
    supported_languages: ["en"],
    check_in_time: "15:00",
    check_out_time: "11:00",
    check_in_from: "15:00",
    check_in_until: "22:00",
    check_out_from: "07:00",
    check_out_until: "11:00",
    pay_at_property_enabled: true,
    pay_at_hotel_methods: [],
    online_card_payment: false,
    bank_transfer: false,
    paypal_enabled: false,
    paypal_email: "",
    paypal_payment_window_hours: 24,
    special_requests_enabled: true,
    arrival_time_enabled: true,
    guest_count_enabled: true,
    refer_a_guest_enabled: false,
    map_view_enabled: false,
    free_cancellation_days: 7,
    email_notifications: true,
    new_booking_alerts: true,
    payment_alerts: true,
    ota_booking_alerts: true,
    terms_text: "",
    cancellation_policy_text: "",
    show_room_detail_map: false,
    points_of_interest: [],
  };
}

function toModuleActivation(moduleId: string, isActive: boolean): ModuleActivation {
  const now = new Date().toISOString();
  return {
    moduleId,
    isActive,
    activatedAt: isActive ? now : null,
    deactivatedAt: isActive ? null : now,
    updatedAt: now,
  };
}

function writeCompatCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): void {
  const origin = request.headers.origin;
  reply.header("Vary", "Origin");
  if (!origin || !allowedOrigins.includes(origin)) return;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Hotel-Id")
    .header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}
