import { describe, expect, it } from "vitest";

import { expectedGuestCount, guestRegistered, registeredGuestCount } from "./guestRegistration";

describe("guest registration counts (VAY-2373)", () => {
  it("counts a guest as registered with both names, whatever else is missing", () => {
    expect(guestRegistered({ firstName: "Laura", lastName: "Borsch" })).toBe(true);
    expect(guestRegistered({ firstName: "Laura", lastName: " " })).toBe(false);
    expect(guestRegistered({ firstName: "", lastName: "Borsch" })).toBe(false);
    expect(guestRegistered({})).toBe(false);
  });

  it("expects everyone staying and never fewer than the booker", () => {
    expect(expectedGuestCount({ numberOfGuests: 4, adults: 2, children: 0 })).toBe(4);
    expect(expectedGuestCount({ numberOfGuests: null, adults: 2, children: 1 })).toBe(3);
    expect(expectedGuestCount({ numberOfGuests: null, adults: 0, children: 0 })).toBe(1);
  });

  it("counts the booker and the named additional guests", () => {
    const booking = { guestFirstName: "Timo", guestLastName: "Schreyer" };
    const guests = [
      { firstName: "Laura", lastName: "Borsch" },
      { firstName: "Guest", lastName: "" },
    ];
    expect(registeredGuestCount(booking, guests)).toBe(2);
    expect(registeredGuestCount({ guestFirstName: "", guestLastName: "" }, guests)).toBe(1);
    expect(registeredGuestCount(booking, [])).toBe(1);
  });
});
