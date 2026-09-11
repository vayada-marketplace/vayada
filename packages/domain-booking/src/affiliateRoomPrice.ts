import {
  createBookingPriceSnapshotInput,
  type BookingPriceSnapshotFactoryInput,
  type BookingPriceSnapshotInput,
} from "./bookingPriceSnapshotInput.js";

export type AffiliateRoomPriceResult =
  | {
      status: "pending";
      reason:
        | "price_evidence_unavailable"
        | "item_allocation_required"
        | "additional_guest_classification_required";
    }
  | {
      status: "classified_price";
      basis: "room_price_only";
      organizationId: string;
      propertyId: string;
      roomTypeId: string;
      currency: string;
      scale: 2;
      accommodationPriceMinor: string;
      source: BookingPriceSnapshotInput;
    };

/** Pure price component extraction from trusted owner factory inputs. Recalculates
 * via the existing versioned producer rather than trusting supplied total fields.
 * No booking acceptance, canonical item mapping, extras completeness, payment,
 * refunds, attribution or earning is established by this result.
 */
export function classifyAffiliateRoomPrice(
  input: BookingPriceSnapshotFactoryInput,
): AffiliateRoomPriceResult {
  const source = createBookingPriceSnapshotInput(input);
  if (!source) return { status: "pending", reason: "price_evidence_unavailable" };
  if (source.calculation.roomCount !== 1)
    return { status: "pending", reason: "item_allocation_required" };
  if (source.additionalGuestDisclosure.kind !== "not_applied")
    return { status: "pending", reason: "additional_guest_classification_required" };
  // v1 factory requires exact mandatory-charge confirmation and explicit zero taxes/fees.
  // Its final total already includes seasonal/weekend prices and selected rate discount.
  return Object.freeze({
    status: "classified_price",
    basis: "room_price_only",
    organizationId: source.organizationId,
    propertyId: source.propertyId,
    roomTypeId: source.calculation.roomTypeId,
    currency: source.calculation.currency,
    scale: source.calculation.scale,
    accommodationPriceMinor: source.totals.priceTotalMinorUnits,
    source,
  });
}
