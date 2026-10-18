import type { SetupTrack } from "@vayada/domain-hotels";

import {
  parseSharedHotelSetupEntryProduct,
  safeSharedHotelSetupReturnTo,
  type SharedHotelSetupEntryProduct,
} from "./sharedFirstRunSetupFlow";

const PMS_SETUP_EXIT_STATUS = "incomplete";
const PMS_SETUP_EXIT_ORIGIN = "https://pms.vayada.com";

export type SetupExitSurface = "pms-web" | "booking-admin" | "marketplace-web";
export type SetupExitTarget = { surface: SetupExitSurface; path: string };

/** The dashboard (or property picker) path PMS and Booking Admin show a "resume setup" banner on. */
export function pmsSetupExitPath(propertyId?: string | null): string {
  const selectedPropertyId = propertyId?.trim();
  if (!selectedPropertyId) return `/choose-property?setup=${PMS_SETUP_EXIT_STATUS}`;

  const query = new URLSearchParams({
    setup: PMS_SETUP_EXIT_STATUS,
    propertyId: selectedPropertyId,
  });
  return `/dashboard?${query.toString()}`;
}

/**
 * Where "Exit setup" lands: back in the product the hotel came from (VAY-2249).
 * Booking Admin and PMS get their dashboard with a resume banner; Marketplace gets
 * its own return path. A Marketplace entry without the Creator Marketplace track
 * goes to PMS, because the Marketplace guard would send it straight back to setup.
 */
export function setupExitTarget(input: {
  query: string;
  propertyId: string | null;
  defaultProduct: SharedHotelSetupEntryProduct;
  selectedTracks?: readonly SetupTrack[] | null;
}): SetupExitTarget {
  const params = new URLSearchParams(input.query);
  const returnProduct = parseSharedHotelSetupEntryProduct(params.get("returnProduct"));
  if (params.get("recovery") === "pms-calendar" && returnProduct === "pms") {
    return {
      surface: "pms-web",
      path: safeSharedHotelSetupReturnTo(params.get("returnTo"), "/settings#calendar"),
    };
  }
  const product =
    returnProduct ??
    parseSharedHotelSetupEntryProduct(params.get("entryProduct")) ??
    input.defaultProduct;
  if (product === "booking") {
    return { surface: "booking-admin", path: pmsSetupExitPath(input.propertyId) };
  }
  const hasMarketplaceTrack =
    !input.selectedTracks || input.selectedTracks.includes("creator_marketplace");
  if (product === "marketplace" && hasMarketplaceTrack) {
    return {
      surface: "marketplace-web",
      path:
        returnProduct === "marketplace"
          ? safeSharedHotelSetupReturnTo(params.get("returnTo"), "/marketplace")
          : "/marketplace",
    };
  }
  return { surface: "pms-web", path: pmsSetupExitPath(input.propertyId) };
}

export function isPmsSetupExitPath(path: string): boolean {
  try {
    const url = new URL(path, PMS_SETUP_EXIT_ORIGIN);
    if (url.origin !== PMS_SETUP_EXIT_ORIGIN) return false;
    if (url.searchParams.get("setup") !== PMS_SETUP_EXIT_STATUS) return false;
    if (url.pathname === "/choose-property") return true;
    return url.pathname === "/dashboard" && Boolean(pmsSetupExitPropertyId(path));
  } catch {
    return false;
  }
}

/** Reads the property from a dashboard setup-exit path (PMS and Booking Admin use the same shape). */
export function pmsSetupExitPropertyId(path: string): string | null {
  try {
    const url = new URL(path, PMS_SETUP_EXIT_ORIGIN);
    if (url.origin !== PMS_SETUP_EXIT_ORIGIN) return null;
    if (url.pathname !== "/dashboard" || url.searchParams.get("setup") !== PMS_SETUP_EXIT_STATUS) {
      return null;
    }
    return url.searchParams.get("propertyId")?.trim() || null;
  } catch {
    return null;
  }
}
