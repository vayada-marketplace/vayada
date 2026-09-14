import { expect, it } from "vitest";
import {
  readChannexAlterationNightlyPrices,
  type ChannexAlterationNightlyPriceScope,
} from "./channexAlterationNightlyPrices.js";

const providerPropertyId = "82000000-0000-4000-8000-000000000001";
const providerBookingId = "82000000-0000-4000-8000-000000000002";
const providerRoomTypeId = "82000000-0000-4000-8000-000000000003";
const roomTypeId = "82000000-0000-4000-8000-000000000004";
const expected: ChannexAlterationNightlyPriceScope = {
  revisionId: "revision-2",
  providerPropertyId,
  providerBookingId,
  currency: "EUR",
  checkIn: "2026-09-01",
  checkOut: "2026-09-03",
  rooms: [{ providerRoomTypeId, roomTypeId }],
};
const make = (days: unknown = { "2026-09-01": "100.25", "2026-09-02": "0.00" }) => ({
  id: expected.revisionId,
  property_id: providerPropertyId,
  booking_id: providerBookingId,
  status: "modified",
  currency: "EUR",
  arrival_date: expected.checkIn,
  departure_date: expected.checkOut,
  amount: "9999",
  customer: { name: "PRIVATE GUEST" },
  rooms: [
    {
      room_type_id: providerRoomTypeId,
      days,
      amount: "200",
      services: [{ total_price: "30" }],
      taxes: [{ is_inclusive: false, total_price: "10" }],
    },
  ],
});

it("reads only provider nightly prices and validated local positions from flat and JSONAPI revisions", () => {
  const raw = make();
  const lines = [
    { roomTypeId, linePosition: 1, stayDate: "2026-09-01", providerNightlyAmount: "100.25" },
    { roomTypeId, linePosition: 1, stayDate: "2026-09-02", providerNightlyAmount: "0.00" },
  ];
  expect(readChannexAlterationNightlyPrices(raw, expected)).toEqual(lines);
  expect(
    readChannexAlterationNightlyPrices({ data: { id: raw.id, attributes: raw } }, expected),
  ).toEqual(lines);
  expect(JSON.stringify(lines)).not.toContain("PRIVATE GUEST");
});

it.each([undefined, null, {}, { "2026-09-01": null }])(
  "preserves missing prices (%j) without spreading totals",
  (days) => {
    const raw = make();
    raw.rooms[0]!.days = days;
    expect(
      readChannexAlterationNightlyPrices(raw, expected).map((line) => line.providerNightlyAmount),
    ).toEqual([null, null]);
  },
);

it.each([12, "-1", "NaN", "1e2", "1.12345", "1000000000000000", " 12 ", {}, []])(
  "rejects malformed supplied nightly amounts (%j)",
  (value) => {
    expect(() =>
      readChannexAlterationNightlyPrices(make({ "2026-09-01": value }), expected),
    ).toThrow("alteration_revision_nightly_prices_invalid");
  },
);

it.each([
  { property_id: roomTypeId },
  { booking_id: roomTypeId },
  { id: "old-revision" },
  { currency: "USD" },
  { status: "canceled" },
  { arrival_date: "2026-09-02" },
  { departure_date: "2026-09-04" },
  { rooms: [] },
  { rooms: [{ room_type_id: roomTypeId }] },
  { rooms: [{ room_type_id: providerRoomTypeId, checkin_date: "2026-08-31" }] },
  { rooms: [{ room_type_id: providerRoomTypeId, checkout_date: "2026-09-04" }] },
])("rejects mismatched identity and stay scope (%j)", (override) => {
  expect(() => readChannexAlterationNightlyPrices({ ...make(), ...override }, expected)).toThrow(
    "alteration_revision_nightly_prices_invalid",
  );
});

it.each(["2026-08-31", "2026-09-03", "2026-02-30", "0000-01-01"])(
  "rejects invalid or extra date %s",
  (day) => {
    expect(() => readChannexAlterationNightlyPrices(make({ [day]: "1" }), expected)).toThrow(
      "alteration_revision_nightly_prices_invalid",
    );
  },
);

it("keeps repeated room types in distinct positions and enforces the writer's line bound", () => {
  const raw = make();
  raw.rooms.push({ ...raw.rooms[0]!, days: { "2026-09-01": "25" } });
  const scope = { ...expected, rooms: [...expected.rooms, ...expected.rooms] };
  expect(
    readChannexAlterationNightlyPrices(raw, scope).map((line) => [
      line.linePosition,
      line.providerNightlyAmount,
    ]),
  ).toEqual([
    [1, "100.25"],
    [1, "0.00"],
    [2, "25"],
    [2, null],
  ]);
  for (const checkOut of [expected.checkIn, "2026-08-31", "2030-01-01"])
    expect(() =>
      readChannexAlterationNightlyPrices(
        { ...raw, departure_date: checkOut },
        { ...scope, checkOut },
      ),
    ).toThrow("alteration_revision_nightly_prices_invalid");
});
