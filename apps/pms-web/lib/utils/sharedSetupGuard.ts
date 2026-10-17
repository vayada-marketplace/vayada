import {
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import {
  SELECTED_PMS_PROPERTY_ID_KEY,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/pmsPropertySelectionKeys";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PmsSetupGuardOptions = {
  propertyId?: string | null;
};
// Booking Admin hosts the shared hotel setup wizard (VAY-2261).
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export async function resolvePmsSetupGuard(
  returnTo: string,
  api: Pick<SharedHotelSetupApi, "getStatus"> = sharedHotelSetupApi,
  storage: HotelSelectionStorage | null = browserStorage(),
  setupBaseUrl = BOOKING_ADMIN_URL,
  options: PmsSetupGuardOptions = {},
): Promise<SharedHotelSetupGuardDecision> {
  const explicitPropertyId = options.propertyId?.trim() || null;
  const decision = await resolveSharedHotelSetupGuard(api, {
    entryProduct: "pms",
    returnProduct: "pms",
    returnTo,
    setupBaseUrl,
    propertyId: explicitPropertyId ?? readSelectedSharedPropertyId(storage),
    onInvalidPropertyId: () => storage?.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY),
    fallbackOnInvalidPropertyId: !explicitPropertyId,
  });
  persistEnteredSharedProperty(decision, storage);
  return decision;
}

export function persistEnteredSharedProperty(
  decision: SharedHotelSetupGuardDecision,
  storage: HotelSelectionStorage | null = browserStorage(),
): void {
  if (decision.action === "enter_product") {
    storage?.setItem(SELECTED_PMS_PROPERTY_ID_KEY, decision.propertyId);
    storage?.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, decision.propertyId);
  }
}

export function readSelectedSharedPropertyId(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): string | null {
  const value = storage?.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim();
  return value || null;
}

function browserStorage(): HotelSelectionStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
