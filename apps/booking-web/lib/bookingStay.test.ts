import { expect, it } from "vitest";
import { parseBookingStay, placeAddress, placeDirectionsUrl } from "./bookingStay";

const terms = {
  kind: "flexible",
  terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: 1 },
};
const response = {
  version: "booking-stay.v1",
  cancellation: {
    checkIn: "2026-11-06",
    currency: "USD",
    timeZone: "Asia/Colombo",
    totalMinor: "20000",
    rooms: [
      {
        selectionId: "s1",
        roomTypeId: "r1",
        roomName: "Suite",
        cancellation: terms,
        subtotalMinor: "20000",
      },
    ],
  },
  places: [
    {
      kind: "property",
      rooms: ["Suite"],
      streetAddress: "12 Matara Road",
      area: null,
      postalCode: "80650",
      city: "Ahangama",
      countryCode: "LK",
      pin: { latitude: 5.973251, longitude: 80.362548 },
      arrivalDirections: null,
    },
    {
      kind: "elsewhere",
      rooms: ["Villa"],
      address: "Beach Rd 1",
      pin: null,
      area: null,
      approximate: false,
    },
    { kind: "somewhere" },
  ],
};

it("reads the booked terms and places of a stay (VAY-2360)", () => {
  const stay = parseBookingStay(response);
  expect(stay.cancellation).toEqual({
    checkIn: "2026-11-06",
    currency: "USD",
    timeZone: "Asia/Colombo",
    totalMinor: "20000",
    rooms: [{ roomName: "Suite", cancellation: terms, subtotalMinor: "20000" }],
  });
  expect(stay.places.map((place) => place.kind)).toEqual(["property", "elsewhere"]);
  expect(placeAddress(stay.places[0]!, "en")).toBe("12 Matara Road, 80650 Ahangama, Sri Lanka");
  expect(placeAddress(stay.places[0]!, "de")).toBe("12 Matara Road, 80650 Ahangama, Sri Lanka");
  expect(placeDirectionsUrl(stay.places[0]!, null)).toBe(
    "https://www.google.com/maps/dir/?api=1&destination=5.973251,80.362548",
  );
  // Without a pin, directions look the address up.
  expect(placeDirectionsUrl(stay.places[1]!, "Beach Rd 1")).toBe(
    "https://www.google.com/maps/dir/?api=1&destination=Beach%20Rd%201",
  );
});

it("reads the extras a stay can ask for, its latest request and what we accepted (VAY-2360 part 3)", () => {
  const offer = {
    addonId: "a1",
    name: "Breakfast",
    pricingModel: "per_guest_night",
    unitMinor: "1200",
    amountMinor: "2400",
    currency: "EUR",
  };
  const stay = parseBookingStay({
    ...response,
    extras: {
      offered: [offer, { ...offer, addonId: "a2", amountMinor: "-1" }],
      request: {
        id: "r1",
        status: "pending",
        items: [offer],
        totalMinor: "2400",
        currency: "EUR",
        createdAt: "2026-10-25T10:00:00.000Z",
      },
      accepted: [{ ...offer, addonId: "a3", name: "Airport transfer" }, { name: "broken" }],
    },
  });
  expect(stay.extras?.offered).toEqual([offer]);
  expect(stay.extras?.request).toMatchObject({ id: "r1", status: "pending", items: [offer] });
  expect(stay.extras?.accepted).toEqual([{ ...offer, addonId: "a3", name: "Airport transfer" }]);
  expect(parseBookingStay(response).extras).toBeNull();
  // An older API without the accepted list reads as nothing accepted.
  expect(
    parseBookingStay({ ...response, extras: { offered: [offer], request: null } }).extras,
  ).toEqual({ offered: [offer], request: null, accepted: [] });
});

it("drops terms it can't trust and anything from another version", () => {
  const broken = (rooms: unknown) =>
    parseBookingStay({ ...response, cancellation: { ...response.cancellation, rooms } })
      .cancellation;
  expect(broken([])).toBeNull();
  expect(broken([{ cancellation: terms, subtotalMinor: "-1" }])).toBeNull();
  expect(
    broken([{ cancellation: { kind: "flexible", terms: {} }, subtotalMinor: "1" }]),
  ).toBeNull();
  expect(
    parseBookingStay({ ...response, cancellation: { ...response.cancellation, totalMinor: 200 } })
      .cancellation,
  ).toBeNull();
  expect(parseBookingStay({ ...response, version: "booking-stay.v2" })).toEqual({
    cancellation: null,
    places: [],
    extras: null,
  });
  expect(parseBookingStay("<!doctype html>")).toEqual({
    cancellation: null,
    places: [],
    extras: null,
  });
  // A zone this browser doesn't know would break the page's dates.
  expect(
    parseBookingStay({
      ...response,
      cancellation: { ...response.cancellation, timeZone: "Mars/Base" },
    }).cancellation,
  ).toBeNull();
});

it("reads terms saved without a type as free cancellation, as the server does", () => {
  const untyped = { kind: "flexible", terms: { freeCancellationDeadlineDays: 3 } };
  expect(
    parseBookingStay({
      ...response,
      cancellation: {
        ...response.cancellation,
        rooms: [{ ...response.cancellation.rooms[0], cancellation: untyped }],
      },
    }).cancellation?.rooms[0]?.cancellation,
  ).toEqual(untyped);
});
