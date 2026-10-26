import { describe, expect, it } from "vitest";
import type { CheckinSettings } from "@/services/settings";
import { checkinStepSummaries, guestFieldCounts, setGuestField } from "./checkinSettings";

const defaults: CheckinSettings = {
  showSpecialRequest: true,
  confirmSpecialRequest: true,
  allowRoomChanges: true,
  allowIncompleteGuests: true,
  guestNotes: true,
  registrationScope: "adults",
  guestFields: [
    { field: "email", show: true, required: false },
    { field: "phone", show: true, required: false },
    { field: "documentType", show: true, required: true },
    { field: "documentNumber", show: true, required: true },
    { field: "nationality", show: true, required: true },
    { field: "dateOfBirth", show: true, required: true },
    { field: "gender", show: false, required: false },
  ],
  offerAddons: true,
  addonIds: null,
  settlementOptions: ["card", "cash", "bank_transfer", "at_checkout", "already_paid"],
  paymentChoiceRequired: true,
  keyHandover: "physical",
};

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.values(params).join(",")})` : key;

describe("Settings → Check-in helpers (VAY-2374)", () => {
  it("counts first and last name as required and the design's defaults as 6/2/1", () => {
    expect(guestFieldCounts(defaults)).toEqual({ required: 6, optional: 2, hidden: 1 });
  });

  it("hides a field together with its Required, and requiring a field shows it", () => {
    const hidden = setGuestField(defaults, "documentNumber", { show: false });
    expect(hidden.guestFields[3]).toEqual({
      field: "documentNumber",
      show: false,
      required: false,
    });
    const required = setGuestField(defaults, "gender", { required: true });
    expect(required.guestFields[6]).toEqual({ field: "gender", show: true, required: true });
    expect(guestFieldCounts(required)).toEqual({ required: 7, optional: 2, hidden: 0 });
  });

  it("summarises each step for the flow overview", () => {
    expect(checkinStepSummaries(defaults, 4, 2, t)).toEqual([
      "settings.checkIn.summary.requestConfirmed",
      "settings.checkIn.summary.requiredFields(6)",
      "settings.checkIn.summary.addonsOffered(4)",
      "settings.checkIn.summary.physicalKeys(2)",
    ]);
    expect(
      checkinStepSummaries(
        { ...defaults, showSpecialRequest: false, offerAddons: false, keyHandover: "none" },
        4,
        0,
        t,
      ),
    ).toEqual([
      "settings.checkIn.summary.noRequest",
      "settings.checkIn.summary.requiredFields(6)",
      "settings.checkIn.summary.addonsOff",
      "settings.checkIn.summary.noKeys(0)",
    ]);
  });
});
