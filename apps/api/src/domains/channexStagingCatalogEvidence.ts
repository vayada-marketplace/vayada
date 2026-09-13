import { createHash } from "node:crypto";
export class StagingCatalogError extends Error {}
export const rejectCatalog = (code: string): never => {
  throw new StagingCatalogError(code);
};
export const catalogUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown) => (Array.isArray(v) ? v.map(object) : []);
const relation = (v: Record<string, unknown>, key: string) =>
  object(object(object(v.relationships)[key]).data).id;
const title = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200
    ? v.trim()
    : rejectCatalog("invalid_catalog_title");
const count = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
    ? v
    : rejectCatalog("invalid_catalog_capacity");

const mealType = (value: unknown) => {
  if (value === "none" || value === "room_only") return "room_only";
  if (value === "breakfast") return "breakfast";
  return rejectCatalog("unsupported_catalog_meal");
};

export type StagingCatalogRequest = {
  providerPropertyId: string;
  bookingId: string;
  revisionId: string;
  channelId?: string;
  retainedRevision?: boolean;
  approvalRef: string;
  applyHash?: string;
  preImport?: boolean;
};

/** Explicit VAY-2013 recovery authorization; not a general disconnected-channel fallback. */
export const retainedRevisionScope = Object.freeze({
  propertyId: "65f6b2fc-c783-4963-9d6b-a85f82319769",
  providerPropertyId: "8f4c1e47-3de1-4150-8bde-ad031a013842",
  bookingId: "ecdbc6c7-65f1-4f8e-9036-0931e5df8ded",
  revisionId: "e747c382-ecd8-4a70-914a-f2d7f2e363a5",
  roomId: "884415d4-4408-43b1-9bcd-553352574e0c",
  rateId: "55ed3514-378a-4467-ae77-164c1a6bd02e",
  hotelId: "5868189",
  otaBookingCode: "6431849020",
  otaRoomCode: "586818903",
  otaRateCode: "16385048",
});

/** Validate operator scope before any database or authenticated provider reads. */
export function validateRetainedRevisionRequest(input: StagingCatalogRequest) {
  if (
    input.retainedRevision &&
    (!input.preImport ||
      input.channelId !== undefined ||
      input.providerPropertyId !== retainedRevisionScope.providerPropertyId ||
      input.bookingId !== retainedRevisionScope.bookingId ||
      input.revisionId !== retainedRevisionScope.revisionId ||
      !input.approvalRef.startsWith("VAY-2013:"))
  )
    rejectCatalog("invalid_retained_revision_scope");
}

