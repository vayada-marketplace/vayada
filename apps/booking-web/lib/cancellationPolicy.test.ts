import { expect, it } from "vitest";
import type { PublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { cancellationPolicy, policyBlocks, roomShares } from "./cancellationPolicy";

type Cancellation = PublicBookingQuote["rooms"][number]["cancellation"];
const free = (days: number) =>
  ({
    kind: "flexible",
    terms: { flexibleCancellationType: "free", freeCancellationDeadlineDays: days },
  }) as unknown as Cancellation;
const partial = (tiers: { minDaysBeforeCheckIn: number; refundPercent: number }[]) =>
  ({
    kind: "flexible",
    terms: { flexibleCancellationType: "partial_refund", partialRefundTiers: tiers },
  }) as unknown as Cancellation;
const instant = { request: false, card: false };
const full = { kind: "full", amountMinor: "17500" } as const;
const noShow = { when: { kind: "noShow" }, pay: full, now: false, ended: false };

it("dates free cancellation while it is open (VAY-2347)", () => {
  expect(
    cancellationPolicy(free(3), { checkIn: "2026-11-06", today: "2026-10-25" }, "17500", instant),
  ).toEqual({
    badge: { kind: "freeUntil", date: "2026-11-03" },
    tone: "ok",
    rows: [
      {
        when: { kind: "untilEnd", date: "2026-11-03" },
        pay: { kind: "free" },
        now: true,
        ended: false,
      },
      { when: { kind: "from", date: "2026-11-04" }, pay: full, now: false, ended: false },
      noShow,
    ],
    note: { kind: "freeUntil", date: "2026-11-03" },
    request: false,
  });
});

it("never promises free cancellation once its deadline has passed", () => {
  // Booked on 25 Oct for the next night: free until 3 days before arrival ended on 23 Oct.
  const policy = cancellationPolicy(
    free(3),
    { checkIn: "2026-10-26", today: "2026-10-25" },
    "17500",
    instant,
  );
  expect(policy.badge).toEqual({ kind: "freeEnded" });
  expect(policy.tone).toBe("amber");
  expect(policy.rows).toEqual([
    { when: { kind: "until", date: "2026-10-23" }, pay: { kind: "free" }, now: false, ended: true },
    { when: { kind: "fromNow" }, pay: full, now: true, ended: false },
    noShow,
  ]);
  expect(policy.note).toEqual({ kind: "freeEnded", date: "2026-10-23" });
  // The deadline day itself still counts, as on the server.
  expect(
    cancellationPolicy(free(3), { checkIn: "2026-10-28", today: "2026-10-25" }, "1", instant).badge,
  ).toEqual({ kind: "freeUntil", date: "2026-10-25" });
});

it("charges the full amount from booking on a non-refundable rate", () => {
  const policy = cancellationPolicy(
    { kind: "non_refundable" },
    { checkIn: "2026-11-06", today: "2026-10-25" },
    "17500",
    instant,
  );
  expect(policy.badge).toEqual({ kind: "nonRefundable" });
  expect(policy.rows).toEqual([
    { when: { kind: "fromBooking" }, pay: full, now: true, ended: false },
    noShow,
  ]);
});

it("dates each partial refund step and marks the one that applies today", () => {
  const policy = cancellationPolicy(
    partial([
      { minDaysBeforeCheckIn: 14, refundPercent: 100 },
      { minDaysBeforeCheckIn: 7, refundPercent: 50 },
    ]),
    { checkIn: "2026-11-06", today: "2026-10-25" },
    "17500",
    instant,
  );
  expect(policy.rows).toEqual([
    {
      when: { kind: "untilEnd", date: "2026-10-23" },
      pay: { kind: "free" },
      now: false,
      ended: true,
    },
    {
      when: { kind: "between", from: "2026-10-24", until: "2026-10-30" },
      pay: { kind: "part", percent: 50, amountMinor: "8750" },
      now: true,
      ended: false,
    },
    { when: { kind: "from", date: "2026-10-31" }, pay: full, now: false, ended: false },
    noShow,
  ]);
  expect(policy.badge).toEqual({ kind: "refundsUntil", date: "2026-10-30" });
  expect(policy.note).toEqual({ kind: "partial", date: "2026-10-30" });
});

it("keeps a 0% step between refunds, so a later refund doesn't read as applying earlier", () => {
  const policy = cancellationPolicy(
    partial([
      { minDaysBeforeCheckIn: 30, refundPercent: 100 },
      { minDaysBeforeCheckIn: 14, refundPercent: 0 },
      { minDaysBeforeCheckIn: 7, refundPercent: 50 },
      { minDaysBeforeCheckIn: 1, refundPercent: 0 },
    ]),
    { checkIn: "2026-12-10", today: "2026-10-25" },
    "10000",
    instant,
  );
  expect(policy.rows.map((row) => [row.when, row.pay.kind])).toEqual([
    [{ kind: "untilEnd", date: "2026-11-10" }, "free"],
    [{ kind: "between", from: "2026-11-11", until: "2026-11-26" }, "full"],
    [{ kind: "between", from: "2026-11-27", until: "2026-12-03" }, "part"],
    // The trailing 0% step is the "from" row.
    [{ kind: "from", date: "2026-12-04" }, "full"],
    [{ kind: "noShow" }, "full"],
  ]);
});

it("lets a request be withdrawn for free before the hotel accepts", () => {
  const card = cancellationPolicy(
    free(3),
    { checkIn: "2026-10-26", today: "2026-10-25" },
    "17500",
    { request: true, card: true },
  );
  expect(card.badge).toEqual({ kind: "notRefundableOnceAccepted" });
  expect(card.rows).toEqual([
    { when: { kind: "beforeAccept" }, pay: { kind: "freeHoldReleased" }, now: true, ended: false },
    { when: { kind: "until", date: "2026-10-23" }, pay: { kind: "free" }, now: false, ended: true },
    { when: { kind: "afterAccept" }, pay: full, now: false, ended: false },
    noShow,
  ]);
  const hotel = cancellationPolicy(
    free(3),
    { checkIn: "2026-11-06", today: "2026-10-25" },
    "17500",
    { request: true, card: false },
  );
  // Free cancellation is still open, so the rate's own badge stays.
  expect(hotel.badge).toEqual({ kind: "freeUntil", date: "2026-11-03" });
  expect(hotel.rows[0]).toEqual({
    when: { kind: "beforeAccept" },
    pay: { kind: "freeNothingCharged" },
    now: true,
    ended: false,
  });
  expect(hotel.rows.filter((row) => row.now)).toHaveLength(1);
});

const quote = (
  rooms: { id: string; cancellation: Cancellation; minor: string }[],
  totalMinor: string,
  extra: PublicBookingQuote["lines"] = [],
) =>
  ({
    checkIn: "2026-11-06",
    paymentMethod: "pay_at_property",
    acceptanceMode: "instant",
    totalMinor,
    lines: [
      ...rooms.map((room) => ({ kind: "room", selectionId: room.id, amountMinor: room.minor })),
      ...extra,
    ],
    rooms: rooms.map((room) => ({ selectionId: room.id, cancellation: room.cancellation })),
  }) as unknown as PublicBookingQuote;

it("shares the total out by each room's own lines, as the server does", () => {
  const q = quote(
    [
      { id: "a", cancellation: free(3), minor: "17500" },
      { id: "b", cancellation: { kind: "non_refundable" }, minor: "11500" },
    ],
    "30000",
    [{ kind: "addon", selectionId: null, amountMinor: "1000" }],
  );
  expect(roomShares(q)).toEqual([BigInt(18103), BigInt(11897)]);
});

it("shows one block per policy, named by its rooms (D7)", () => {
  const same = quote(
    [
      { id: "a", cancellation: free(3), minor: "10000" },
      { id: "b", cancellation: free(3), minor: "10000" },
    ],
    "20000",
  );
  expect(
    policyBlocks(same, { today: "2026-10-25", roomNames: { a: "Villa", b: "Garden" } }),
  ).toEqual([expect.objectContaining({ rooms: ["Villa", "Garden"] })]);
  const mixed = quote(
    [
      { id: "a", cancellation: free(3), minor: "17500" },
      { id: "b", cancellation: { kind: "non_refundable" }, minor: "11500" },
    ],
    "29000",
  );
  const blocks = policyBlocks(mixed, {
    today: "2026-10-25",
    roomNames: { a: "Villa", b: "Garden" },
  });
  expect(blocks.map((block) => [block.rooms, block.policy.badge.kind])).toEqual([
    [["Villa"], "freeUntil"],
    [["Garden"], "nonRefundable"],
  ]);
  expect(blocks[1]!.policy.rows[0]!.pay).toEqual({ kind: "full", amountMinor: "11500" });
});

it("takes each room's discount off its share, as the server does", () => {
  // Room a 100.00 less a 20.00 discount, room b 100.00: the server shares 80.00 / 100.00.
  const q = quote(
    [
      { id: "a", cancellation: free(3), minor: "10000" },
      { id: "b", cancellation: { kind: "non_refundable" }, minor: "10000" },
    ],
    "18000",
    [{ kind: "discount", selectionId: "a", amountMinor: "2000" }],
  );
  expect(roomShares(q)).toEqual([BigInt(8000), BigInt(10000)]);
  const blocks = policyBlocks(q, { today: "2026-10-25", roomNames: { a: "Villa", b: "Garden" } });
  expect(blocks.map((block) => block.policy.rows.at(-1)!.pay)).toEqual([
    { kind: "full", amountMinor: "8000" },
    { kind: "full", amountMinor: "10000" },
  ]);
});

it("rounds a part refund per room, as the server refunds", () => {
  // Two rooms of 1.01 at a 50% refund: the server refunds 0.51 each and keeps 0.50 each.
  const policy = cancellationPolicy(
    partial([{ minDaysBeforeCheckIn: 7, refundPercent: 50 }]),
    { checkIn: "2026-11-06", today: "2026-10-25" },
    [BigInt(101), BigInt(101)],
    instant,
  );
  expect(policy.rows[0]!.pay).toEqual({ kind: "part", percent: 50, amountMinor: "100" });
  expect(policy.rows.at(-1)!.pay).toEqual({ kind: "full", amountMinor: "202" });
});

it("reads a partial-refund rate without a refund step as non-refundable", () => {
  const policy = cancellationPolicy(
    partial([{ minDaysBeforeCheckIn: 7, refundPercent: 0 }]),
    { checkIn: "2026-11-06", today: "2026-10-25" },
    "17500",
    instant,
  );
  expect(policy.badge).toEqual({ kind: "nonRefundable" });
});

it("groups rates by the terms that decide the policy and names each kind of room once", () => {
  const withText = {
    kind: "flexible",
    terms: {
      flexibleCancellationType: "partial_refund",
      freeCancellationDeadlineDays: 3,
      text: "Our own words",
      partialRefundTiers: [
        { minDaysBeforeCheckIn: 7, refundPercent: 50 },
        { minDaysBeforeCheckIn: 14, refundPercent: 100 },
      ],
    },
  } as unknown as Cancellation;
  const q = quote(
    [
      { id: "a", cancellation: withText, minor: "10000" },
      {
        id: "b",
        cancellation: partial([
          { minDaysBeforeCheckIn: 14, refundPercent: 100 },
          { minDaysBeforeCheckIn: 7, refundPercent: 50 },
        ]),
        minor: "10000",
      },
    ],
    "20000",
  );
  const blocks = policyBlocks(q, {
    today: "2026-10-25",
    roomNames: { a: "Double · Flexible", b: "Double · Flexible" },
  });
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.rooms).toEqual(["Double · Flexible"]);
  expect(blocks[0]!.today).toBe("2026-10-25");
});
