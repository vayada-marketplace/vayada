import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activePayoutDestination,
  payoutDetailsValid,
  readPayoutDestination,
  removePayoutDestination,
  savePayoutDestination,
} from "./financePayoutDestinationClient";

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("./client", () => ({ apiClient: { get, put } }));

const details = {
  accountHolder: "  PT Lumbung Ubud  ",
  accountNumber: "8730 1122 6789",
  bankName: "BCA",
  bankCode: "014",
  branchCode: "",
  bicSwift: "",
  holderAddress: "",
};
const removed = {
  id: "d1",
  revision: 2,
  version: 3,
  enabled: false,
  deleted: true,
  countryCode: "ID",
  maskedAccount: null,
};

describe("vayada Payment payout account (VAY-2442 P6)", () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue({ destination: { ...removed, version: 4 } });
    get.mockReset();
  });

  it("needs holder, bank, the country's code and an account number of 6+ characters", () => {
    expect(payoutDetailsValid("ID", details)).toBe(true);
    expect(payoutDetailsValid("ID", { ...details, accountHolder: " " })).toBe(false);
    expect(payoutDetailsValid("ID", { ...details, bankName: "" })).toBe(false);
    expect(payoutDetailsValid("ID", { ...details, accountNumber: "12-3 45" })).toBe(false);
    expect(payoutDetailsValid("ID", { ...details, accountNumber: "8730/1122" })).toBe(false);
    // Indonesian banks need a bank code, Sri Lankan ones a branch code.
    expect(payoutDetailsValid("ID", { ...details, bankCode: " " })).toBe(false);
    expect(payoutDetailsValid("LK", details)).toBe(false);
    expect(payoutDetailsValid("LK", { ...details, branchCode: "7010" })).toBe(true);
  });

  it("saves against the latest revision, removed ones included, with trimmed details", async () => {
    await savePayoutDestination({
      propertyId: " hotel-1 ",
      commandId: "c1",
      countryCode: "ID",
      details: { ...details, branchCode: "left over" },
      saved: removed,
    });
    expect(put).toHaveBeenCalledWith("/api/finance/properties/hotel-1/payout-destination", {
      action: "replace",
      commandId: "c1",
      expectedVersion: 3,
      countryCode: "ID",
      // Only the code the country uses goes out.
      details: { ...details, accountHolder: "PT Lumbung Ubud", branchCode: "" },
    });
    await savePayoutDestination({
      propertyId: "hotel-1",
      commandId: "c2",
      countryCode: "LK",
      details: { ...details, branchCode: "7010" },
      saved: null,
    });
    expect(put.mock.calls[1][1]).toMatchObject({
      expectedVersion: 0,
      countryCode: "LK",
      details: { bankCode: "", branchCode: "7010" },
    });
  });

  it("shows only an account payouts go to, and removes it by its version", async () => {
    get.mockResolvedValue({ destination: removed });
    expect(activePayoutDestination(await readPayoutDestination("hotel-1"))).toBeNull();
    const active = { ...removed, enabled: true, deleted: false, maskedAccount: "•••• 6789" };
    expect(activePayoutDestination(active)).toBe(active);
    // The removed revision comes back: its version is what the next save expects.
    await expect(
      removePayoutDestination({ propertyId: "hotel-1", commandId: "c3", saved: active }),
    ).resolves.toMatchObject({ version: 4 });
    expect(put).toHaveBeenCalledWith("/api/finance/properties/hotel-1/payout-destination", {
      action: "delete",
      commandId: "c3",
      expectedVersion: 3,
    });
  });
});
