import { type BookingGuestPolicyReadPort } from "@vayada/domain-booking";
import type {
  PmsPricingReadPort,
  PmsRecurringPricingReadPort,
  RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

import type {
  PmsManualBookingAvailabilityReadPort,
  PmsOperationsReadRepository,
} from "../domains/pmsOperationsReadModel.js";
import type { BookingAddonItemsRepository } from "./bookingAddonItems.js";

export type ManualBookingMoney = { amountDecimal: string; currency: string };
type ManualBookingStayBase = {
  position: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};
export type ManualBookingStay = ManualBookingStayBase &
  (
    | {
        ratePlanId: string;
        pricing: { kind: "rate_plan"; manualOverride: ManualBookingMoney | null };
      }
    | { ratePlanId: null; pricing: { kind: "custom"; nightlyAmount: ManualBookingMoney } }
  );
export type ManualBookingAddonSelection = {
  addonId: string;
  packageCount: number;
  serviceUnits: { serviceDate: string | null; guestCount: number | null }[];
};
export type ManualBookingPreviewCommand = {
  contractVersion: "pms-manual-booking.v1";
  stays: ManualBookingStay[];
  addOns: ManualBookingAddonSelection[];
};
export type PmsManualBookingPreviewRoutesOptions = {
  pms: Pick<PmsOperationsReadRepository, "listRoomsByPropertyId" | "listRoomTypesByPropertyId"> &
    PmsManualBookingAvailabilityReadPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot"> &
    Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  roomPublication: Pick<RoomPublicationSnapshotPort, "getRoomPublicationSnapshot">;
  booking: Pick<BookingAddonItemsRepository, "listAddonItemsByHotelId"> &
    Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
};

export async function calculateManualBookingPreview(
  scope: { propertyId: string; organizationId: string },
  command: ManualBookingPreviewCommand,
  ports: PmsManualBookingPreviewRoutesOptions,
): Promise<{
  contractVersion: "pms-manual-booking.v1";
  currency: import("@vayada/domain-pms").PmsPricingCurrency;
  stays: {
    position: number;
    roomId: string;
    ratePlanId: string | null;
    nightly: {
      serviceDate: string;
      standard: ManualBookingMoney | null;
      applied: ManualBookingMoney;
    }[];
    standardTotal: ManualBookingMoney | null;
    appliedTotal: ManualBookingMoney;
  }[];
  addOns: {
    addonId: string;
    pricingModel: import("./bookingAddonItems.js").BookingAddonPricingModel;
    unitPrice: ManualBookingMoney;
    packageCount: number;
    serviceUnits: { serviceDate: string | null; guestCount: number | null }[];
    total: ManualBookingMoney;
  }[];
  grandTotal: ManualBookingMoney;
}> {
  throw Object.assign(
    new Error("Pricing is unavailable while the TypeScript pricing system is rebuilt."),
    { statusCode: 503, code: "PRICING_UNAVAILABLE" },
  );
}

export type ManualBookingPreviewResult = Awaited<ReturnType<typeof calculateManualBookingPreview>>;

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
