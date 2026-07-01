import { getScopedBookingHotelIds } from "../auth/sessionStore";

type HotelScopeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function listScopedBookingHotelIds(): string[] {
  return getScopedBookingHotelIds();
}

export function getSelectedBookingHotelId(
  storage: HotelScopeStorage | null = browserStorage(),
): string | null {
  const selected = storage?.getItem("selectedHotelId")?.trim() || null;
  const scopedHotelIds = listScopedBookingHotelIds();

  if (scopedHotelIds.length === 0) {
    if (selected) storage?.removeItem("selectedHotelId");
    return null;
  }
  if (selected && scopedHotelIds.includes(selected)) return selected;
  if (scopedHotelIds.length === 1) {
    storage?.setItem("selectedHotelId", scopedHotelIds[0]!);
    return scopedHotelIds[0]!;
  }

  if (selected) storage?.removeItem("selectedHotelId");
  return null;
}

export function requireSelectedBookingHotelId(): string {
  const hotelId = getSelectedBookingHotelId();
  if (!hotelId) throw new Error("Select a property before continuing.");
  return hotelId;
}

function browserStorage(): HotelScopeStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
