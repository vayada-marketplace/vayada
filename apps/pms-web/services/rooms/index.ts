import {
  type PmsMealPlan,
  type RoomTypeFacts,
  parseConfirmRoomTypeAmenitiesResult,
  parseCreateRoomTypeFactsResult,
  parseUpdateRoomTypeFactsResult,
  parsePhysicalRoomUnitIdentity,
  parseReconcilePhysicalRoomUnitsResult,
  parseRoomTypeCapacitySnapshot,
  parseSetPhysicalRoomOperationalLabelResult,
} from "@vayada/domain-pms";

import {
  assertPmsOperationsReadModelEnabled,
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "../api/pmsOperationsClient";
import { ApiErrorResponse } from "../api/client";
import { resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";
import type { RoomImageReference } from "../upload";
import { imageReferenceUrl, pmsRoomMediaResource, uploadService } from "../upload";
import {
  bedSummaryFromFacts,
  roomAmenityInputsChanged,
  roomAmenityKeys,
  roomFactInputsChanged,
  roomAmenityLabels,
  roomCategoryLabel,
  roomSizeValue,
  roomTypeFactsFromForm,
} from "./roomFacts";

export interface MonthlyRate {
  baseRate?: number | null;
  nonRefundableRate?: number | null;
}

// Booking.com meal_plan_code values that Channex maps for us. 0 (room only)
// is the implicit default and never appears in the meal_plans array.
export type MealPlanCode = 1 | 3 | 4 | 9;

export type MealPlanChargeUnit = "room" | "person";

export interface MealPlan {
  code: MealPlanCode;
  surcharge: number;
  chargePer: MealPlanChargeUnit;
}

export interface PartialRefundTier {
  minDaysBeforeCheckIn: number;
  refundPercent: number;
}

export type RatePlanKey = "flexible" | "nonrefundable";

export interface RateDepositSetting {
  enabled: boolean;
  percentage: number | null;
}

export interface RoomSeason {
  name: string;
  tier: string;
  from: string;
  to: string;
  rate: string;
  minStay: number;
  maxStay?: number | string | null;
  occupancyRates?: Record<string, string>;
}

export interface RoomType {
  id: string;
  version: string;
  hotelId: string;
  name: string;
  category: string;
  description: string;
  shortDescription: string;
  maxOccupancy: number;
  maxAdults: number | null;
  maxChildren: number | null;
  bedrooms: number;
  bathrooms: number;
  bathroomType: "private" | "shared";
  size: number;
  baseRate: number;
  nonRefundableRate: number | null;
  currency: string;
  locationAddress: string;
  latitude: number | null;
  longitude: number | null;
  amenities: string[];
  images: RoomImageReference[];
  roomMediaRevision: number;
  /** Null until the API reports it; amenity edits then need a reload. */
  roomAmenitiesRevision: number | null;
  bedType: string;
  features: string[];
  benefits: string[];
  totalRooms: number;
  isActive: boolean;
  sortOrder: number;
  monthlyRates: Record<string, MonthlyRate>;
  dailyRates: Record<string, number>;
  operatingPeriods: { from: string; to: string }[];
  seasons: RoomSeason[];
  weekendSurcharge: string;
  cancellationPolicy: string;
  flexibleRateEnabled: boolean;
  flexibleCancellationType: "free" | "partial_refund";
  partialRefundCancelWindowDays: number;
  partialRefundAmountPercent: number;
  partialRefundTiers: PartialRefundTier[];
  nonRefundableEnabled: boolean;
  nonRefundableDiscount: number;
  nonRefundableCancellationPolicy: string;
  minimumAdvanceDays: number;
  ratePaymentMethods: Record<string, string[]> | null;
  rateDepositSettings: Partial<Record<RatePlanKey, RateDepositSetting>> | null;
  mealPlan?: PmsMealPlan;
  mealPlans: MealPlan[];
  createdAt: string;
  updatedAt: string;
}

export interface RoomTypeCreate {
  name: string;
  category?: string;
  description?: string;
  shortDescription?: string;
  maxOccupancy?: number;
  maxAdults?: number | null;
  maxChildren?: number | null;
  bedrooms?: number;
  bathrooms?: number;
  bathroomType: "private" | "shared";
  size?: number;
  baseRate?: number;
  nonRefundableRate?: number | null;
  currency?: string;
  locationAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  amenities?: string[];
  images?: RoomImageReference[];
  bedType?: string;
  features?: string[];
  benefits?: string[];
  totalRooms?: number;
  isActive?: boolean;
  sortOrder?: number;
  monthlyRates?: Record<string, MonthlyRate>;
  dailyRates?: Record<string, number>;
  operatingPeriods?: { from: string; to: string }[];
  seasons?: RoomSeason[];
  weekendSurcharge?: string;
  cancellationPolicy?: string;
  flexibleRateEnabled?: boolean;
  flexibleCancellationType?: "free" | "partial_refund";
  partialRefundCancelWindowDays?: number;
  partialRefundAmountPercent?: number;
  partialRefundTiers?: PartialRefundTier[];
  nonRefundableEnabled?: boolean;
  nonRefundableDiscount?: number;
  nonRefundableCancellationPolicy?: string;
  minimumAdvanceDays?: number;
  ratePaymentMethods?: Record<string, string[]> | null;
  rateDepositSettings?: Partial<Record<RatePlanKey, RateDepositSetting>> | null;
  mealPlan?: PmsMealPlan;
  mealPlans?: MealPlan[];
}

export type RoomTypeUpdate = Partial<RoomTypeCreate>;

export interface RoomTypeSaveResult {
  roomType: RoomType;
  /** The edit changed room facts or attributes, which published prices pin. */
  pricesNeedPublishing: boolean;
}

export interface Room {
  roomUnitsRevision?: number;
  id: string;
  hotelId: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: string;
  status: "available" | "maintenance" | "out_of_order";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedInventoryGroup {
  groupId: string;
  name: string;
  revision: number;
  memberRoomTypeIds: string[];
}

interface LinkedInventoryGroupsResponse {
  propertyId: string;
  items: LinkedInventoryGroup[];
}

interface LinkedInventoryGroupCommandResponse {
  propertyId: string;
  group: LinkedInventoryGroup | null;
}

export type PmsOperationsContractVersion = "pms-operations.v1";

export interface PropertyPlan {
  propertyId: string;
  plan: "commission" | "fixed";
  limits: {
    maxRoomPhotosPerType: number;
    maxAddons: number;
    guestContactAccess: "after_acceptance" | "always";
  };
}

export interface PmsPropertyPlanResponse {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  propertyPlan: PropertyPlan;
}

export interface PmsOperationsMoney {
  amountDecimal: string;
  currency: string;
}

export interface PmsOperationsRatePlan {
  ratePlanId: string;
  pricingContractVersion?: string | null;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRate: PmsOperationsMoney;
  cancellationPolicySnapshot?: Record<string, unknown>;
  active: boolean;
}

export interface PmsOperationsRateRulesSummary {
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: number;
}

export interface PmsOperationsRoomType {
  roomTypeId: string;
  version: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: Record<string, string | number | boolean | null>;
  amenities: string[];
  media: { mediaObjectId?: string; url: string; altText?: string | null }[];
  roomMediaRevision: number;
  roomAmenitiesRevision?: number;
  baseRate: PmsOperationsMoney;
  active: boolean;
  sortOrder: number;
  ratePlans: PmsOperationsRatePlan[];
  rateRulesSummary: PmsOperationsRateRulesSummary;
  roomCount: number;
}

export interface PmsOperationsRoom {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: "available" | "maintenance" | "out_of_order" | "retired";
  sortOrder: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsListResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: T[];
  sourceFreshness: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsDetailResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: T;
  sourceFreshness: Record<string, string | number | boolean | null>;
}

export interface PmsOperationsCommandMeta {
  contractVersion: PmsOperationsContractVersion;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  sideEffects: Array<"calendar_refresh" | "ari_changed" | "distribution_refresh" | "audit_event">;
}

export interface PmsOperationsCommandResponse<T> {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: T;
  commandMeta: PmsOperationsCommandMeta;
}

export interface RoomTypeRetirementImpact {
  contractVersion: "pms-room-type-lifecycle.v1";
  propertyId: string;
  roomTypeId: string;
  version: string;
  canRetire: boolean;
  blockers: Array<{
    category: "reservations" | "physical_units" | "inventory" | "publication";
    code:
      | "active_reservations"
      | "active_physical_units"
      | "future_inventory"
      | "active_publication";
    affectedCount: number;
    action: string;
  }>;
}

export interface RoomCreate {
  roomTypeId: string;
  roomNumber: string;
  floor?: string;
  status?: string;
  sortOrder?: number;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = asNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function cancellationPolicyFromRatePlans(ratePlans: PmsOperationsRatePlan[]) {
  const flexiblePlans = ratePlans.filter((plan) => plan.active && plan.rateType === "flexible");
  const snapshot =
    flexiblePlans.find((plan) => plan.pricingContractVersion === "pms-pricing.v1")
      ?.cancellationPolicySnapshot ?? flexiblePlans[0]?.cancellationPolicySnapshot;
  const rawTiers = Array.isArray(snapshot?.partialRefundTiers) ? snapshot.partialRefundTiers : [];
  const partialRefundTiers = rawTiers.flatMap((tier) => {
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) return [];
    const raw = tier as Record<string, unknown>;
    const minDaysBeforeCheckIn = asNumber(
      raw.minDaysBeforeCheckIn ?? raw.min_days_before_check_in,
      NaN,
    );
    const refundPercent = asNumber(raw.refundPercent ?? raw.refund_percent, NaN);
    return Number.isInteger(minDaysBeforeCheckIn) && Number.isInteger(refundPercent)
      ? [{ minDaysBeforeCheckIn, refundPercent }]
      : [];
  });
  const flexibleCancellationType =
    snapshot?.flexibleCancellationType === "partial_refund" ? "partial_refund" : "free";
  const freeCancellationDeadlineDays = asNumber(snapshot?.freeCancellationDeadlineDays, 7);
  return {
    cancellationPolicy: asString(
      snapshot?.text,
      `Free until ${freeCancellationDeadlineDays} days before`,
    ),
    freeCancellationDeadlineDays,
    flexibleCancellationType,
    partialRefundCancelWindowDays: asNumber(snapshot?.partialRefundCancelWindowDays, 30),
    partialRefundAmountPercent: asNumber(snapshot?.partialRefundAmountPercent, 50),
    partialRefundTiers,
  } as const;
}

function toRoom(
  response: PmsOperationsListResponse<PmsOperationsRoom>,
  room: PmsOperationsRoom,
): Room {
  return {
    id: room.roomId,
    hotelId: response.propertyId,
    roomTypeId: room.roomTypeId,
    roomTypeName: asString(room.metadata.roomTypeName),
    roomUnitsRevision: asNumber(room.metadata.roomUnitsRevision),
    roomNumber: room.roomNumber,
    floor: room.floor ?? "",
    status: room.status === "retired" ? "out_of_order" : room.status,
    sortOrder: room.sortOrder,
    createdAt: "",
    updatedAt: "",
  };
}

function toRoomType(propertyId: string, roomType: PmsOperationsRoomType): RoomType {
  // Published pricing-v2 offers belong to the pricing editor; linked ones carry no own rate.
  const ratePlans = roomType.ratePlans.filter(
    (plan) => plan.pricingContractVersion !== "pricing.v2",
  );
  const canonicalPlan = ratePlans.find(
    (plan) =>
      plan.active &&
      plan.rateType === "flexible" &&
      plan.pricingContractVersion === "pms-pricing.v1",
  );
  const baseRateMoney = canonicalPlan?.baseRate ?? roomType.baseRate;
  const baseRate = asNumber(baseRateMoney.amountDecimal);
  const currency = baseRateMoney.currency;
  const maxAdults = roomType.occupancyLimits.adults ?? null;
  const maxChildren = roomType.occupancyLimits.children ?? null;
  const derivedOccupancy = (maxAdults ?? 0) + (maxChildren ?? 0);
  const maxOccupancy =
    roomType.occupancyLimits.total ?? (derivedOccupancy > 0 ? derivedOccupancy : 0);
  const nonRefundablePlan = ratePlans.find(
    (plan) => plan.active && plan.rateType === "non_refundable",
  );
  const nonRefundableRate = nonRefundablePlan
    ? asNumber(nonRefundablePlan.baseRate.amountDecimal)
    : null;
  const flexibleCancellation = cancellationPolicyFromRatePlans(ratePlans);

  return {
    id: roomType.roomTypeId,
    version: roomType.version,
    hotelId: propertyId,
    name: roomType.name,
    category: roomCategoryLabel(roomType.category),
    description: roomType.description,
    shortDescription: asString(roomType.attributes.shortDescription, roomType.description),
    maxOccupancy,
    maxAdults,
    maxChildren,
    bedrooms: asNumber(roomType.attributes.bedrooms, 1),
    bathrooms: asNumber(roomType.attributes.bathrooms, 1),
    bathroomType: roomType.attributes.bathroomType === "shared" ? "shared" : "private",
    size: asNumber(roomSizeValue(roomType.attributes.size)),
    baseRate,
    nonRefundableRate,
    currency,
    locationAddress: asString(roomType.attributes.locationAddress),
    latitude: asNullableNumber(roomType.attributes.latitude),
    longitude: asNullableNumber(roomType.attributes.longitude),
    amenities: roomAmenityLabels(roomType.amenities),
    images: roomType.media.map((image) =>
      image.altText === undefined
        ? { url: image.url, platformMediaObjectId: image.mediaObjectId }
        : {
            url: image.url,
            platformMediaObjectId: image.mediaObjectId,
            altText: image.altText,
          },
    ),
    roomMediaRevision: roomType.roomMediaRevision ?? 1,
    roomAmenitiesRevision: roomType.roomAmenitiesRevision ?? null,
    // Room facts write `beds`; an older free-text `bedType` stays behind in the row.
    bedType: bedSummaryFromFacts(roomType.attributes.beds) ?? asString(roomType.attributes.bedType),
    features: [],
    benefits: [],
    totalRooms: roomType.roomCount,
    isActive: roomType.active,
    sortOrder: roomType.sortOrder,
    monthlyRates: {},
    dailyRates: {},
    operatingPeriods: [],
    seasons:
      baseRate > 0
        ? [
            {
              name: "Default",
              tier: "mid",
              from: "01-01",
              to: "12-31",
              rate: String(baseRate),
              minStay: roomType.rateRulesSummary.minStayNights ?? 1,
              maxStay: roomType.rateRulesSummary.maxStayNights,
            },
          ]
        : [],
    weekendSurcharge: "+0%",
    cancellationPolicy: flexibleCancellation.cancellationPolicy,
    flexibleRateEnabled: true,
    flexibleCancellationType: flexibleCancellation.flexibleCancellationType,
    partialRefundCancelWindowDays: flexibleCancellation.partialRefundCancelWindowDays,
    partialRefundAmountPercent: flexibleCancellation.partialRefundAmountPercent,
    partialRefundTiers: flexibleCancellation.partialRefundTiers,
    nonRefundableEnabled: nonRefundableRate != null,
    nonRefundableDiscount:
      baseRate > 0 && nonRefundableRate != null
        ? Math.max(0, Math.round((1 - nonRefundableRate / baseRate) * 100))
        : 5,
    nonRefundableCancellationPolicy: "Non-refundable from booking",
    minimumAdvanceDays: 0,
    ratePaymentMethods: null,
    rateDepositSettings: null,
    mealPlan: canonicalPlan?.mealPlan === "breakfast" ? "breakfast" : "room_only",
    mealPlans: [],
    createdAt: "",
    updatedAt: "",
  };
}

export const individualRoomsService = {
  list: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading rooms");
    const response = await pmsOperationsRoomsReadService.listRooms(propertyId);
    return response.items
      .filter((room) => room.status !== "retired")
      .map((room) => toRoom(response, room));
  },

  create: (data: RoomCreate) => manageIndividualRoom("create", data.roomTypeId, data),
  update: (room: Room, data: Partial<RoomCreate>) =>
    manageIndividualRoom("update", room.roomTypeId, data, room),
  delete: (room: Room) => manageIndividualRoom("retire", room.roomTypeId, {}, room),
};

const pendingIndividualRooms = new Map<string, { key: string; expectedRevision: number }>();

async function manageIndividualRoom(
  action: "create" | "update" | "retire",
  roomTypeId: string,
  data: Partial<RoomCreate>,
  room?: Room,
): Promise<void> {
  assertPmsOperationsReadModelEnabled();
  const propertyId = await resolveSelectedPmsPropertyId("managing a physical room");
  if (room && room.hotelId !== propertyId)
    throw new Error("The selected property changed. Reload the rooms.");
  const changes = {
    ...(data.roomNumber !== undefined ? { operationalLabel: data.roomNumber.trim() } : {}),
    ...(data.floor !== undefined ? { floor: data.floor.trim() || null } : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  };
  const fingerprint = JSON.stringify([
    propertyId,
    roomTypeId,
    room?.id,
    room?.roomUnitsRevision,
    action,
    changes,
  ]);
  let pending = pendingIndividualRooms.get(fingerprint);
  if (!pending) {
    let expectedRevision = room?.roomUnitsRevision;
    if (action === "create") {
      const capacity = parseRoomTypeCapacitySnapshot(
        await pmsOperationsClient.get<unknown>(
          `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}/capacity`,
          { ...pmsOperationsRequestOptions, cache: "no-store" },
        ),
      );
      if (!capacity || capacity.propertyId !== propertyId || capacity.roomTypeId !== roomTypeId)
        throw new Error("Room capacity is unavailable. Reload and try again.");
      expectedRevision = capacity.roomUnitsRevision;
    }
    if (!expectedRevision || !Number.isSafeInteger(expectedRevision))
      throw new Error("Room information is out of date. Reload and try again.");
    pending = { key: randomCommandId("pms-physical-room"), expectedRevision };
    pendingIndividualRooms.set(fingerprint, pending);
  }
  const path = `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}/physical-units${room ? `/${encodeURIComponent(room.id)}` : ""}`;
  const body = {
    expectedRevision: pending.expectedRevision,
    ...(action !== "retire" ? { changes } : {}),
  };
  const options = idempotentRequestOptions(pending.key);
  try {
    if (action === "create") await pmsOperationsClient.post(path, body, options);
    else if (action === "update") await pmsOperationsClient.put(path, body, options);
    else await pmsOperationsClient.delete(path, { ...options, body: JSON.stringify(body) });
    pendingIndividualRooms.delete(fingerprint);
  } catch (error) {
    // Definitive rejection permits a refreshed command. Transport ambiguity must replay.
    if (error instanceof ApiErrorResponse && error.status >= 400 && error.status < 500)
      pendingIndividualRooms.delete(fingerprint);
    throw error;
  }
}

export const benefitsService = {
  get: () => unsupportedPmsNextStackFeature<{ benefits: string[] }>("Room benefits"),

  update: (_benefits: string[]) =>
    unsupportedPmsNextStackFeature<{ benefits: string[] }>("Room benefits"),
};

export const roomsService = {
  getPropertyPlan: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading property plan");
    const response = await pmsOperationsRoomsReadService.getPropertyPlan(propertyId);
    return response.propertyPlan;
  },

  list: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading room types");
    const response = await pmsOperationsRoomsReadService.listRoomTypes(propertyId);
    return response.items.map((roomType) => toRoomType(response.propertyId, roomType));
  },

  get: async (id: string) => {
    const propertyId = await resolveSelectedPmsPropertyId("loading room type");
    const response = await pmsOperationsRoomsReadService.getRoomType(propertyId, id);
    return toRoomType(response.propertyId, response.item);
  },

  create: async (data: RoomTypeCreate) => {
    const propertyId = await resolveSelectedPmsPropertyId("creating room type");
    // The same room-facts command as hotel setup; prices are published from the room's Prices tab.
    const facts = roomTypeFactsFromForm(data);
    const amenities = roomAmenityKeys(data.amenities ?? []);
    const location = roomTypeUpdatePayload(data);
    const stagedImages = (data.images ?? []).filter(
      (image): image is Exclude<RoomImageReference, string> & { pendingFile: File } =>
        typeof File !== "undefined" &&
        typeof image !== "string" &&
        image.pendingFile instanceof File,
    );
    const fingerprintParts = ["create", propertyId, facts, amenities, location];
    return runRoomTypeLifecycleCommand(
      fingerprintParts,
      "pms-room-type-create",
      async (commandId) => {
        let roomTypeId: string;
        try {
          roomTypeId = await createRoomTypeFacts(propertyId, commandId, facts);
        } catch (error) {
          // Nothing was created, so the next attempt must not replay this rejection.
          const response = error instanceof Error ? (error.cause ?? error) : error;
          if (
            response instanceof ApiErrorResponse &&
            response.status >= 400 &&
            response.status < 500 &&
            response.data.code !== "command_in_progress"
          ) {
            pendingRoomTypeLifecycleCommands.delete(JSON.stringify(fingerprintParts));
          }
          throw error;
        }
        if (location.locationAddress || location.latitude != null || location.longitude != null) {
          await pmsOperationsRoomsReadService.updateRoomType(propertyId, roomTypeId, location);
        }
        // Confirming, even an empty list, marks the amenities reviewed for room publication.
        await confirmRoomTypeAmenities(
          propertyId,
          roomTypeId,
          `${commandId}:amenities`,
          1,
          amenities,
        );
        await preparePhysicalRooms(propertyId, roomTypeId, facts.name, data.totalRooms);
        const current = await pmsOperationsRoomsReadService.getRoomType(propertyId, roomTypeId);
        let created = toRoomType(current.propertyId, current.item);
        if (stagedImages.length > 0) {
          const existingMediaContinuation = pendingRoomTypeCreateMedia.get(commandId);
          let mediaContinuation: {
            commandId: string;
            images: RoomImageReference[];
          };
          if (existingMediaContinuation) {
            mediaContinuation = existingMediaContinuation;
          } else {
            const uploaded = await uploadService.uploadImages(
              stagedImages.map(({ pendingFile }) => pendingFile),
              pmsRoomMediaResource(propertyId, created.id),
            );
            mediaContinuation = {
              commandId: randomCommandId("pms-room-media"),
              images: uploaded.images.map(({ platformMediaObjectId, url }) => ({
                url,
                platformMediaObjectId,
              })),
            };
            pendingRoomTypeCreateMedia.set(commandId, mediaContinuation);
          }
          if (!sameRoomImageOrder(mediaContinuation.images, created.images)) {
            await replaceRoomTypeMedia(
              propertyId,
              created,
              mediaContinuation.images,
              mediaContinuation.commandId,
            );
            const refreshed = await pmsOperationsRoomsReadService.getRoomType(
              propertyId,
              created.id,
            );
            created = toRoomType(refreshed.propertyId, refreshed.item);
          }
          pendingRoomTypeCreateMedia.delete(commandId);
          stagedImages.forEach(({ url }) => {
            if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
          });
        }
        return created;
      },
    );
  },

  /** Saves what changed against `saved`, the room the form was loaded from, then re-reads it. */
  update: async (
    id: string,
    data: RoomTypeUpdate,
    saved: RoomType,
  ): Promise<RoomTypeSaveResult> => {
    const propertyId = await resolveSelectedPmsPropertyId("updating room type");
    const savedForm = roomTypeUpdateForm(saved);
    const next = { ...savedForm, ...data } as RoomTypeCreate;
    // Check every part before the first write, so a rejected edit saves nothing.
    const facts = roomFactInputsChanged(next, savedForm) ? roomTypeFactsFromForm(next) : null;
    const amenities = roomAmenityInputsChanged(next.amenities ?? [], saved.amenities)
      ? roomAmenityKeys(next.amenities ?? [])
      : null;
    if (data.images) assertRoomImagesUploaded(data.images);
    if (amenities && saved.roomAmenitiesRevision === null) {
      throw new Error("Room amenities are unavailable. Reload the room and try again.");
    }
    const location = changedRoomLocation(next, saved);
    if (facts) await updateRoomTypeFacts(propertyId, id, saved.version, facts);
    if (location) await pmsOperationsRoomsReadService.updateRoomType(propertyId, id, location);
    if (amenities) {
      await confirmRoomTypeAmenities(
        propertyId,
        id,
        randomCommandId("pms-room-amenities"),
        saved.roomAmenitiesRevision!,
        amenities,
      );
    }
    await preparePhysicalRooms(propertyId, id, next.name, data.totalRooms);
    let current = await readRoomType(propertyId, id);
    if (data.images && !sameRoomImageOrder(data.images, current.images)) {
      await replaceRoomTypeMedia(propertyId, current, data.images);
      current = await readRoomType(propertyId, id);
    }
    // Published prices pin room facts and attributes: guests see no offers until republished.
    return { roomType: current, pricesNeedPublishing: facts !== null || location !== null };
  },

  delete: async (id: string) => {
    const propertyId = await resolveSelectedPmsPropertyId("retiring room type");
    const impact = await pmsOperationsRoomsReadService.inspectRoomTypeRetirement(propertyId, id);
    if (!impact.canRetire) throw new RoomTypeRetirementBlockedError(impact);
    await runRoomTypeLifecycleCommand(
      ["retire", propertyId, id, impact.version],
      "pms-room-type-retire",
      (commandId) =>
        pmsOperationsRoomsReadService.retireRoomType(propertyId, id, impact.version, commandId),
    );
  },

  duplicate: async (id: string) => {
    const propertyId = await resolveSelectedPmsPropertyId("duplicating room type");
    const current = await pmsOperationsRoomsReadService.getRoomType(propertyId, id);
    const response = await runRoomTypeLifecycleCommand(
      ["duplicate", propertyId, id, current.item.version],
      "pms-room-type-duplicate",
      (commandId) =>
        pmsOperationsRoomsReadService.duplicateRoomType(
          propertyId,
          id,
          current.item.version,
          commandId,
        ),
    );
    return toRoomType(response.propertyId, response.item);
  },
};

async function createRoomTypeFacts(
  propertyId: string,
  commandId: string,
  facts: RoomTypeFacts,
): Promise<string> {
  let value: unknown;
  try {
    value = await pmsOperationsClient.post<unknown>(
      `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types`,
      { draftRoomId: commandId, expectedRevision: 0, facts },
      idempotentRequestOptions(commandId),
    );
  } catch (error) {
    throw roomFactsCommandError(error);
  }
  const result = parseCreateRoomTypeFactsResult({ ok: true, response: value });
  if (
    !result?.ok ||
    result.response.roomType.propertyId !== propertyId.toLowerCase() ||
    result.response.draftRoomBinding.draftRoomId !== commandId
  ) {
    throw new Error("The room type could not be confirmed. Reload the rooms list and try again.");
  }
  return result.response.roomType.roomTypeId;
}

async function updateRoomTypeFacts(
  propertyId: string,
  roomTypeId: string,
  version: string,
  facts: RoomTypeFacts,
): Promise<void> {
  const revision = /^room-type-facts-v(\d+)$/.exec(version)?.[1];
  if (!revision)
    throw new Error("The room details could not be saved. Reload the room and try again.");
  let value: unknown;
  try {
    value = await pmsOperationsClient.put<unknown>(
      `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}`,
      { expectedRevision: Number(revision), facts },
      idempotentRequestOptions(randomCommandId("pms-room-facts-update")),
    );
  } catch (error) {
    throw roomFactsCommandError(error);
  }
  const result = parseUpdateRoomTypeFactsResult({ ok: true, response: value });
  if (!result?.ok || result.response.roomType.roomTypeId !== roomTypeId.toLowerCase()) {
    throw new Error("The room details could not be confirmed. Reload the room and try again.");
  }
}

function roomFactsCommandError(error: unknown): unknown {
  const code = error instanceof ApiErrorResponse ? error.data.code : undefined;
  const message =
    code === "room_type_name_conflict"
      ? "A room type with this name already exists. Choose another name."
      : code === "unsupported_room_fact_keys"
        ? "This room category or bed type is not supported. Choose another one."
        : code === "room_facts_revision_conflict"
          ? "This room type was changed somewhere else. Reload the room and try again."
          : code === "room_type_not_found"
            ? "This room type is closing or no longer active, so its details can't be changed."
            : null;
  return message ? new Error(message, { cause: error }) : error;
}

async function confirmRoomTypeAmenities(
  propertyId: string,
  roomTypeId: string,
  idempotencyKey: string,
  expectedRoomAmenitiesRevision: number,
  amenities: string[],
): Promise<void> {
  let response: unknown;
  try {
    response = await pmsOperationsClient.put<unknown>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}/amenities`,
      { expectedRoomAmenitiesRevision, amenities },
      idempotentRequestOptions(idempotencyKey),
    );
  } catch (error) {
    if (
      error instanceof ApiErrorResponse &&
      error.data.code === "room_amenities_revision_conflict"
    ) {
      throw new Error(
        "This room's amenities were changed somewhere else. Reload the room and try again.",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (!parseConfirmRoomTypeAmenitiesResult({ ok: true, response })?.ok) {
    throw new Error("Room amenities could not be confirmed. Reload the room and try again.");
  }
}

async function readRoomType(propertyId: string, roomTypeId: string): Promise<RoomType> {
  const response = await pmsOperationsRoomsReadService.getRoomType(propertyId, roomTypeId);
  return toRoomType(response.propertyId, response.item);
}

function changedRoomLocation(next: RoomTypeUpdate, saved: RoomType): RoomTypeUpdate | null {
  const location: RoomTypeUpdate = {};
  if ((next.locationAddress || "") !== (saved.locationAddress || "")) {
    location.locationAddress = next.locationAddress || "";
  }
  if ((next.latitude ?? null) !== saved.latitude) location.latitude = next.latitude ?? null;
  if ((next.longitude ?? null) !== saved.longitude) location.longitude = next.longitude ?? null;
  return Object.keys(location).length > 0 ? location : null;
}

function assertRoomImagesUploaded(images: RoomImageReference[]): void {
  const pending = images.some((image) => {
    if (typeof image !== "string" && image.platformMediaObjectId) return false;
    const url = imageReferenceUrl(image).trim();
    return !url || url.startsWith("blob:");
  });
  if (pending) {
    throw new Error("Every saved room photo must finish uploading before the room can be saved.");
  }
}

async function preparePhysicalRooms(
  propertyId: string,
  roomTypeId: string,
  roomTypeName: string,
  targetActiveUnitCount: number | undefined,
): Promise<void> {
  if (!Number.isInteger(targetActiveUnitCount) || targetActiveUnitCount! < 1) return;
  const expectedPropertyId = propertyId.toLowerCase();
  const expectedRoomTypeId = roomTypeId.toLowerCase();
  const setupPath = `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}`;
  const capacity = parseRoomTypeCapacitySnapshot(
    await pmsOperationsClient.get<unknown>(`${setupPath}/capacity`, pmsOperationsRequestOptions),
  );
  if (
    !capacity ||
    capacity.propertyId !== expectedPropertyId ||
    capacity.roomTypeId !== expectedRoomTypeId
  ) {
    throw new Error("Physical room capacity is unavailable. Reload the room and try again.");
  }
  let revision = capacity.roomUnitsRevision;
  if (capacity.activeUnitCount !== targetActiveUnitCount) {
    const response = await pmsOperationsClient.put<unknown>(
      `${setupPath}/physical-units/reconcile`,
      { expectedRevision: revision, targetActiveUnitCount },
      commandOptions("pms-room-unit-reconcile"),
    );
    const result = parseReconcilePhysicalRoomUnitsResult({ ok: true, response });
    if (
      !result?.ok ||
      result.response.propertyId !== expectedPropertyId ||
      result.response.roomTypeId !== expectedRoomTypeId ||
      result.response.capacity.activeUnitCount !== targetActiveUnitCount ||
      result.response.capacity.roomUnitsRevision !== revision + 1
    ) {
      throw new Error("Physical rooms could not be reconciled. Reload the room and try again.");
    }
    revision = result.response.capacity.roomUnitsRevision;
  }

  const value = await pmsOperationsClient.get<unknown>(`${setupPath}/units`, {
    ...pmsOperationsRequestOptions,
    cache: "no-store",
  });
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) {
    throw new Error("Physical room labels are unavailable. Reload the room and try again.");
  }
  const units = (value as { items: unknown[] }).items.map(parsePhysicalRoomUnitIdentity);
  if (
    units.some(
      (unit) =>
        !unit || unit.propertyId !== expectedPropertyId || unit.roomTypeId !== expectedRoomTypeId,
    )
  ) {
    throw new Error("Physical room labels are unavailable. Reload the room and try again.");
  }
  const activeUnits = units.filter((unit) => unit?.lifecycle === "active");
  if (activeUnits.length !== targetActiveUnitCount) {
    throw new Error("Physical room capacity changed. Reload the room and try again.");
  }
  const usedLabels = new Set(
    units.flatMap((unit) => (unit?.operationalLabel ? [unit.operationalLabel.toLowerCase()] : [])),
  );
  for (let index = 0; index < activeUnits.length; index += 1) {
    const unit = activeUnits[index]!;
    if (!unit || unit.operationalLabelStatus === "verified") continue;
    let operationalLabel =
      unit.operationalLabel ?? unusedGeneratedRoomLabel(roomTypeName, index + 1, usedLabels);
    let response: unknown;
    while (true) {
      try {
        response = await pmsOperationsClient.put<unknown>(
          `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(roomTypeId)}/physical-units/${encodeURIComponent(unit.roomUnitId)}/operational-label`,
          { expectedRevision: revision, operationalLabel },
          commandOptions("pms-room-operational-label"),
        );
        break;
      } catch (error) {
        if (
          unit.operationalLabel !== null ||
          !(error instanceof ApiErrorResponse) ||
          error.data.code !== "operational_label_conflict"
        ) {
          throw error;
        }
        usedLabels.add(operationalLabel.toLowerCase());
        operationalLabel = unusedGeneratedRoomLabel(roomTypeName, index + 1, usedLabels);
      }
    }
    const result = parseSetPhysicalRoomOperationalLabelResult({ ok: true, response });
    if (
      !result?.ok ||
      result.response.propertyId !== expectedPropertyId ||
      result.response.roomTypeId !== expectedRoomTypeId ||
      result.response.roomUnitId !== unit.roomUnitId ||
      result.response.operationalLabel !== operationalLabel ||
      result.response.operationalLabelStatus !== "verified" ||
      result.response.roomUnitsRevision !== revision + 1
    ) {
      throw new Error("Physical room labels could not be verified. Reload the room and try again.");
    }
    usedLabels.add(operationalLabel.toLowerCase());
    revision = result.response.roomUnitsRevision;
  }
}

function unusedGeneratedRoomLabel(
  roomTypeName: string,
  initialPosition: number,
  usedLabels: ReadonlySet<string>,
): string {
  for (let position = initialPosition; ; position += 1) {
    const suffix = ` ${position}`;
    const candidate = `${roomTypeName.trim().slice(0, 200 - suffix.length)}${suffix}`;
    if (!usedLabels.has(candidate.toLowerCase())) return candidate;
  }
}

function commandOptions(prefix: string) {
  return idempotentRequestOptions(randomCommandId(prefix));
}

function idempotentRequestOptions(commandId: string): RequestInit {
  return {
    ...pmsOperationsRequestOptions,
    headers: {
      ...(pmsOperationsRequestOptions.headers as Record<string, string>),
      "Idempotency-Key": commandId,
    },
  };
}

export class RoomTypeRetirementBlockedError extends Error {
  constructor(readonly impact: RoomTypeRetirementImpact) {
    super(
      `Room type cannot be retired yet. ${impact.blockers
        .map(({ affectedCount, action }) => `${affectedCount} affected: ${action}`)
        .join(" ")}`,
    );
    this.name = "RoomTypeRetirementBlockedError";
  }
}

export const pmsOperationsRoomsReadService = {
  getPropertyPlan: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsPropertyPlanResponse>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/plan-limits`,
      pmsOperationsRequestOptions,
    );
  },

  listRooms: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoom>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/rooms`,
      pmsOperationsRequestOptions,
    );
  },

  listRoomTypes: (propertyId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
      pmsOperationsRequestOptions,
    );
  },

  getRoomType: (propertyId: string, roomTypeId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<PmsOperationsDetailResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}`,
      pmsOperationsRequestOptions,
    );
  },

  duplicateRoomType: (
    propertyId: string,
    roomTypeId: string,
    expectedVersion: string,
    commandId: string,
  ) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.post<PmsOperationsCommandResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}/duplicate`,
      { commandId, idempotencyKey: commandId, expectedVersion },
      pmsOperationsRequestOptions,
    );
  },

  inspectRoomTypeRetirement: (propertyId: string, roomTypeId: string) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.get<RoomTypeRetirementImpact>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}/retirement-impact`,
      pmsOperationsRequestOptions,
    );
  },

  retireRoomType: (
    propertyId: string,
    roomTypeId: string,
    expectedVersion: string,
    commandId: string,
  ) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.delete<
      RoomTypeRetirementImpact & {
        commandMeta: PmsOperationsCommandMeta;
      }
    >(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}`,
      {
        ...pmsOperationsRequestOptions,
        body: JSON.stringify({ commandId, idempotencyKey: commandId, expectedVersion }),
      },
    );
  },

  updateRoomType: (propertyId: string, roomTypeId: string, data: RoomTypeUpdate) => {
    assertPmsOperationsReadModelEnabled();
    const commandId = randomCommandId("pms-room-type-update");
    return pmsOperationsClient.patch<PmsOperationsCommandResponse<PmsOperationsRoomType>>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}`,
      {
        ...roomTypeUpdatePayload(data),
        commandId,
        idempotencyKey: commandId,
      },
      pmsOperationsRequestOptions,
    );
  },

  replaceRoomTypeMedia: (
    propertyId: string,
    roomTypeId: string,
    expectedRoomMediaRevision: number,
    assignments: { mediaObjectId: string; altText: string | null; sortOrder: number }[],
    legacyMediaSnapshot?: {
      mediaObjectId: string | null;
      url: string;
      altText: string | null;
      sortOrder: number;
    }[],
    commandId = randomCommandId("pms-room-media"),
  ) => {
    assertPmsOperationsReadModelEnabled();
    return pmsOperationsClient.put<{
      propertyId: string;
      roomTypeId: string;
      roomMediaRevision: number;
    }>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(
        roomTypeId,
      )}/media`,
      {
        expectedRoomMediaRevision,
        assignments,
        ...(legacyMediaSnapshot ? { legacyMediaSnapshot } : {}),
      },
      {
        ...pmsOperationsRequestOptions,
        headers: {
          ...(pmsOperationsRequestOptions.headers as Record<string, string>),
          "Idempotency-Key": commandId,
        },
      },
    );
  },
};

const pendingLinkedInventoryCommands = new Map<string, string>();
const pendingRoomTypeLifecycleCommands = new Map<string, string>();
const pendingRoomTypeCreateMedia = new Map<
  string,
  {
    commandId: string;
    images: RoomImageReference[];
  }
>();

async function runRoomTypeLifecycleCommand<T>(
  fingerprintParts: unknown[],
  prefix: string,
  request: (commandId: string) => Promise<T>,
): Promise<T> {
  const fingerprint = JSON.stringify(fingerprintParts);
  const commandId = pendingRoomTypeLifecycleCommands.get(fingerprint) ?? randomCommandId(prefix);
  pendingRoomTypeLifecycleCommands.set(fingerprint, commandId);
  const response = await request(commandId);
  pendingRoomTypeLifecycleCommands.delete(fingerprint);
  return response;
}

export const linkedInventoryGroupsService = {
  list: async (): Promise<LinkedInventoryGroup[]> => {
    assertPmsOperationsReadModelEnabled();
    const propertyId = await resolveSelectedPmsPropertyId("loading linked inventory groups");
    const response = await pmsOperationsClient.get<LinkedInventoryGroupsResponse>(
      linkedInventoryGroupsEndpoint(propertyId),
      pmsOperationsRequestOptions,
    );
    return response.items;
  },

  create: async (name: string, memberRoomTypeIds: string[]): Promise<LinkedInventoryGroup> => {
    const propertyId = await resolveSelectedPmsPropertyId("creating linked inventory group");
    return runLinkedInventoryCommand(
      ["create", propertyId, name.trim(), [...memberRoomTypeIds].sort()],
      "pms-linked-inventory-create",
      async (commandId) => {
        const response = await pmsOperationsClient.post<LinkedInventoryGroupCommandResponse>(
          linkedInventoryGroupsEndpoint(propertyId),
          { commandId, idempotencyKey: commandId, name, memberRoomTypeIds },
          pmsOperationsRequestOptions,
        );
        return response.group!;
      },
    );
  },

  update: async (group: LinkedInventoryGroup): Promise<LinkedInventoryGroup> => {
    const propertyId = await resolveSelectedPmsPropertyId("updating linked inventory group");
    return runLinkedInventoryCommand(
      [
        "update",
        propertyId,
        group.groupId,
        group.revision,
        group.name.trim(),
        [...group.memberRoomTypeIds].sort(),
      ],
      "pms-linked-inventory-update",
      async (commandId) => {
        const response = await pmsOperationsClient.put<LinkedInventoryGroupCommandResponse>(
          `${linkedInventoryGroupsEndpoint(propertyId)}/${encodeURIComponent(group.groupId)}`,
          {
            commandId,
            idempotencyKey: commandId,
            expectedRevision: group.revision,
            name: group.name,
            memberRoomTypeIds: group.memberRoomTypeIds,
          },
          pmsOperationsRequestOptions,
        );
        return response.group!;
      },
    );
  },

  delete: async (group: LinkedInventoryGroup): Promise<void> => {
    const propertyId = await resolveSelectedPmsPropertyId("deleting linked inventory group");
    await runLinkedInventoryCommand(
      ["delete", propertyId, group.groupId, group.revision],
      "pms-linked-inventory-delete",
      async (commandId) => {
        await pmsOperationsClient.delete<LinkedInventoryGroupCommandResponse>(
          `${linkedInventoryGroupsEndpoint(propertyId)}/${encodeURIComponent(group.groupId)}`,
          {
            ...pmsOperationsRequestOptions,
            body: JSON.stringify({
              commandId,
              idempotencyKey: commandId,
              expectedRevision: group.revision,
            }),
          },
        );
      },
    );
  },
};

async function runLinkedInventoryCommand<T>(
  fingerprintParts: unknown[],
  prefix: string,
  request: (commandId: string) => Promise<T>,
): Promise<T> {
  const fingerprint = JSON.stringify(fingerprintParts);
  const commandId = pendingLinkedInventoryCommands.get(fingerprint) ?? randomCommandId(prefix);
  pendingLinkedInventoryCommands.set(fingerprint, commandId);
  const response = await request(commandId);
  pendingLinkedInventoryCommands.delete(fingerprint);
  return response;
}

function linkedInventoryGroupsEndpoint(propertyId: string): string {
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/linked-inventory-groups`;
}

