import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

type LegacyHotel = {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  location?: unknown;
  country?: unknown;
  currency?: unknown;
  hero_image?: unknown;
  images?: unknown;
  amenities?: unknown;
  check_in_time?: unknown;
  check_out_time?: unknown;
  timezone?: unknown;
  default_language?: unknown;
  supported_languages?: unknown;
  supported_currencies?: unknown;
  instant_book?: unknown;
  online_card_payment?: unknown;
  pay_at_property_enabled?: unknown;
  free_cancellation_days?: unknown;
  terms_text?: unknown;
  cancellation_policy_text?: unknown;
};

type LegacyRoom = {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  maxOccupancy?: unknown;
  maxAdults?: unknown;
  maxChildren?: unknown;
  baseRate?: unknown;
  currency?: unknown;
  remainingRooms?: unknown;
  flexibleRateEnabled?: unknown;
  cancellationPolicy?: unknown;
  ratePaymentMethods?: unknown;
  rateDepositSettings?: unknown;
};

type RoomSnapshot = {
  stayDate: string;
  room: LegacyRoom;
};

export type BookingPublicBookabilityBackfillResult = {
  kind: "booking_public_bookability_backfill";
  slug: string;
  apply: boolean;
  startDate: string;
  endDate: string;
  propertyId: string;
  rooms: number;
  offerSnapshots: number;
};

