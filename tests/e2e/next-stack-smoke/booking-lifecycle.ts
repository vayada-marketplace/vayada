import { expect, type APIRequestContext } from "@playwright/test";

import {
  NEXT_STACK_ORIGINS,
  arrayField,
  futureStay,
  publicApi,
  record,
  stringField,
  type SmokeEnvironment,
} from "./support";

export type Stay = ReturnType<typeof futureStay>;
export type BookingResource = {
  bookingId: string;
  email: string;
  mode: "instant" | "request";
  resolved: boolean;
  slug: string;
};
/** One room's row of the legacy public offers read model: the availability the smoke watches. */
export type Offer = Record<string, unknown> & {
  availableRooms: number;
  roomTypeId: string;
};
/** The pricing offer guests book: the key the room card hands to /book and the quote takes. */
export type PricingOffer = { currency: string; publicOfferKey: string; roomTypeId: string };
/** The price a guest sees and accepts (public-booking-quote.v1), with its lines summed. */
export type GuestQuote = {
  acceptanceMode: "instant" | "request";
  currency: string;
  discountMinor: bigint;
  expiresAt: string;
  lines: { amountMinor: string; kind: string; selectionId: string | null }[];
  quoteId: string;
  roomMinor: bigint;
  totalMinor: string;
};

/** Whether a request-mode booking went through: online booking requests are an operator switch
 * (REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED), off in production on 2026-10-27. */
export type QuoteLifecycleOutcome = "booked" | "requests_unavailable";

const GUEST = { firstName: "Taylor", lastName: "Smoke", phone: "+49305550104", countryCode: "DE" };
const ROOM_SELECTION_ID = "room-1";

/** The one offer of the smoke's room type from the pricing catalogue booking-web reads. */
export async function findPricingOffer(
  request: APIRequestContext,
  slug: string,
  roomTypeId: string,
): Promise<PricingOffer> {
  const catalog = await publicApi(request).json<Record<string, unknown>>(
    "GET",
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/pricing-offers`,
  );
  expect(catalog.version).toBe("public-pricing-offers.v1");
  const room = arrayField(catalog, "rooms")
    .map(record)
    .find((candidate) => candidate.roomTypeId === roomTypeId);
  if (!room) throw new Error(`Pricing offers do not list room type ${roomTypeId}.`);
  const offers = arrayField(room, "offers").map(record);
  // The smoke publishes one flexible rate plan, so the room has exactly one offer.
  expect(offers).toHaveLength(1);
  const offer = offers[0]!;
  return {
    currency: stringField(offer, "currency"),
    publicOfferKey: stringField(offer, "publicOfferKey"),
    roomTypeId,
  };
}

/** The quote request booking-web sends for two adults in this offer, paid at the property. */
export function guestQuoteRequest(
  offer: PricingOffer,
  stay: Stay,
  promoCode: string | null = null,
): Record<string, unknown> {
  return {
    version: "public-booking-quote-request.v1",
    paymentMethod: "pay_at_property",
    selection: {
      version: "public-pricing-selection.v1",
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      currency: offer.currency,
      addons: [],
      promoCode,
      rooms: [
        {
          selectionId: ROOM_SELECTION_ID,
          publicOfferKey: offer.publicOfferKey,
          guests: { adults: 2, childAgesAtCheckIn: [] },
        },
      ],
    },
  };
}

export async function issueGuestQuote(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  slug: string,
  stay: Stay,
  offer: PricingOffer,
  key: string,
  promoCode: string | null = null,
): Promise<GuestQuote> {
  const body = await publicApi(request).json<Record<string, unknown>>(
    "POST",
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/quote`,
    guestQuoteRequest(offer, stay, promoCode),
    { "Idempotency-Key": `next-smoke:${environment.runId}:${key}:quote` },
  );
  return parseGuestQuote(body);
}

export function parseGuestQuote(body: Record<string, unknown>): GuestQuote {
  expect(body.version).toBe("public-booking-quote.v1");
  const lines = arrayField(body, "lines")
    .map(record)
    .map((line) => ({
      amountMinor: stringField(line, "amountMinor"),
      kind: stringField(line, "kind"),
      selectionId: typeof line.selectionId === "string" ? line.selectionId : null,
    }));
  const sum = (kinds: string[]) =>
    lines
      .filter((line) => kinds.includes(line.kind))
      .reduce((total, line) => total + BigInt(line.amountMinor), BigInt(0));
  const acceptanceMode = stringField(body, "acceptanceMode");
  if (acceptanceMode !== "instant" && acceptanceMode !== "request") {
    throw new Error(`Guest quote has an unexpected acceptance mode: ${acceptanceMode}`);
  }
  return {
    acceptanceMode,
    currency: stringField(body, "currency"),
    discountMinor: sum(["discount"]),
    expiresAt: stringField(body, "expiresAt"),
    lines,
    quoteId: stringField(body, "quoteId"),
    roomMinor: sum(["room", "meal"]),
    totalMinor: stringField(body, "totalMinor"),
  };
}

/** A quote amount as booking-web's summary prints it (en-GB, no forced decimals). The smoke
 * hotel sells in EUR, a two-decimal currency. */
