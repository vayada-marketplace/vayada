import { describe, expect, it } from "vitest";

import { guestProfileEdit, withBookerEdit } from "./guestProfileEdit";

const shown = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "" };

describe("guestProfileEdit", () => {
  it("sends only the fields staff changed, trimmed", () => {
    expect(guestProfileEdit(shown, shown)).toEqual({});
    expect(guestProfileEdit(shown, { ...shown, lastName: " King ", phone: "+43 1 234" })).toEqual({
      lastName: "King",
      phone: "+43 1 234",
    });
  });

  it("clears an emptied email or phone", () => {
    expect(guestProfileEdit(shown, { ...shown, email: "  " })).toEqual({ email: null });
  });

  it("ignores whitespace-only changes", () => {
    expect(guestProfileEdit(shown, { ...shown, firstName: "Ada " })).toEqual({});
  });
});

describe("withBookerEdit", () => {
  it("shows the edited values on the booking and keeps the rest", () => {
    const booking = {
      id: "b1",
      guestFirstName: "Ada",
      guestLastName: "Lovelace",
      guestEmail: "ada@example.com",
      guestPhone: "+431234567",
    };
    expect(withBookerEdit(booking, { lastName: "King", email: null })).toEqual({
      ...booking,
      guestLastName: "King",
      guestEmail: "",
    });
  });
});
