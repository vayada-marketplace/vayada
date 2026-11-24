import { describe, expect, it, vi } from "vitest";

import {
  chooseLinkedPmsProperty,
  linkedPmsPropertyId,
  withoutLinkedPmsProperty,
} from "./linkedProperty";

// VAY-2099: the booking request email links `/bookings/<id>?property=<id>`, so a login with several
// hotels opens the booking under the hotel it belongs to.
const ALPENROSE = "f6853000-0000-4000-8000-000000000001";
const DEWARI = "f6853000-0000-4000-8000-000000002451";

function deps(stored: string | null, list: () => Promise<{ id: string }[]>) {
  return { stored: () => stored, list: vi.fn(list), store: vi.fn() };
}

describe("chooseLinkedPmsProperty", () => {
  it("chooses the linked hotel when the login has it", async () => {
    const d = deps(DEWARI, async () => [{ id: DEWARI }, { id: ALPENROSE }]);
    await chooseLinkedPmsProperty(`/bookings/booking-1?property=${ALPENROSE}`, d);
    expect(d.store).toHaveBeenCalledWith(ALPENROSE);
  });

  it("chooses it when the login has no hotel chosen yet", async () => {
    const d = deps(null, async () => [{ id: DEWARI }, { id: ALPENROSE }]);
    await chooseLinkedPmsProperty(`/bookings/booking-1?property=${ALPENROSE}`, d);
    expect(d.store).toHaveBeenCalledWith(ALPENROSE);
  });

  it("keeps the current hotel for a hotel the login doesn't have", async () => {
    const d = deps(DEWARI, async () => [{ id: DEWARI }]);
    await chooseLinkedPmsProperty(`/bookings/booking-1?property=${ALPENROSE}`, d);
    expect(d.store).not.toHaveBeenCalled();
  });

  it("asks nothing when the link names no hotel, or the one already chosen", async () => {
    for (const path of ["/bookings/booking-1", `/bookings/booking-1?property=${ALPENROSE}`]) {
      const d = deps(ALPENROSE, async () => [{ id: ALPENROSE }]);
      await chooseLinkedPmsProperty(path, d);
      expect(d.list).not.toHaveBeenCalled();
      expect(d.store).not.toHaveBeenCalled();
    }
  });

  it("keeps the current hotel when the hotel list can't load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps(DEWARI, async () => {
      throw new Error("offline");
    });
    await expect(
      chooseLinkedPmsProperty(`/bookings/booking-1?property=${ALPENROSE}`, d),
    ).resolves.toBeUndefined();
    expect(d.store).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the link's hotel in the path", () => {
  it("reads it", () => {
    expect(linkedPmsPropertyId(`/bookings/b?property=%20${ALPENROSE}%20`)).toBe(ALPENROSE);
    expect(linkedPmsPropertyId("/bookings/b?property=")).toBeNull();
    expect(linkedPmsPropertyId("/bookings/b")).toBeNull();
  });

  it("drops only the hotel and keeps the rest of the path", () => {
    expect(withoutLinkedPmsProperty(`/bookings/b?property=${ALPENROSE}`)).toBe("/bookings/b");
    expect(
      withoutLinkedPmsProperty(`/bookings/b?confirm=payment&property=${ALPENROSE}#notes`),
    ).toBe("/bookings/b?confirm=payment#notes");
  });
});
