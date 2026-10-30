import { describe, expect, it } from "vitest";
import type { GuestFields } from "@/services/guests";
import { guestForm, guestFormChanges } from "./guestEdit";

const fields: GuestFields = {
  firstName: "Timo",
  lastName: "Schreyer",
  email: "t.schreyer@example.test",
  phone: "+49 157 35490950",
  countryCode: "DE",
  dateOfBirth: "1990-04-02",
  documentType: "passport",
  documentNumber: "C01X00T47",
};

describe("guest profile edit (VAY-2420)", () => {
  it("shows the date of birth as typed at check-in", () => {
    expect(guestForm(fields).dateOfBirth).toBe("02 / 04 / 1990");
    expect(guestForm({ ...fields, email: null }).email).toBe("");
  });

  it("sends only what changed, and an emptied field as null", () => {
    const shown = guestForm(fields);
    expect(guestFormChanges(shown, shown, "2026-10-30")).toEqual({});
    expect(
      guestFormChanges(
        shown,
        {
          ...shown,
          lastName: " King ",
          phone: "",
          documentType: "",
          dateOfBirth: "03 / 04 / 1990",
        },
        "2026-10-30",
      ),
    ).toEqual({ lastName: "King", phone: null, documentType: null, dateOfBirth: "1990-04-03" });
  });

  it("refuses a date of birth that isn't a real date", () => {
    const shown = guestForm(fields);
    expect(guestFormChanges(shown, { ...shown, dateOfBirth: "31 / 02 / 1990" }, "2026-10-30")).toBe(
      "invalid_birth_date",
    );
    expect(guestFormChanges(shown, { ...shown, dateOfBirth: "" }, "2026-10-30")).toEqual({
      dateOfBirth: null,
    });
  });
});