export function guestMoney(minor: string | bigint, currency: string): string {
  if (currency !== "EUR") throw new Error(`guestMoney expects EUR, received ${currency}.`);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
  }).format(Number(minor) / 100);
}

/**
 * Books the smoke stay the way booking-web does since the new pricing: quote, guest disclosure,
 * acceptance; then withdraws or cancels it and waits for the room to come back.
 */
export async function runQuoteLifecycle(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  slug: string,
  stay: Stay,
  offer: PricingOffer,
  availableRooms: number,
  mode: "instant" | "request",
  bookings: BookingResource[],
  checkout?: {
    key: string;
    promoCode: string;
    assertQuote: (quote: GuestQuote) => void;
  },
): Promise<QuoteLifecycleOutcome> {
  const api = publicApi(request);
  const key = checkout?.key ?? mode;
  const guestEmail = `qa-next-guest-${environment.runId}@${environment.emailDomain}`;
  const hotelPath = `/api/booking-web/hotels/${encodeURIComponent(slug)}`;
  const quote = await issueGuestQuote(
    request,
    environment,
    slug,
    stay,
    offer,
    key,
    checkout?.promoCode ?? null,
  );
  expect(quote.acceptanceMode).toBe(mode);
  checkout?.assertQuote(quote);
  const disclosure = await api.json<Record<string, unknown>>(
    "GET",
    `${hotelPath}/bookings/quotes/${encodeURIComponent(quote.quoteId)}/guest-disclosure`,
  );
  expect(disclosure.version).toBe("public-quote-guest-disclosure.v1");
  const requestId = `next-smoke:${environment.runId}:${key}:accept`;
  const response = await request.post(
    `${NEXT_STACK_ORIGINS.api}${hotelPath}/bookings/quotes/${encodeURIComponent(quote.quoteId)}/accept`,
    {
      headers: { "Idempotency-Key": requestId },
      data: {
        version: "booking-quote-acceptance.v1",
        requestId,
        quoteId: quote.quoteId,
        acceptance: {
          accepted: true,
          quoteEvidenceId: stringField(disclosure, "quoteEvidenceId"),
          guestPolicyEvidenceId: stringField(disclosure, "guestPolicyEvidenceId"),
        },
        guest: { ...GUEST, email: guestEmail, arrivalTime: null, specialRequests: null },
      },
    },
  );
  const accepted = record(await response.json());
  if (
    mode === "request" &&
    response.status() === 404 &&
    accepted.code === "REQUEST_ACCEPTANCE_UNAVAILABLE"
  ) {
    // The hotel confirms each booking, but online requests are switched off: the API refuses
    // and stores nothing, which is what booking-web tells the guest.
    return "requests_unavailable";
  }
  expect(response.ok(), JSON.stringify(accepted)).toBe(true);
  expect(accepted.kind).toBe(mode === "request" ? "requested" : "accepted");
  const resource: BookingResource = {
    bookingId: stringField(accepted, "bookingId"),
    email: guestEmail,
    mode,
    resolved: false,
    slug,
  };
  bookings.push(resource);
  stringField(accepted, "bookingReference");
  await waitForAvailability(request, slug, stay, availableRooms - 1);
  if (mode === "request") {
    await api.json("POST", `${hotelPath}/bookings/${resource.bookingId}/withdraw`, { guestEmail });
  } else {
    await api.json("POST", `${hotelPath}/bookings/${resource.bookingId}/cancel-preview`, {
      guestEmail,
    });
    await api.json("POST", `${hotelPath}/bookings/${resource.bookingId}/cancel`, { guestEmail });
  }
  resource.resolved = true;
  return "booked";
}

export async function waitForOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
  availableRooms: number,
): Promise<Offer> {
  let latest: Offer | null = null;
  await expect
    .poll(
      async () => {
        latest = await firstOffer(request, slug, stay);
        return latest?.availableRooms ?? 0;
      },
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(availableRooms);
  return latest!;
}

export async function waitForNoPublicOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
): Promise<void> {
  await expect
    .poll(async () => (await firstOffer(request, slug, stay)) === null, {
      timeout: 45_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);
}

async function waitForAvailability(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
  availableRooms: number,
): Promise<void> {
  await expect
    .poll(async () => (await firstOffer(request, slug, stay))?.availableRooms ?? 0, {
      timeout: 45_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(availableRooms);
}

async function firstOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
): Promise<Offer | null> {
  const query = new URLSearchParams({
    check_in: stay.checkIn,
    check_out: stay.checkOut,
    rooms: "1",
    adults: "2",
    children: "0",
    currency: "EUR",
    locale: "en",
  });
  const response = await request.get(
    `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${encodeURIComponent(slug)}/offers?${query}`,
  );
  if (response.status() === 404 || response.status() === 409) return null;
  if (!response.ok()) throw new Error(`Public offers returned ${response.status()}.`);
  const body = record(await response.json());
  if (body.quote == null) return null;
  const offers = arrayField(record(body.quote), "offers");
  if (!offers.length) return null;
  const offer = record(offers[0]);
  const availableRooms = Number(offer.availableRooms);
  if (!Number.isInteger(availableRooms) || availableRooms < 0) {
    throw new Error("Public offer has invalid availableRooms.");
  }
  return {
    ...offer,
    availableRooms,
    roomTypeId: stringField(offer, "roomTypeId"),
  };
}
