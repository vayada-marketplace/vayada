import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureHotelAccountInviteCode,
  clearPendingHotelAccountInvite,
  HOTEL_ACCOUNT_INVITE_STORAGE_KEY,
  hasPendingHotelAccountInvite,
  hotelAccountInviteEntryProduct,
  hotelAccountInviteSetupPath,
  pendingHotelAccountInviteCode,
  storeHotelAccountInviteCode,
} from "./hotelAccountInvites";

describe("hotel account invites", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enters PMS setup for PMS-only invitations and booking setup otherwise", () => {
    expect(hotelAccountInviteEntryProduct(["hotel_operations"])).toBe("pms");
    expect(hotelAccountInviteEntryProduct(["hotel_operations", "creator_marketplace"])).toBe(
      "booking",
    );
    expect(hotelAccountInviteSetupPath(["hotel_operations"])).toBe(
      "/setup?entryProduct=pms&returnProduct=pms",
    );
    expect(hotelAccountInviteSetupPath(["hotel_operations", "creator_marketplace"])).toBe(
      "/setup?entryProduct=booking&returnProduct=booking",
    );
    expect(hotelAccountInviteSetupPath([])).toBe(
      "/setup?entryProduct=booking&returnProduct=booking",
    );
  });

  it("takes the code from the URL fragment, keeps it in session storage and scrubs the URL", () => {
    const storage = new Map<string, string>();
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { hash: "#code=VAY-browser-invite-1050", pathname: "/invite", search: "" },
      history: { replaceState },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });

    expect(captureHotelAccountInviteCode()).toBe("VAY-browser-invite-1050");
    expect(storage.get(HOTEL_ACCOUNT_INVITE_STORAGE_KEY)).toBe("VAY-browser-invite-1050");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/invite");
    expect(pendingHotelAccountInviteCode()).toBe("VAY-browser-invite-1050");

    expect(storeHotelAccountInviteCode("  not a code ")).toBeNull();
    expect(storeHotelAccountInviteCode(" VAY-typed-code-77 ")).toBe("VAY-typed-code-77");
    expect(hasPendingHotelAccountInvite()).toBe(true);
    clearPendingHotelAccountInvite();
    expect(pendingHotelAccountInviteCode()).toBeNull();
    expect(hasPendingHotelAccountInvite()).toBe(false);
  });
});
