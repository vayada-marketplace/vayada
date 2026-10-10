import {
  formatBookingPriceMinorUnits,
  roundBookingPriceDecimalToMinorUnits,
  type ReplacementOfferTerms,
} from "@vayada/domain-booking";
import {
  calculateReplacementRoomStay,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms";

import type {
  PmsManualBookingAvailabilityReadPort,
  PmsOperationsReadRepository,
} from "../domains/pmsOperationsReadModel.js";
import type { BookingAddonItem, BookingAddonItemsRepository } from "./bookingAddonItems.js";

export type ManualBookingMoney = { amountDecimal: string; currency: string };
/** A custom nightly rate; without a currency it is priced in the resolved pricing currency. */
export type ManualBookingCustomAmount = { amountDecimal: string; currency?: string };
type ManualBookingStayBase = {
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** One age per child; required to price a published offer when children > 0. */
  childAgesAtCheckIn?: number[];
};
export type ManualBookingStay = ManualBookingStayBase &
  (
    | {
        /** Published pricing-v2 offer id (pms.pricing_v2_rooms configuration offer). */
        ratePlanId: string;
        pricing: { kind: "rate_plan"; manualOverride: ManualBookingMoney | null };
      }
    | { ratePlanId: null; pricing: { kind: "custom"; nightlyAmount: ManualBookingCustomAmount } }
  );
type PricedManualBookingStay = ManualBookingStay & { dates: string[] };
export type ManualBookingAddonSelection = {
  addonId: string;
  packageCount: number;
  serviceUnits: { serviceDate: string | null; guestCount: number | null }[];
};
export type ManualBookingPreviewCommand = {
  contractVersion: "pms-manual-booking.v1";
  stays: ManualBookingStay[];
  addOns: ManualBookingAddonSelection[];
  /** Create only: the revision the client's preview showed. */
  expectedPricingRevision?: number;
};
/** The active pricing-v2 publication; amounts are minor units of its currency's own scale. */
export type ManualBookingPricingPublication = Readonly<{
  revision: number;
  currency: string;
  rooms: readonly PricingConfiguration[];
  terms: readonly ReplacementOfferTerms[];
}>;
export type PmsManualBookingPreviewRoutesOptions = {
  pms: Pick<PmsOperationsReadRepository, "listRoomsByPropertyId" | "listRoomTypesByPropertyId"> &
    PmsManualBookingAvailabilityReadPort;
  publication: {
    readCurrentPricingPublication(scope: {
      propertyId: string;
      organizationId: string;
    }): Promise<ManualBookingPricingPublication | null>;
    readPropertyPricingCurrency(propertyId: string): Promise<string | null>;
  };
  booking: Pick<BookingAddonItemsRepository, "listAddonItemsByHotelId">;
};

export async function calculateManualBookingPreview(
  scope: { propertyId: string; organizationId: string },
  command: ManualBookingPreviewCommand,
  ports: PmsManualBookingPreviewRoutesOptions,
) {
  const { propertyId } = scope;
  const pricedStays: PricedManualBookingStay[] = command.stays.map((stay) => ({
    ...stay,
    dates: datesBetween(stay.checkIn, stay.checkOut, stay.position),
  }));
  const needsPublication = pricedStays.some((stay) => stay.pricing.kind === "rate_plan");
  // Sequential: on the create path every port shares one transaction connection.
  const rooms = await ports.pms.listRoomsByPropertyId(propertyId);
  const roomTypes = await ports.pms.listRoomTypesByPropertyId(propertyId);
  // Custom-only bookings use the published currency when there is one, else the property's.
  const publication = await ports.publication.readCurrentPricingPublication(scope);
  const pricingCurrency = publication
    ? publication.currency
    : await ports.publication.readPropertyPricingCurrency(propertyId);
  const addonContext = await ports.booking.listAddonItemsByHotelId(propertyId);
  const available = await ports.pms.getPhysicalRoomAvailability(propertyId, pricedStays);
  if (!addonContext) fail(404, "property_not_found");
  if (needsPublication && !publication) fail(409, "pricing_not_published");
  // Prices were republished after the staff saw them: refuse before any other price outcome.
  if (
    needsPublication &&
    command.expectedPricingRevision !== undefined &&
    publication!.revision !== command.expectedPricingRevision
  )
    fail(409, "pricing_changed", "expectedPricingRevision");
  const addons = addonContext.addonItems;
  let currency = pricingCurrency;
  let grand = 0n;
  const stays = pricedStays.map((stay, index) => {
    const room = rooms.items.find((item) => item.roomId === stay.roomId);
    if (!room || available[index] === null) fail(404, "room_not_found", "roomId", stay.position);
    if (!available[index] || overlaps(stay, pricedStays))
      fail(409, "room_unavailable", "roomId", stay.position);
    const roomType = roomTypes.items.find((item) => item.roomTypeId === room.roomTypeId);
    if (!roomType?.active) fail(404, "room_not_found", "roomId", stay.position);
    const limits = roomType.occupancyLimits;
    const totalLimit = limits.total ?? 0;
    if (
      stay.adults > (limits.adults ?? totalLimit) ||
      stay.children > (limits.children ?? totalLimit) ||
      stay.adults + stay.children > totalLimit
    )
      fail(422, "occupancy_exceeded", "stays", stay.position);
    // Room types from the legacy rate flow still carry the property currency.
    currency ??= roomType.baseRate.currency;
    if (!currency) fail(409, "pricing_not_published", "stays", stay.position);
    const standards =
      stay.ratePlanId !== null ? publishedNights(scope, stay, room.roomTypeId, publication!) : null;
    // A custom rate without a currency takes the resolved one (v1 amendment, VAY-2065).
    const applied = stay.dates.map((_, position) =>
      stay.pricing.kind === "custom"
        ? {
            ...stay.pricing.nightlyAmount,
            currency: stay.pricing.nightlyAmount.currency ?? currency!,
          }
        : (stay.pricing.manualOverride ?? money(standards![position]!, currency!)),
    );
    for (const value of applied) requireCurrency(value, currency, stay.position);
    const standardTotal = standards?.reduce((sum, value) => sum + value, 0n) ?? null;
    const appliedTotal = applied.reduce((sum, value) => sum + minor(value.amountDecimal), 0n);
    grand += appliedTotal;
    return {
      position: stay.position,
      roomId: stay.roomId,
      ratePlanId: stay.ratePlanId,
      nightly: stay.dates.map((serviceDate, position) => ({
        serviceDate,
        standard: standards ? money(standards[position]!, currency!) : null,
        applied: money(minor(applied[position]!.amountDecimal), currency!),
      })),
      standardTotal: standardTotal === null ? null : money(standardTotal, currency),
      appliedTotal: money(appliedTotal, currency),
    };
  });
  const propertyCurrency = currency!;
  const addOns = command.addOns.map((selection) => {
    const addon = addons.find((item) => item.addonItemId === selection.addonId);
    if (!addon || addon.propertyId !== propertyId) fail(404, "addon_not_found", "addonId");
    if (addon.status !== "active") fail(422, "invalid_addon_selection", "addonId");
    requireCurrency({ amountDecimal: addon.price, currency: addon.currency }, propertyCurrency);
    const total =
      minor(addon.price) *
      BigInt(selection.packageCount) *
      BigInt(unitFactor(addon, selection, pricedStays));
    grand += total;
    return {
      addonId: selection.addonId,
      pricingModel: addon.pricingModel,
      unitPrice: money(minor(addon.price), propertyCurrency),
      packageCount: selection.packageCount,
      serviceUnits: selection.serviceUnits,
      total: money(total, propertyCurrency),
    };
  });
  return {
    contractVersion: command.contractVersion,
    currency: propertyCurrency,
    /** Publication revision the standard prices came from; null when every stay is custom. */
    pricingRevision: needsPublication ? (publication?.revision ?? null) : null,
    stays,
    addOns,
    grandTotal: money(grand, propertyCurrency),
  };
}

export type ManualBookingPreviewResult = Awaited<ReturnType<typeof calculateManualBookingPreview>>;

/** Standard nightly room + meal amounts of the published offer, in minor units. */
function publishedNights(
  scope: { propertyId: string },
  stay: Extract<PricedManualBookingStay, { pricing: { kind: "rate_plan" } }>,
  roomTypeId: string,
  publication: ManualBookingPricingPublication,
): bigint[] {
  const configuration = publication.rooms.find((room) => room.roomTypeId === roomTypeId);
  if (!configuration?.offers.some((offer) => offer.id === stay.ratePlanId))
    fail(404, "rate_plan_not_found", "ratePlanId", stay.position);
  const ages = stay.childAgesAtCheckIn ?? [];
  if (ages.length !== stay.children)
    fail(422, "child_ages_required", "childAgesAtCheckIn", stay.position);
  const terms = publication.terms.filter((item) => item.roomTypeId === roomTypeId);
  const priced = calculateReplacementRoomStay(configuration, {
    propertyId: scope.propertyId,
    roomTypeId,
    offerId: stay.ratePlanId,
    expectedRevision: publication.revision,
    expectedTermsRevisions: Object.fromEntries(terms.map((item) => [item.offerId, item.revision])),
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    guests: { adults: stay.adults, childAgesAtCheckIn: ages },
  });
  if (priced.kind !== "priced") {
    if (priced.reason === "invalid_guests") fail(422, "occupancy_exceeded", "stays", stay.position);
    if (priced.reason === "restriction") fail(422, "rate_restricted", "checkIn", stay.position);
    if (priced.reason === "missing_price" || priced.reason === "missing_terms")
      fail(404, "rate_not_found", "ratePlanId", stay.position);
    // Revisions come from the same publication read, so anything else is malformed stored data.
    throw new Error(`Manual booking pricing is ${priced.reason}`);
  }
  const nights = new Map(priced.nights.map((night) => [night.date, night.totalMinor]));
  return stay.dates.map((date) => {
    const night = nights.get(date);
    return night === undefined ? invalid() : cents(night, publication.currency, stay.position);
  });
}

function cents(totalMinor: number | string, currency: string, stayPosition: number): bigint {
  return (
    publishedMinorToCents(totalMinor, currency) ??
    fail(422, "currency_mismatch", "ratePlanId", stayPosition)
  );
}

/** PMS money has two decimals; publication minor units use the currency's own scale (JPY 0,
 * KWD 3). Converted as accepted booking-engine quotes are; null when a remainder cannot be
 * stored. */
export function publishedMinorToCents(
  totalMinor: number | string,
  currency: string,
): bigint | null {
  const scale = pricingCurrencyScale(currency);
  if (scale === null) throw new Error(`Unsupported publication currency ${currency}`);
  const numerator = BigInt(totalMinor) * 100n,
    unit = 10n ** BigInt(scale);
  return numerator % unit === 0n ? numerator / unit : null;
}

function unitFactor(
  addon: BookingAddonItem,
  selection: ManualBookingAddonSelection,
  stays: PricedManualBookingStay[],
): number {
  const units = selection.serviceUnits;
  const occupancy = (date: string) =>
    stays
      .filter((stay) => stay.checkIn <= date && date < stay.checkOut)
      .reduce((sum, stay) => sum + stay.adults + stay.children, 0);
  const dates = units.flatMap((unit) => (unit.serviceDate === null ? [] : [unit.serviceDate]));
  const expectedDates = new Set(stays.flatMap((stay) => stay.dates));
  const totalGuests = stays.reduce((sum, stay) => sum + stay.adults + stay.children, 0);
  let valid = new Set(dates).size === dates.length;
  if (addon.pricingModel === "per_stay")
    valid &&= units.length === 1 && units[0]!.serviceDate === null && units[0]!.guestCount === null;
  if (addon.pricingModel === "per_guest")
    valid &&=
      units.length === 1 &&
      units[0]!.serviceDate === null &&
      !!units[0]!.guestCount &&
      units[0]!.guestCount! <= totalGuests;
  if (addon.pricingModel === "per_night")
    valid &&=
      dates.length === expectedDates.size &&
      dates.every((date) => expectedDates.has(date)) &&
      units.every(
        (unit) =>
          unit.serviceDate !== null && unit.guestCount === null && occupancy(unit.serviceDate) > 0,
      );
  if (addon.pricingModel === "per_guest_night")
    valid &&=
      dates.length === expectedDates.size &&
      dates.every((date) => expectedDates.has(date)) &&
      units.every(
        (unit) =>
          unit.serviceDate !== null &&
          !!unit.guestCount &&
          unit.guestCount! <= occupancy(unit.serviceDate),
      );
  if (!valid) fail(422, "invalid_addon_selection", "serviceUnits");
  return units.reduce((sum, unit) => sum + (unit.guestCount ?? 1), 0);
}

export class PreviewError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly body: { code: string; message: string; field?: string; stayPosition?: number },
  ) {
    super(body.message);
  }
}
export function fail(
  status: 400 | 403 | 404 | 409 | 422,
  code: string,
  field?: string,
  stayPosition?: number,
): never {
  throw new PreviewError(status, {
    code,
    message: `${code.replaceAll("_", " ")}.`,
    ...(field ? { field } : {}),
    ...(stayPosition ? { stayPosition } : {}),
  });
}
export function invalid(): never {
  fail(400, "invalid_body");
}
function minor(value: unknown): bigint {
  const parsed = roundBookingPriceDecimalToMinorUnits(value);
  if (!parsed) invalid();
  return BigInt(parsed);
}
function money(value: bigint, currency: string): ManualBookingMoney {
  const amountDecimal = formatBookingPriceMinorUnits(String(value));
  if (!amountDecimal) invalid();
  return { amountDecimal, currency };
}
function requireCurrency(value: ManualBookingMoney, currency: string, stayPosition?: number): void {
  if (value.currency !== currency) fail(422, "currency_mismatch", "currency", stayPosition);
  minor(value.amountDecimal);
}
function datesBetween(from: string, to: string, stayPosition: number): string[] {
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (!valid(from) || !valid(to)) fail(422, "invalid_dates", "stays", stayPosition);
  const start = Date.parse(`${from}T00:00:00Z`);
  const count = (Date.parse(`${to}T00:00:00Z`) - start) / 86_400_000;
  if (!Number.isInteger(count) || count < 1 || count > 366)
    fail(422, "invalid_dates", "stays", stayPosition);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}
function overlaps(stay: ManualBookingStay, stays: ManualBookingStay[]): boolean {
  return stays.some(
    (other) =>
      other.position < stay.position &&
      other.roomId === stay.roomId &&
      other.checkIn < stay.checkOut &&
      other.checkOut > stay.checkIn,
  );
}
