import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), canRead: true }));
vi.mock("@/services/settings/guestRules", () => ({ guestRulesService: { load: mocks.load } }));
vi.mock("./PmsAccessContext", () => ({
  useHasPmsPermission: (permission: string) =>
    permission === "booking.settings.manage" && mocks.canRead,
}));

import { forgetGuestStayTimes, useGuestStayTimes, type GuestStayTimes } from "./useGuestStayTimes";

const rules = (checkInTime: string, checkOutTime: string) => ({
  revision: "6d1c3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e",
  choices: { checkInTime, checkOutTime },
});

async function readTimes() {
  let times: GuestStayTimes | null | undefined;
  function Probe() {
    times = useGuestStayTimes();
    return null;
  }
  await act(async () => {
    create(createElement(Probe));
  });
  return times;
}

describe("useGuestStayTimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetGuestStayTimes();
    mocks.canRead = true;
  });

  it("gives the times guests see on the booking page", async () => {
    mocks.load.mockResolvedValue(rules("14:00", "10:30"));
    await expect(readTimes()).resolves.toEqual({ checkInTime: "14:00", checkOutTime: "10:30" });
  });

  it("gives no time while the property has none or the read fails", async () => {
    mocks.load.mockResolvedValueOnce(null);
    await expect(readTimes()).resolves.toBeNull();
    forgetGuestStayTimes();
    mocks.load.mockRejectedValueOnce(new Error("forbidden"));
    await expect(readTimes()).resolves.toBeNull();
  });

  it("reads once a minute for every screen, again after a save, and never keeps a failed read", async () => {
    mocks.load.mockRejectedValueOnce(new Error("offline"));
    await expect(readTimes()).resolves.toBeNull();
    mocks.load.mockResolvedValue(rules("15:00", "11:00"));
    await readTimes();
    await expect(readTimes()).resolves.toEqual({ checkInTime: "15:00", checkOutTime: "11:00" });
    expect(mocks.load).toHaveBeenCalledTimes(2);
    forgetGuestStayTimes();
    mocks.load.mockResolvedValue(rules("15:00", "10:00"));
    await expect(readTimes()).resolves.toEqual({ checkInTime: "15:00", checkOutTime: "10:00" });
    expect(mocks.load).toHaveBeenCalledTimes(3);
  });

  it("never asks for them without booking.settings.manage, which the API requires", async () => {
    mocks.canRead = false;
    await expect(readTimes()).resolves.toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