/** Read only: never repairs provider mappings or acknowledges a revision. */
export async function readStagingCatalogEvidence(
  input: StagingCatalogRequest,
  apiKey: string,
  request: typeof fetch,
) {
  validateRetainedRevisionRequest(input);
  const get = async (path: string, body?: unknown) => {
    const response = await request(`https://staging.channex.io/api/v1/${path}`, {
      headers: { "user-api-key": apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) rejectCatalog("provider_read_failed");
    return object(object(await response.json()).data);
  };
  const revision = await get(`booking_revisions/${input.revisionId}`);
  const booking = object(revision.attributes),
    stays = list(booking.rooms);
  if (
    revision.id !== input.revisionId ||
    booking.booking_id !== input.bookingId ||
    booking.property_id !== input.providerPropertyId ||
    !["Booking.com", "BookingCom"].includes(String(booking.ota_name)) ||
    !["new", "modified", "confirmed"].includes(String(booking.status)) ||
    stays.length !== 1
  )
    rejectCatalog("invalid_catalog_revision");
  const stay = stays[0]!,
    meta = object(stay.meta);
  if (!catalogUuid(stay.room_type_id) || !catalogUuid(stay.rate_plan_id))
    rejectCatalog("revision_rate_unmapped");
  const roomId = stay.room_type_id as string,
    rateId = stay.rate_plan_id as string;
  let channelCurrency: unknown, mappedRateId: unknown;
  if (input.retainedRevision) {
    const scope = retainedRevisionScope;
    if (
      booking.channel_id !== null ||
      booking.is_crs_revision !== false ||
      String(booking.ota_reservation_code) !== scope.otaBookingCode ||
      roomId !== scope.roomId ||
      rateId !== scope.rateId ||
      String(meta.room_type_code) !== scope.otaRoomCode ||
      String(meta.rate_plan_code) !== scope.otaRateCode
    )
      rejectCatalog("invalid_retained_revision_scope");
    // These documented probes read the OTA catalog; the retained revision supplies the allocation.
    const probe = { channel: "BookingCom", settings: { hotel_id: scope.hotelId } };
    const catalog = await get("channels/mapping_details", probe);
    const rooms = list(catalog.rooms).filter((r) => String(r.id) === scope.otaRoomCode);
    const rates = list(rooms[0]?.rates).filter((r) => String(r.id) === scope.otaRateCode);
    if (
      rooms.length !== 1 ||
      rates.length !== 1 ||
      catalog.pricing_type !== "Standard" ||
      rates[0]!.pricing !== "Standard" ||
      rates[0]!.readonly !== false ||
      rates[0]!.parent_rate_id !== "" ||
      rates[0]!.max_persons !== 2
    )
      rejectCatalog("invalid_retained_ota_catalog");
    channelCurrency = object((await get("channels/connection_details", probe)).attributes).currency;
    mappedRateId = rateId;
  } else {
    const channel = await get(`channels/${input.channelId}`),
      channelFacts = object(channel.attributes);
    if (
      channel.id !== input.channelId ||
      channelFacts.channel !== "BookingCom" ||
      channelFacts.is_active !== true ||
      !Array.isArray(channelFacts.properties) ||
      channelFacts.properties.length !== 1 ||
      channelFacts.properties[0] !== input.providerPropertyId
    )
      rejectCatalog("invalid_catalog_channel");
    if (
      !/^\d+$/.test(String(meta.room_type_code ?? "")) ||
      !/^\d+$/.test(String(meta.rate_plan_code ?? ""))
    )
      rejectCatalog("missing_ota_mapping_evidence");
    const mappings = list(channelFacts.rate_plans).filter((m) => {
      const settings = object(m.settings);
      return (
        String(settings.room_type_code) === String(meta.room_type_code) &&
        String(settings.rate_plan_code) === String(meta.rate_plan_code)
      );
    });
    if (mappings.length !== 1) rejectCatalog("ota_rate_unmapped_or_ambiguous");
    channelCurrency = channelFacts.currency;
    mappedRateId = mappings[0]!.rate_plan_id;
  }
  const room = await get(`room_types/${roomId}`),
    rate = await get(`rate_plans/${rateId}`);
  const r = object(room.attributes),
    a = object(rate.attributes);
  const checkRate = (value: Record<string, unknown>, id: string) => {
    if (
      value.id !== id ||
      relation(value, "property") !== input.providerPropertyId ||
      relation(value, "room_type") !== roomId
    )
      rejectCatalog("catalog_rate_scope_mismatch");
  };
  if (
    room.id !== roomId ||
    relation(room, "property") !== input.providerPropertyId ||
    r.room_kind !== "room"
  )
    rejectCatalog("catalog_room_scope_mismatch");
  checkRate(rate, rateId);
  let base = a;
  const parentId = relation(rate, "parent_rate_plan");
  if (
    input.retainedRevision &&
    (parentId != null ||
      relation(rate, "channel") != null ||
      a.rate_mode !== "manual" ||
      a.currency !== "GBP" ||
      a.meal_type !== "none" ||
      r.default_occupancy !== 2)
  )
    rejectCatalog("unsupported_retained_rate");
  if (a.rate_mode === "derived") {
    if (
      !catalogUuid(parentId) ||
      relation(rate, "channel") !== input.channelId ||
      parentId !== mappedRateId
    )
      rejectCatalog("unsupported_derived_rate");
    const options = list(a.options);
    if (
      a.inherit_rate !== true ||
      options.length !== 1 ||
      options[0]!.inherit_rate !== true ||
      Object.keys(object(options[0]!.derived_option)).length !== 0
    )
      rejectCatalog("unsupported_derived_rate");
    const parent = await get(`rate_plans/${parentId}`);
    checkRate(parent, parentId as string);
    base = object(parent.attributes);
  } else if (rateId !== mappedRateId) rejectCatalog("catalog_mapping_mismatch");
  const meal = mealType(a.meal_type);
  if (meal !== mealType(base.meal_type)) rejectCatalog("catalog_meal_mismatch");
  const options = list(base.options),
    primary = options[0];
  if (
    base.rate_mode !== "manual" ||
    base.sell_mode !== "per_room" ||
    a.sell_mode !== "per_room" ||
    options.length !== 1 ||
    primary?.is_primary !== true ||
    typeof primary.rate !== "string" ||
    !/^\d{1,10}(\.\d{1,2})?$/.test(primary.rate) ||
    a.currency !== base.currency ||
    a.currency !== booking.currency ||
    a.currency !== channelCurrency ||
    !/^[A-Z]{3}$/.test(String(a.currency))
  )
    rejectCatalog("unsupported_catalog_rate");
  const adults = count(r.occ_adults, 1, 20),
    children = count(r.occ_children, 0, 20);
  if (input.retainedRevision && adults + children !== 2)
    rejectCatalog("catalog_occupancy_mismatch");
  if (count(r.default_occupancy, 1, 20) !== count(primary.occupancy, 1, 20))
    rejectCatalog("catalog_occupancy_mismatch");
  if (input.preImport) {
    const occupancy = object(stay.occupancy),
      fallback = object(booking.occupancy),
      bookedAdults = count(occupancy.adults ?? fallback.adults, 1, 20),
      bookedChildren = count(occupancy.children ?? fallback.children ?? 0, 0, 20);
    if (
      bookedAdults > adults ||
      bookedChildren > children ||
      (input.retainedRevision && bookedAdults + bookedChildren > 2) ||
      count(list(a.options)[0]?.occupancy, 1, 20) !== r.default_occupancy
    )
      rejectCatalog("catalog_booked_occupancy_mismatch");
  }
  return {
    ...(input.retainedRevision
      ? { recovery: "retained-ota-revision.v1", hotelId: retainedRevisionScope.hotelId }
      : {}),
    ...(input.preImport
      ? {
          revisionHash: stagingRevisionHash(revision),
          defaultOccupancy: r.default_occupancy,
          rateOccupancy: list(a.options)[0]?.occupancy,
        }
      : {}),
    roomId,
    rateId,
    parentId: parentId ?? null,
    otaRoomCode: String(meta.room_type_code),
    otaRateCode: String(meta.rate_plan_code),
    roomName: title(r.title),
    rateName: title(a.title),
    adults,
    children,
    providerRoomCount: count(r.count_of_rooms, 1, 100),
    currency: a.currency as string,
    amount: primary.rate,
    mealType: meal,
  };
}

/** Stable digest only: no guest facts are retained in the catalog audit. */
export function stagingRevisionHash(revision: unknown): string {
  const value = object(revision),
    attributes = object(value.attributes);
  // Bind booking/operational/revenue facts, not mutable transport/ACK metadata.
  const evidence = {
    id: value.id,
    ...Object.fromEntries(
      [
        "booking_id",
        "property_id",
        "ota_reservation_code",
        "ota_name",
        "status",
        "revision",
        "revision_number",
        "arrival_date",
        "departure_date",
        "occupancy",
        "currency",
        "amount",
        "services",
      ].map((key) => [key, attributes[key]]),
    ),
    insertedAt: attributes.inserted_at ?? value.inserted_at,
    rooms: list(attributes.rooms).map((room) => ({
      ...Object.fromEntries(
        ["room_type_id", "rate_plan_id", "checkin_date", "checkout_date", "occupancy", "days"].map(
          (key) => [key, room[key]],
        ),
      ),
      otaRoomCode: object(room.meta).room_type_code,
      otaRateCode: object(room.meta).rate_plan_code,
    })),
  };
  return createHash("sha256")
    .update(
      JSON.stringify(evidence, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
}
