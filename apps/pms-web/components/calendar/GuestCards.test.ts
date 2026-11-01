import { describe, expect, it } from "vitest";

import { guestMissingName, guestSlots } from "./GuestCards";

describe("guestSlots", () => {
  it("lists room by room, adults before children, after the lead guest", () => {
    const slots = guestSlots([
      { key: 1, adults: 2, childAges: ["4"] },
      { key: 7, adults: 1, childAges: ["", ""] },
    ]);
    expect(slots.map(({ id, number }) => `${number}:${id}`)).toEqual([
      "2:1:a1",
      "3:1:c0",
      "4:7:a0",
      "5:7:c0",
      "6:7:c1",
    ]);
    expect(slots[1]).toMatchObject({ stayIndex: 0, child: 0 });
  });

  it("ignores a count that isn't a whole number and stops at the API's 100 guests", () => {
    expect(guestSlots([{ key: 1, adults: 2.5, childAges: [] }])).toEqual([]);
    expect(guestSlots([{ key: 1, adults: 500, childAges: [] }])).toHaveLength(100);
  });
});

describe("guestMissingName", () => {
  const draft = (firstName: string, lastName: string, countryCode = "") => ({
    firstName,
    lastName,
    countryCode,
  });

  it("is fine empty or with both names", () => {
    expect(guestMissingName(undefined)).toBeNull();
    expect(guestMissingName(draft(" ", ""))).toBeNull();
    expect(guestMissingName(draft("Grace", "Hopper", "US"))).toBeNull();
  });

  it("names what a started card still needs", () => {
    expect(guestMissingName(draft("Grace", " "))).toBe("lastName");
    expect(guestMissingName(draft("", "Hopper"))).toBe("firstName");
    expect(guestMissingName(draft("", "", "US"))).toBe("firstName");
  });
});
