import { describe, expect, it } from "vitest";
import { guestChanges } from "./guestAutosave";

const saved = {
  firstName: "Grace",
  lastName: "Hopper",
  email: "grace@example.com",
  phone: "",
  nationality: "US",
  assignmentId: "assignment_2",
  dateOfBirth: "1906-12-09",
  documentType: "",
  documentNumber: "",
  gender: "",
  staffNotes: "",
};

describe("guest autosave changes (VAY-2418)", () => {
  it("finds nothing to save when only blanks around a value changed", () => {
    expect(guestChanges(saved, { ...saved, firstName: " Grace " })).toEqual({
      contact: [],
      registration: false,
    });
  });

  it("sends only the changed contact fields to the guest list", () => {
    expect(guestChanges(saved, { ...saved, phone: "+1 555 0100", nationality: "GB" })).toEqual({
      contact: ["phone", "nationality"],
      registration: false,
    });
  });

  it("saves the registration when an ID field, the notes or the room change", () => {
    for (const change of [
      { documentNumber: "C01X00T47" },
      { dateOfBirth: "" },
      { staffNotes: "Vegetarian" },
      { assignmentId: "assignment_1" },
      { assignmentId: null },
    ])
      expect(guestChanges(saved, { ...saved, ...change })).toEqual({
        contact: [],
        registration: true,
      });
  });
});