async function replaceRoomTypeMedia(
  propertyId: string,
  roomType: RoomType,
  images: RoomImageReference[],
  commandId?: string,
): Promise<void> {
  const assignments = images
    .filter(
      (image): image is Exclude<RoomImageReference, string> & { platformMediaObjectId: string } =>
        typeof image !== "string" && Boolean(image.platformMediaObjectId),
    )
    .map((image, sortOrder) => ({
      mediaObjectId: image.platformMediaObjectId,
      altText: image.altText?.trim() || null,
      sortOrder,
    }));
  const hasLegacyMedia = assignments.length !== images.length;
  const legacyMediaSnapshot = hasLegacyMedia
    ? images.map((image, sortOrder) => ({
        mediaObjectId: typeof image === "string" ? null : (image.platformMediaObjectId ?? null),
        url: imageReferenceUrl(image),
        altText: typeof image === "string" ? null : image.altText?.trim() || null,
        sortOrder,
      }))
    : undefined;
  if (
    legacyMediaSnapshot?.some(({ url }) => {
      const resolvedUrl = url.trim();
      return !resolvedUrl || resolvedUrl.startsWith("blob:");
    })
  ) {
    throw new Error("Every saved room photo must finish uploading before the room can be saved.");
  }
  await pmsOperationsRoomsReadService.replaceRoomTypeMedia(
    propertyId,
    roomType.id,
    roomType.roomMediaRevision,
    assignments,
    legacyMediaSnapshot,
    commandId,
  );
}

function sameRoomImageOrder(left: RoomImageReference[], right: RoomImageReference[]): boolean {
  const keys = (images: RoomImageReference[]) =>
    images.map((image) =>
      typeof image !== "string" && image.platformMediaObjectId
        ? `media:${image.platformMediaObjectId}`
        : `url:${imageReferenceUrl(image)}`,
    );
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}

function roomTypeUpdatePayload(data: RoomTypeUpdate) {
  const payload: RoomTypeUpdate = {};
  if (Object.hasOwn(data, "locationAddress")) payload.locationAddress = data.locationAddress;
  if (Object.hasOwn(data, "latitude")) payload.latitude = data.latitude ?? null;
  if (Object.hasOwn(data, "longitude")) payload.longitude = data.longitude ?? null;
  return payload;
}

export function roomTypeUpdateForm(r: RoomType): RoomTypeUpdate {
  return {
    ...r,
    category: r.category || "",
    bedrooms: r.bedrooms ?? 1,
    bathrooms: r.bathrooms ?? 1,
    // The form shows one king bed when a room has none; start from what it shows.
    bedType: r.bedType || "1 King Bed",
    locationAddress: r.locationAddress || "",
  };
}

function randomCommandId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
