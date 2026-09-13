import { describe, expect, it } from "vitest";
import {
  bindPublicPricingSelection,
  parsePublicPricingSelection,
} from "./publicPricingSelection.js";
import { parseReplacementStay, replacementStayKey } from "./replacementPricingEvidence.js";
const person = (index = 0) => ({ selectionId: "room", kind: "child", index });
const input = () => ({
  version: "public-pricing-selection.v2",
  checkIn: "2026-10-01",
  checkOut: "2026-10-04",
  currency: "EUR",
  rooms: [
    {
      selectionId: "room",
      publicOfferKey: "offer",
      guests: { adults: 2, childAgesAtCheckIn: [4, 12] },
    },
  ],
  addons: [
    {
      version: "addon-selection.v2",
      id: "tour",
      quantity: 1,
      dates: ["2026-10-02"],
      people: [person()],
    },
  ],
  promoCode: null,
});
const bind = (v: unknown) =>
  bindPublicPricingSelection(v, "property", [
    { propertyId: "property", publicOfferKey: "offer", roomTypeId: "type", offerId: "rate" },
  ]);
describe("selected add-on participants", () => {
  it("preserves selected allocation references through public binding and saved stay decoding", () => {
    const request = input();
    request.rooms.push({ ...request.rooms[0], selectionId: "second" });
    request.addons[0].people.push({ selectionId: "second", kind: "adult", index: 1 });
    const stay = bind(request)!;
    expect(stay).not.toBeNull();
    expect(parseReplacementStay(JSON.parse(JSON.stringify(stay)))).toEqual(stay);
    request.addons[0].people[0].index = 1;
    expect(stay.addons[0].people?.[0].index).toBe(0);
    expect(bind({ ...input(), addons: [{ ...input().addons[0], people: null }] })).not.toBeNull();
  });
  it("rejects foreign, duplicate, missing, out-of-range and malformed participants", () => {
    for (const people of [
      [],
      [person(), person()],
      [{ ...person(), selectionId: "foreign" }],
      [person(2)],
      [person(-1)],
      [person(0.5)],
      [{ ...person(), kind: "adult", index: 2 }],
      [{ ...person(), kind: "infant" }],
      [{ ...person(), age: 4 }],
      new Array(1),
      Array.from({ length: 100 }, (_, i) => person(i)),
    ])
      expect(bind({ ...input(), addons: [{ ...input().addons[0], people }] })).toBeNull();
    expect(bind({ ...input(), addons: [{ id: "tour", quantity: 1, dates: null }] })).toBeNull();
    expect(bind({ ...input(), version: "public-pricing-selection.v1" })).toBeNull();
    expect(
      bind({ ...input(), addons: [{ ...input().addons[0], version: "addon-selection.v3" }] }),
    ).toBeNull();
    for (const dates of [[], ["2026-09-30"], ["2026-10-05"], ["2026-10-02", "2026-10-02"]])
      expect(
        parsePublicPricingSelection({ ...input(), addons: [{ ...input().addons[0], dates }] }),
      ).toBeNull();
  });
  it("binds selected guests and ordered child ages while retaining historical v1 keys", () => {
    const request = input();
    request.addons[0].people.push(person(1));
    const stay = bind(request)!,
      key = replacementStayKey(stay);
    expect(
      replacementStayKey(
        bind({
          ...request,
          addons: [{ ...request.addons[0], people: [...request.addons[0].people].reverse() }],
        })!,
      ),
    ).toBe(key);
    expect(
      replacementStayKey(
        bind({ ...request, addons: [{ ...request.addons[0], people: [person(1)] }] })!,
      ),
    ).not.toBe(key);
    const swapped = {
      ...request,
      rooms: [{ ...request.rooms[0], guests: { adults: 2, childAgesAtCheckIn: [12, 4] } }],
    };
    expect(replacementStayKey(bind(swapped)!)).not.toBe(key);
    const old = {
      ...request,
      version: "public-pricing-selection.v1",
      addons: [{ id: "tour", quantity: 1, dates: null }],
    };
    const oldStay = bind(old)!;
    expect(replacementStayKey(oldStay)).toBe(
      replacementStayKey(bind({ ...old, rooms: swapped.rooms })!),
    );
    expect(parseReplacementStay(JSON.parse(JSON.stringify(oldStay)))).toEqual(oldStay);
  });
});