export async function runBookingPublicBookabilityBackfill(config: {
  connectionString: string;
  slug: string;
  apply: boolean;
  days?: number;
  now?: Date;
  bookingApiUrl?: string;
  pmsApiUrl?: string;
  bookingHostBase?: string;
}): Promise<BookingPublicBookabilityBackfillResult> {
  const slug = normalizeSlug(config.slug);
  const days = clampDays(config.days ?? 75);
  const now = config.now ?? new Date();
  const startDate = firstDayOfUtcMonth(now);
  const dates = dateRange(startDate, addDays(startDate, days));
  const bookingApiUrl = config.bookingApiUrl ?? "https://booking-api.vayada.com";
  const pmsApiUrl = config.pmsApiUrl ?? "https://pms-api.vayada.com";

  const hotel = await fetchJson<LegacyHotel>(`${bookingApiUrl}/api/hotels/${slug}`);
  const propertyId = requiredUuid(hotel.id, "legacy hotel id");
  const snapshots: RoomSnapshot[] = [];
  const seenRoomIds = new Set<string>();

  // ponytail: public HTTP snapshot is enough for the pilot; use source DB ETL when batching cohorts.
  for (const stayDate of dates) {
    const rooms = await fetchJson<LegacyRoom[]>(
      `${pmsApiUrl}/api/hotels/${slug}/rooms?check_in=${stayDate}&check_out=${addDays(
        stayDate,
        1,
      )}&adults=1&children=0`,
    );
    if (!Array.isArray(rooms)) {
      throw new Error(`PMS rooms response for ${stayDate} was not an array`);
    }
    for (const room of rooms) {
      snapshots.push({ stayDate, room });
      seenRoomIds.add(requiredUuid(room.id, "legacy room type id"));
    }
  }

  if (snapshots.length === 0) {
    throw new Error(`No public PMS room snapshots found for ${slug}`);
  }

  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertTargetRows(client, {
      hotel,
      propertyId,
      slug,
      snapshots,
      generatedAt: now.toISOString(),
      bookingHostBase: config.bookingHostBase ?? "https://next-booking.vayada.com",
    });
    await client.query(config.apply ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  return {
    kind: "booking_public_bookability_backfill",
    slug,
    apply: config.apply,
    startDate,
    endDate: addDays(startDate, days),
    propertyId,
    rooms: seenRoomIds.size,
    offerSnapshots: snapshots.length,
  };
}

async function upsertTargetRows(
  client: pg.PoolClient,
  input: {
    hotel: LegacyHotel;
    propertyId: string;
    slug: string;
    snapshots: RoomSnapshot[];
    generatedAt: string;
    bookingHostBase: string;
  },
): Promise<void> {
  const defaultLocale = stringValue(input.hotel.default_language) ?? "en";
  const defaultCurrency =
    stringValue(input.hotel.currency) ?? stringValue(input.snapshots[0]?.room.currency) ?? "USD";
  const supportedLocales = withFirst(arrayValue(input.hotel.supported_languages), defaultLocale);
  const supportedCurrencies = withFirst(
    arrayValue(input.hotel.supported_currencies),
    defaultCurrency,
  );
  const timezone = normalizeTimezone(stringValue(input.hotel.timezone));
  const name = stringValue(input.hotel.name) ?? input.slug;
  const bookingBaseUrl = bookingBaseUrlFor(input.slug, input.bookingHostBase);
  const canonicalUrl = `${bookingBaseUrl}/${defaultLocale}`;
  const media = mediaFrom(input.hotel, name);
  const amenities = arrayValue(input.hotel.amenities);
  const policy = publicPolicy(input.hotel, bookingBaseUrl, defaultLocale);
  const freshness = {
    booking: { status: "fresh", generatedAt: input.generatedAt },
    pms: { status: "fresh", generatedAt: input.generatedAt },
    distribution: { status: "fresh", generatedAt: input.generatedAt },
  };

  await client.query(
    `INSERT INTO hotel_catalog.properties
       (id, public_id, display_name, property_type, category, default_locale, supported_locales, profile_status, completeness_reasons)
     VALUES ($1, $2, $3, 'hotel', 'hotel', $4, $5, 'complete', ARRAY[]::text[])
     ON CONFLICT (id) DO UPDATE SET
       public_id = EXCLUDED.public_id,
       display_name = EXCLUDED.display_name,
       default_locale = EXCLUDED.default_locale,
       supported_locales = EXCLUDED.supported_locales,
       profile_status = EXCLUDED.profile_status,
       updated_at = now()`,
    [input.propertyId, input.propertyId, name, defaultLocale, supportedLocales],
  );

  const slugConflict = await client.query<{ property_id: string; purpose: string; status: string }>(
    `SELECT property_id::text, purpose, status
     FROM hotel_catalog.property_slugs
     WHERE slug = $1 AND locale IS NULL
     LIMIT 1`,
    [input.slug],
  );
  if (slugConflict.rows[0] && slugConflict.rows[0].property_id !== input.propertyId) {
    throw new Error(`Slug ${input.slug} already belongs to ${slugConflict.rows[0].property_id}`);
  }
  if (
    slugConflict.rows[0] &&
    (slugConflict.rows[0].purpose !== "canonical" || slugConflict.rows[0].status !== "active")
  ) {
    throw new Error(`Slug ${input.slug} exists but is not an active canonical slug`);
  }
  const activeCanonicalConflict = await client.query<{ slug: string }>(
    `SELECT slug
     FROM hotel_catalog.property_slugs
     WHERE property_id = $1
       AND purpose = 'canonical'
       AND status = 'active'
       AND (slug <> $2 OR locale IS NOT NULL)
     LIMIT 1`,
    [input.propertyId, input.slug],
  );
  if (activeCanonicalConflict.rows[0]) {
    throw new Error(
      `Property ${input.propertyId} already has active canonical slug ${activeCanonicalConflict.rows[0].slug}`,
    );
  }
  await client.query(
    `INSERT INTO hotel_catalog.property_slugs (property_id, slug, locale, purpose, status)
     VALUES ($1, $2, NULL, 'canonical', 'active')
     ON CONFLICT DO NOTHING`,
    [input.propertyId, input.slug],
  );

  await client.query(
    `INSERT INTO hotel_catalog.property_public_profile_read_model
       (property_id, public_id, display_name, canonical_slug, default_locale, supported_locales,
        profile_status, completeness_reasons, location, descriptions, media, amenities,
        public_policy, source_freshness, projected_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'complete', ARRAY[]::text[], $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (property_id) DO UPDATE SET
       public_id = EXCLUDED.public_id,
       display_name = EXCLUDED.display_name,
       canonical_slug = EXCLUDED.canonical_slug,
       default_locale = EXCLUDED.default_locale,
       supported_locales = EXCLUDED.supported_locales,
       profile_status = EXCLUDED.profile_status,
       location = EXCLUDED.location,
       descriptions = EXCLUDED.descriptions,
       media = EXCLUDED.media,
       amenities = EXCLUDED.amenities,
       public_policy = EXCLUDED.public_policy,
       source_freshness = EXCLUDED.source_freshness,
       projected_at = EXCLUDED.projected_at`,
    [
      input.propertyId,
      input.propertyId,
      name,
      input.slug,
      defaultLocale,
      supportedLocales,
      JSON.stringify({
        country: stringValue(input.hotel.country) ?? "",
        city: stringValue(input.hotel.location) ?? "",
      }),
      JSON.stringify({ summary: stringValue(input.hotel.description) ?? "" }),
      JSON.stringify(media),
      JSON.stringify(amenities),
      JSON.stringify(policy),
      JSON.stringify(freshness),
      input.generatedAt,
    ],
  );

  await client.query(
    `INSERT INTO booking.booking_settings
       (property_id, default_currency, default_language, supported_currencies, supported_languages, source_freshness)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (property_id) DO UPDATE SET
       default_currency = EXCLUDED.default_currency,
       default_language = EXCLUDED.default_language,
       supported_currencies = EXCLUDED.supported_currencies,
       supported_languages = EXCLUDED.supported_languages,
       source_freshness = EXCLUDED.source_freshness,
       updated_at = now()`,
    [
      input.propertyId,
      defaultCurrency,
      defaultLocale,
      supportedCurrencies,
      supportedLocales,
      JSON.stringify(freshness),
    ],
  );

  await client.query(
    `INSERT INTO finance.payment_settings
       (property_id, payments_enabled, accepted_methods, default_currency, deposit_policy, refund_policy, tax_policy, source_system, source_settings_id)
     VALUES ($1, false, ARRAY['pay_at_property']::text[], $2, '{}'::jsonb, $3, '{}'::jsonb, 'booking', $4)
     ON CONFLICT (property_id) DO UPDATE SET
       default_currency = EXCLUDED.default_currency,
       accepted_methods = EXCLUDED.accepted_methods,
       refund_policy = EXCLUDED.refund_policy,
       source_settings_id = EXCLUDED.source_settings_id,
       updated_at = now()`,
    [
      input.propertyId,
      defaultCurrency,
      JSON.stringify({ summary: policy.cancellationSummary ?? null }),
      `booking_hotels:${input.propertyId}`,
    ],
  );

  await client.query(
    `INSERT INTO distribution.public_hotel_bookability_profiles
       (property_id, finance_payment_settings_property_id, public_id, canonical_slug, canonical_url,
        booking_base_url, timezone, default_locale, supported_locales, default_currency,
        supported_currencies, profile_status, public_identity, location, media, amenities,
        policies, capabilities, supported_quote_parameters, public_setup_completeness,
        source_freshness, freshness_status, data_sources, generated_at, projected_at,
        expires_at)
     VALUES
       ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'public', $11, $12, $13, $14,
        $15, $16, $17, '{"status":"ready","missing":[]}'::jsonb, $18, 'fresh',
        ARRAY['hotel_catalog','booking','pms','finance','distribution']::text[], $19, $19, $20)
     ON CONFLICT (property_id) DO UPDATE SET
       public_id = EXCLUDED.public_id,
       canonical_slug = EXCLUDED.canonical_slug,
       canonical_url = EXCLUDED.canonical_url,
       booking_base_url = EXCLUDED.booking_base_url,
       timezone = EXCLUDED.timezone,
       default_locale = EXCLUDED.default_locale,
       supported_locales = EXCLUDED.supported_locales,
       default_currency = EXCLUDED.default_currency,
       supported_currencies = EXCLUDED.supported_currencies,
       profile_status = EXCLUDED.profile_status,
       public_identity = EXCLUDED.public_identity,
       location = EXCLUDED.location,
       media = EXCLUDED.media,
       amenities = EXCLUDED.amenities,
       policies = EXCLUDED.policies,
       capabilities = EXCLUDED.capabilities,
       supported_quote_parameters = EXCLUDED.supported_quote_parameters,
       public_setup_completeness = EXCLUDED.public_setup_completeness,
       source_freshness = EXCLUDED.source_freshness,
       freshness_status = EXCLUDED.freshness_status,
       generated_at = EXCLUDED.generated_at,
       projected_at = EXCLUDED.projected_at,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      input.propertyId,
      input.propertyId,
      input.slug,
      canonicalUrl,
      bookingBaseUrl,
      timezone,
      defaultLocale,
      supportedLocales,
      defaultCurrency,
      supportedCurrencies,
      JSON.stringify({
        propertyId: input.propertyId,
        slug: input.slug,
        name,
        summary: stringValue(input.hotel.description) ?? "",
      }),
      JSON.stringify({
        country: stringValue(input.hotel.country) ?? "",
        city: stringValue(input.hotel.location) ?? "",
      }),
      JSON.stringify(media),
      JSON.stringify(amenities),
      JSON.stringify(policy),
      JSON.stringify({
        instantBook: booleanValue(input.hotel.instant_book),
        onlinePayment: booleanValue(input.hotel.online_card_payment),
        payAtProperty: true,
        promoCodes: true,
        referralCodes: true,
        bookingDeepLinks: true,
      }),
      JSON.stringify({
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: maxAdults(input.snapshots),
        childrenSupported: true,
        supportedCurrencies,
        supportedLocales,
      }),
      JSON.stringify(freshness),
      input.generatedAt,
      addDays(input.generatedAt.slice(0, 10), 2),
    ],
  );

  for (const snapshot of input.snapshots) {
    const roomId = requiredUuid(snapshot.room.id, "legacy room type id");
    const roomName = stringValue(snapshot.room.name) ?? roomId;
    const currency = stringValue(snapshot.room.currency) ?? defaultCurrency;
    const availableRooms = Math.max(0, numberValue(snapshot.room.remainingRooms) ?? 0);
    const price = Math.max(0, numberValue(snapshot.room.baseRate) ?? 0);
    const occupancy = occupancyForLegacyRoom(snapshot.room);

    await client.query(
      `INSERT INTO pms.room_types
         (id, property_id, source_system, source_room_type_id, name, description, category,
          occupancy_limits, base_rate_amount, currency, active)
       VALUES ($1, $2, 'pms', $1, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         occupancy_limits = EXCLUDED.occupancy_limits,
         base_rate_amount = EXCLUDED.base_rate_amount,
         currency = EXCLUDED.currency,
         active = EXCLUDED.active,
         updated_at = now()`,
      [
        roomId,
        input.propertyId,
        roomName,
        stringValue(snapshot.room.description) ?? "",
        stringValue(snapshot.room.category),
        JSON.stringify(occupancy),
        price,
        currency,
      ],
    );

    await client.query(
      `INSERT INTO pms.inventory_days
         (property_id, room_type_id, stay_date, total_count, assigned_count, blocked_count, available_count, status, source_freshness)
       VALUES ($1, $2, $3::date, $4, 0, 0, $4, $5, $6)
       ON CONFLICT (property_id, room_type_id, stay_date) DO UPDATE SET
         total_count = EXCLUDED.total_count,
         assigned_count = EXCLUDED.assigned_count,
         blocked_count = EXCLUDED.blocked_count,
         available_count = EXCLUDED.available_count,
         status = EXCLUDED.status,
         source_freshness = EXCLUDED.source_freshness,
         updated_at = now()`,
      [
        input.propertyId,
        roomId,
        snapshot.stayDate,
        availableRooms,
        availableRooms > 0 ? "open" : "closed",
        JSON.stringify(freshness),
      ],
    );

    await client.query(
      `INSERT INTO distribution.public_room_offer_snapshots
         (property_id, room_type_id, stay_date, public_offer_key, availability_status,
          sellable_publicly, available_rooms, base_price_amount, taxes_and_fees_amount,
          discounts_amount, currency, occupancy, room_summary, rate_summary, payment_options,
          public_policy, unavailable_reasons, source_freshness, freshness_status,
          data_sources, generated_at, expires_at)
       VALUES
         ($1, $2, $3::date, $4, $5, $6, $7, $8, 0, 0, $9, $10, $11, $12,
          ARRAY['pay_at_property']::text[], $13, $14, $15, 'fresh',
          ARRAY['booking','pms','finance','distribution']::text[], $16, $17)
       ON CONFLICT (property_id, public_offer_key, stay_date) DO UPDATE SET
         availability_status = EXCLUDED.availability_status,
         sellable_publicly = EXCLUDED.sellable_publicly,
         available_rooms = EXCLUDED.available_rooms,
         base_price_amount = EXCLUDED.base_price_amount,
         currency = EXCLUDED.currency,
         occupancy = EXCLUDED.occupancy,
         room_summary = EXCLUDED.room_summary,
         rate_summary = EXCLUDED.rate_summary,
         payment_options = EXCLUDED.payment_options,
         public_policy = EXCLUDED.public_policy,
         unavailable_reasons = EXCLUDED.unavailable_reasons,
         source_freshness = EXCLUDED.source_freshness,
         freshness_status = EXCLUDED.freshness_status,
         generated_at = EXCLUDED.generated_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [
        input.propertyId,
        roomId,
        snapshot.stayDate,
        `${roomId}:flexible`,
        availableRooms > 0 ? "available" : "sold_out",
        availableRooms > 0,
        availableRooms,
        price,
        currency,
        JSON.stringify(occupancy),
        JSON.stringify({
          name: roomName,
          category: stringValue(snapshot.room.category),
          amenities: [],
        }),
        JSON.stringify({
          name: "Flexible",
          refundable: true,
          mealPlan: null,
          cancellationSummary: policy.cancellationSummary ?? null,
        }),
        JSON.stringify({
          cancellation: policy.cancellationSummary ?? null,
          deposit: null,
        }),
        availableRooms > 0 ? [] : ["sold_out"],
        JSON.stringify(freshness),
        input.generatedAt,
        addDays(input.generatedAt.slice(0, 10), 2),
      ],
    );
  }
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Slug must be lowercase DNS-safe text.");
  }
  return slug;
}

function clampDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120) {
    throw new Error("--days must be an integer between 1 and 120");
  }
  return value;
}

export function normalizeTimezone(value: string | null | undefined): string {
  if (!value || value === "UTC") return "Etc/UTC";
  return /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(value) ? value : "Etc/UTC";
}

export function bookingBaseUrlFor(slug: string, hostBase: string): string {
  const host = hostBase
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return `https://${slug}.${host || "next-booking.vayada.com"}`;
}

export function firstDayOfUtcMonth(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let cursor = start; cursor < end; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function publicPolicy(hotel: LegacyHotel, bookingBaseUrl: string, defaultLocale: string) {
  const cancellationSummary =
    stringValue(hotel.cancellation_policy_text) ??
    (numberValue(hotel.free_cancellation_days)
      ? `Free cancellation until ${numberValue(hotel.free_cancellation_days)} days before arrival.`
      : null);
  return {
    checkInFrom: stringValue(hotel.check_in_time),
    checkOutUntil: stringValue(hotel.check_out_time),
    cancellationSummary,
    termsUrl: stringValue(hotel.terms_text) ? `${bookingBaseUrl}/${defaultLocale}/terms` : null,
  };
}

function mediaFrom(hotel: LegacyHotel, name: string): { url: string; alt: string }[] {
  const urls = [stringValue(hotel.hero_image), ...arrayValue(hotel.images)].filter(
    (value): value is string => Boolean(value),
  );
  return [...new Set(urls)].map((url) => ({ url, alt: name }));
}

function maxAdults(snapshots: RoomSnapshot[]): number {
  return Math.max(
    1,
    ...snapshots.map(
      ({ room }) => numberValue(room.maxAdults) ?? numberValue(room.maxOccupancy) ?? 1,
    ),
  );
}

export function occupancyForLegacyRoom(room: LegacyRoom): Record<string, number> {
  const maxOccupancy = numberValue(room.maxOccupancy) ?? 1;
  const maxChildren = numberValue(room.maxChildren);
  return {
    maxAdults: numberValue(room.maxAdults) ?? maxOccupancy,
    maxOccupancy,
    ...(maxChildren === null ? {} : { maxChildren }),
  };
}

function requiredUuid(value: unknown, label: string): string {
  const text = stringValue(value);
  if (
    !text ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
  ) {
    throw new Error(`Missing ${label}`);
  }
  return text;
}

function withFirst(values: string[], first: string): string[] {
  return [first, ...values.filter((value) => value !== first)];
}

function arrayValue(value: unknown): string[] {
  const parsed = typeof value === "string" ? jsonValue(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function jsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
