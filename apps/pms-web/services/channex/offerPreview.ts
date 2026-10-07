import { pricingObject, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";

export type OfferPreviewResult =
  | { kind: "preview"; currency: string; meal: string; occupancies: number[]; primary: number }
  | { kind: "unsupported"; reason: "child_representation_unavailable" | "candidate_limit" };

export async function requestOfferProvisioning(
  propertyId: string,
  room: PricingConfiguration,
  offerId: string,
  primary: number,
): Promise<{ operationId: string }> {
  const offer = room.offers.find((offer) => offer.id === offerId);
  if (
    room.propertyId !== propertyId ||
    !offer ||
    !Number.isSafeInteger(primary) ||
    primary < 1 ||
    primary > Math.min(room.capacity.adults, 100)
  )
    throw new Error("Invalid provisioning selection");
  const commandId = globalThis.crypto?.randomUUID?.();
  const idempotencyKey = globalThis.crypto?.randomUUID?.();
  if (!commandId || !idempotencyKey) throw new Error("Secure request IDs are unavailable.");
  const value = await pmsOperationsClient.post<unknown>(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/channex/published-offers/provision`,
    {
      commandId,
      idempotencyKey,
      roomTypeId: room.roomTypeId,
      offerId,
      publicationRevision: room.revision,
      primaryOccupancy: primary,
    },
    pmsOperationsRequestOptions,
  );
  if (!pricingObject(value) || typeof value.operationId !== "string" || !value.operationId.trim())
    throw new Error("The provisioning request could not be verified. Try again.");
  return { operationId: value.operationId };
}

export async function readOfferPreview(
  propertyId: string,
  room: PricingConfiguration,
  offerId: string,
  primary: number,
): Promise<OfferPreviewResult> {
  const selection = {
    roomTypeId: room.roomTypeId,
    offerId,
    publicationRevision: String(room.revision),
    primaryOccupancy: String(primary),
  };
  const offer = room.offers.find((offer) => offer.id === offerId);
  if (
    room.propertyId !== propertyId ||
    !offer ||
    !Number.isSafeInteger(primary) ||
    primary < 1 ||
    primary > Math.min(room.capacity.adults, 100)
  )
    throw new Error("Invalid preview selection");
  const value = await pmsOperationsClient.get<unknown>(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/channex/offer-preview?${new URLSearchParams(selection)}`,
    pmsOperationsRequestOptions,
  );
  const invalid = () => {
    throw new Error("The preview could not be verified. Try again.");
  };
  if (
    !pricingObject(value) ||
    value.schemaVersion !== 1 ||
    value.propertyId !== propertyId ||
    value.roomTypeId !== room.roomTypeId ||
    value.offerId !== offerId ||
    value.publicationRevision !== room.revision ||
    value.primaryOccupancy !== primary ||
    value.canSend !== false ||
    value.canProvision !== false
  )
    return invalid();
  if (
    value.kind === "unsupported" &&
    (value.reason === "child_representation_unavailable" || value.reason === "candidate_limit")
  )
    return { kind: "unsupported", reason: value.reason };
  const config = value.configuration;
  if (
    value.kind !== "preview" ||
    !pricingObject(config) ||
    config.currency !== room.currency ||
    config.meal_type !== offer.meal.kind ||
    !Array.isArray(config.options) ||
    config.options.length !== room.capacity.adults ||
    config.options.length > 100 ||
    !config.options.every(
      (option: unknown, i: number) =>
        pricingObject(option) &&
        option.occupancy === i + 1 &&
        option.is_primary === (i + 1 === primary),
    )
  )
    return invalid();
  return {
    kind: "preview",
    currency: room.currency,
    meal: offer.meal.kind.replaceAll("_", " "),
    occupancies: Array.from({ length: config.options.length }, (_, i) => i + 1),
    primary,
  };
}
