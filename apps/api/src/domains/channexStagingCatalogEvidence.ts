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

export type StagingCatalogRequest = {
  providerPropertyId: string;
  bookingId: string;
  revisionId: string;
  channelId: string;
  approvalRef: string;
  applyHash?: string;
};

/** Read only: never repairs provider mappings or acknowledges a revision. */
export async function readStagingCatalogEvidence(
  input: StagingCatalogRequest,
  apiKey: string,
  request: typeof fetch,
) {
  const get = async (path: string) => {
    const response = await request(`https://staging.channex.io/api/v1/${path}`, {
      headers: { "user-api-key": apiKey },
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
    booking.ota_name !== "Booking.com" ||
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
  if (a.rate_mode === "derived") {
    if (
      !catalogUuid(parentId) ||
      relation(rate, "channel") !== input.channelId ||
      parentId !== mappings[0]!.rate_plan_id
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
  } else if (rateId !== mappings[0]!.rate_plan_id) rejectCatalog("catalog_mapping_mismatch");
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
    a.currency !== channelFacts.currency ||
    !/^[A-Z]{3}$/.test(String(a.currency)) ||
    !["none", "room_only"].includes(String(a.meal_type)) ||
    !["none", "room_only"].includes(String(base.meal_type))
  )
    rejectCatalog("unsupported_catalog_rate");
  const adults = count(r.occ_adults, 1, 20),
    children = count(r.occ_children, 0, 20);
  if (count(r.default_occupancy, 1, 20) !== count(primary.occupancy, 1, 20))
    rejectCatalog("catalog_occupancy_mismatch");
  return {
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
  };
}
