import { beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  createReplacementPricingClient,
  PricingDraft,
  PricingSnapshot,
} from "@/services/api/replacementPricingClient";
import { firstPricingInput } from "./FirstPricingSetup";
import { pricesForRoom, publishNewRoomPrices } from "./newRoomPrices";

const temporary = "61000000-0000-4000-8000-0000000000aa";
const created = "61000000-0000-4000-8000-0000000000bb";
const other = "61000000-0000-4000-8000-0000000000cc";
const offer = "61000000-0000-4000-8000-0000000000dd";
const capacity = { total: 2, adults: 2, children: 2 };
const answers = (mode: "flat" | "occupancy") =>
  firstPricingInput("property", { roomTypeId: temporary, name: "Suite", capacity }, offer, {
    mode,
    occupancy: mode === "occupancy" ? ["90", "120"] : [],
    included: { adults: "", adjustments: [] },
    methods: ["card"], // Non-refundable is paid in advance (VAY-2280).
    room: temporary,
    currency: "EUR",
    base: "120",
    adultAge: "12",
    childPrice: "0",
    countChildren: "yes",
    minimum: "1",
    maximum: "",
    cancellation: "non_refundable",
    freeDays: "",
    payment: "full",
  });
const typed = (mode: "flat" | "occupancy" = "flat") => {
  const input = answers(mode);
  return { room: { ...input.configuration, revision: 4 }, terms: [input.terms] };
};
const otherRoom = { ...typed().room, roomTypeId: other, revision: 3 };
const sources = { room: "room", terms: "terms", finance: "finance" };

let saved: PricingDraft;
const confirm = vi.fn(),
  publish = vi.fn(),
  stage = vi.fn();
const client = {
  read: vi.fn(),
  termsAction: vi.fn(() => stage),
  prepare: vi.fn(),
  saveDraft: vi.fn(),
  reviewCharges: vi.fn(),
  confirmationAction: vi.fn(() => confirm),
  publicationAction: vi.fn(() => publish),
};
const publishTyped = (prices = pricesForRoom(typed(), created, capacity)) =>
  publishNewRoomPrices(
    client as unknown as ReturnType<typeof createReplacementPricingClient>,
    prices,
  );
beforeEach(() => {
  vi.clearAllMocks();
  client.read.mockResolvedValue({
    currency: "EUR",
    ownerReferences: { finance: "finance" },
    rooms: [otherRoom],
    revision: 3,
    sources,
    stale: true,
  });
  stage.mockResolvedValue({ revision: "terms-revision" });
  client.prepare.mockImplementation(async (value: Omit<PricingSnapshot, "ownerReferences">) => ({
    sources,
    snapshot: { ...value, ownerReferences: { finance: "finance" } },
  }));
  client.saveDraft.mockImplementation(
    async ({ draftId, expectedDraftRevision, baseRevision, snapshot }) => {
      saved = {
        draftId,
        revision: expectedDraftRevision + 1,
        baseRevision,
        snapshot,
        sources,
        stale: false,
      };
      return saved.revision;
    },
  );
  client.reviewCharges.mockImplementation(async () => ({
    ...saved,
    fingerprint: "fingerprint",
    declaration: "all_mandatory_charges_included",
  }));
  confirm.mockResolvedValue({ id: "declaration" });
  publish.mockResolvedValue({ revision: 4, replayed: false });
});

it("gives the created room's id to the prices and every option's terms, with the guest numbers it was created with (VAY-2147)", () => {
  const prices = pricesForRoom(typed(), created, { total: 3, adults: 2, children: 1 });
  expect(prices.room).toEqual({
    ...typed().room,
    roomTypeId: created,
    capacity: { total: 3, adults: 2, children: 1 },
  });
  expect(prices.terms).toEqual([{ ...typed().terms[0], roomTypeId: created }]);
});

it("refuses prices per number of guests that no longer fit the room's adults", () => {
  expect(pricesForRoom(typed("occupancy"), created, capacity).room.capacity).toEqual(capacity);
  expect(() =>
    pricesForRoom(typed("occupancy"), created, { total: 3, adults: 3, children: 0 }),
  ).toThrow("The guest numbers changed after you set prices per number of guests.");
  // Flat prices fit any guest numbers.
  expect(
    pricesForRoom(typed(), created, { total: 4, adults: 3, children: 1 }).room.capacity.adults,
  ).toBe(3);
});

it("publishes the new room next to every room as the server has them now, staging its terms under its real id", async () => {
  await publishTyped();
  expect(client.termsAction).toHaveBeenCalledOnce();
  expect(client.termsAction.mock.calls[0]).toEqual([
    expect.objectContaining({ roomTypeId: created, offerId: offer, expectedRevision: null }),
    { draftId: expect.any(String), baseRevision: 3 },
  ]);
  expect(
    client.prepare.mock.calls[0][0].rooms.map((room: PricingSnapshot["rooms"][number]) => [
      room.roomTypeId,
      room.revision,
    ]),
  ).toEqual([
    [other, 4],
    [created, 4],
  ]);
  expect(client.prepare.mock.calls[0][0].rooms[1].offers[0].termsRevision).toBe("terms-revision");
  expect(saved.baseRevision).toBe(3);
  expect(client.confirmationAction).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: saved.draftId }),
    "save_prices",
  );
  expect(publish).toHaveBeenCalledOnce();
});

it("publishes the property's first prices from revision 0", async () => {
  client.read.mockResolvedValueOnce(null);
  await publishTyped();
  expect(saved.baseRevision).toBe(0);
  expect(saved.snapshot.rooms.map((room) => [room.roomTypeId, room.revision])).toEqual([
    [created, 1],
  ]);
});

it("refuses without writing when prices for this room were published meanwhile", async () => {
  client.read.mockResolvedValueOnce({
    currency: "EUR",
    ownerReferences: { finance: "finance" },
    rooms: [{ ...otherRoom, roomTypeId: created }],
    revision: 3,
    sources,
    stale: false,
  });
  await expect(publishTyped()).rejects.toBeInstanceOf(ApiErrorResponse);
  expect(client.termsAction).not.toHaveBeenCalled();
  expect(client.prepare).not.toHaveBeenCalled();
});

it("leaves out the rooms still in the old currency after an Owner's currency change (VAY-2425)", async () => {
  client.read.mockResolvedValueOnce({
    currency: "USD",
    ownerReferences: { finance: "finance" },
    rooms: [{ ...otherRoom, currency: "USD" }],
    revision: 3,
    sources,
    stale: false,
  });
  await publishTyped();
  expect(saved.baseRevision).toBe(3);
  expect(saved.snapshot.currency).toBe("EUR");
  expect(saved.snapshot.rooms.map((room) => [room.roomTypeId, room.revision])).toEqual([
    [created, 4],
  ]);
});
