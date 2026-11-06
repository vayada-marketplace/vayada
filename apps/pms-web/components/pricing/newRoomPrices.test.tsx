import { beforeEach, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  createReplacementPricingClient,
  PricingDraft,
  PricingSnapshot,
} from "@/services/api/replacementPricingClient";
import { firstPricingInput } from "./FirstPricingSetup";
import { copiedRoomPrices, pricesForRoom, publishNewRoomPrices } from "./newRoomPrices";

const temporary = "61000000-0000-4000-8000-0000000000aa";
const created = "61000000-0000-4000-8000-0000000000bb";
const other = "61000000-0000-4000-8000-0000000000cc";
const offer = "61000000-0000-4000-8000-0000000000dd";
const capacity = { total: 2, adults: 2, children: 2 };
const answers = (
  mode: "flat" | "occupancy",
  cancellation: "non_refundable" | "flexible" = "non_refundable",
) =>
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
    cancellation,
    freeDays: cancellation === "flexible" ? "7" : "",
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
  readTerms: vi.fn(),
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
  client.readTerms.mockImplementation(
    async (roomTypeId: string, offerId: string, revision: string) => ({
      roomTypeId,
      offerId,
      revision,
      ...termsOf(offerId),
    }),
  );
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

it("after an Owner's currency change carries the other rooms as their Prices tab does (VAY-2390, VAY-2425)", async () => {
  // One scale and price step (USD to EUR): every room goes out again with its numbers.
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
  expect(
    saved.snapshot.rooms.map((room) => [room.roomTypeId, room.currency, room.revision]),
  ).toEqual([
    [other, "EUR", 4],
    [created, "EUR", 4],
  ]);
  // Another price step (IDR to EUR): the rooms nobody has seen in EUR are left out.
  client.read.mockResolvedValueOnce({
    currency: "IDR",
    ownerReferences: { finance: "finance" },
    rooms: [{ ...otherRoom, currency: "IDR" }],
    revision: 5,
    sources,
    stale: false,
  });
  await publishTyped();
  expect(saved.baseRevision).toBe(5);
  expect(saved.snapshot.rooms.map((room) => [room.roomTypeId, room.revision])).toEqual([
    [created, 6],
  ]);
});

// VAY-2487: a duplicated room type gets the original's saved prices.
const original = "61000000-0000-4000-8000-0000000000ee";
const linked = "61000000-0000-4000-8000-0000000000ff";
const mainTerms = "61000000-0000-4000-8000-000000000101";
const linkedTerms = "61000000-0000-4000-8000-000000000102";
const occupancy = (...amountsMinor: string[]) => ({ mode: "occupancy" as const, amountsMinor });
const rules = (minArrivalNights: number) => ({
  minArrivalNights,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
});
/** The original as saved: prices per number of guests, two seasons with their own minimum stay, and a second option
 * linked to the first ("10% less"). */
function originalRoom(): PricingSnapshot["rooms"][number] {
  const room = typed("occupancy").room;
  const main = room.offers[0];
  if (main.price.kind !== "independent") throw new Error("The first option has its own prices");
  return {
    ...room,
    roomTypeId: original,
    revision: 3,
    offers: [
      {
        ...main,
        termsRevision: mainTerms,
        price: {
          kind: "independent",
          calendar: {
            ...main.price.calendar,
            seasons: [
              {
                name: "January",
                tier: "",
                from: "01-01",
                through: "01-31",
                price: occupancy("32500", "35000"),
              },
              {
                name: "December",
                tier: "high",
                from: "12-01",
                through: "12-31",
                price: occupancy("40000", "42500"),
              },
            ],
          },
        },
        restrictions: {
          kind: "own",
          rules: rules(1),
          seasons: [{ from: "12-01", through: "12-31", rules: rules(3) }],
          dates: [],
        },
      },
      {
        id: linked,
        termsRevision: linkedTerms,
        meal: main.meal,
        price: {
          kind: "linked",
          parentId: offer,
          adjustment: { kind: "percentage", basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
  } as PricingSnapshot["rooms"][number];
}
/** Each option's saved cancellation and payment: the linked option is flexible, the first one non-refundable. */
const termsOf = (offerId: string) => {
  const { cancellation, payment } = answers(
    "flat",
    offerId === linked ? "flexible" : "non_refundable",
  ).terms;
  return { cancellation, payment };
};
const savedWithOriginal = () => ({
  currency: "EUR",
  ownerReferences: { finance: "finance" },
  rooms: [otherRoom, originalRoom()],
  revision: 3,
  sources,
  stale: false,
});
const copyOf = (read: ReturnType<typeof savedWithOriginal> | null, from = original) =>
  copiedRoomPrices(
    client as unknown as ReturnType<typeof createReplacementPricingClient>,
    read,
    from,
    created,
  );
const savedRoom = (roomTypeId: string) =>
  saved.snapshot.rooms.find((room) => room.roomTypeId === roomTypeId)!;

it("copies the original's saved prices, seasons, prices per number of guests and every option's terms to its copy (VAY-2487)", async () => {
  const read = savedWithOriginal();
  // Room-type IDs are lower-case UUIDs; the list's id may carry another case.
  const prices = await copyOf(read, original.toUpperCase());
  expect(prices!.room).toEqual({ ...originalRoom(), roomTypeId: created });
  expect(client.readTerms.mock.calls).toEqual([
    [original, offer, mainTerms],
    [original, linked, linkedTerms],
  ]);
  // New terms of the copy, with the original's cancellation and payment.
  expect(prices!.terms).toEqual([
    { roomTypeId: created, offerId: offer, expectedRevision: null, ...termsOf(offer) },
    { roomTypeId: created, offerId: linked, expectedRevision: null, ...termsOf(linked) },
  ]);
  expect(prices!.terms[1].cancellation).not.toEqual(prices!.terms[0].cancellation);

  // Published from that same read, next to the other rooms, which stay as they are.
  await publishNewRoomPrices(
    client as unknown as ReturnType<typeof createReplacementPricingClient>,
    prices!,
    read,
  );
  expect(client.read).not.toHaveBeenCalled();
  expect(saved.baseRevision).toBe(3);
  expect(saved.snapshot.rooms.map((room) => [room.roomTypeId, room.revision])).toEqual([
    [other, 4],
    [original, 4],
    [created, 4],
  ]);
  expect(client.termsAction.mock.calls.map((call) => (call as unknown[])[0])).toEqual(
    prices!.terms,
  );
  // The copy is independent: its options have their own new terms, the original keeps its own.
  expect(savedRoom(created).offers.map((value) => value.termsRevision)).toEqual([
    "terms-revision",
    "terms-revision",
  ]);
  expect(savedRoom(original)).toEqual({ ...originalRoom(), revision: 4 });
  expect(savedRoom(created)).toEqual({
    ...originalRoom(),
    roomTypeId: created,
    revision: 4,
    offers: originalRoom().offers.map((value) => ({ ...value, termsRevision: "terms-revision" })),
  });
  expect(publish).toHaveBeenCalledOnce();
});

it("leaves a copy without prices when the original has none, reading no terms", async () => {
  expect(await copyOf({ ...savedWithOriginal(), rooms: [otherRoom] })).toBeNull();
  expect(await copyOf(null)).toBeNull();
  expect(client.readTerms).not.toHaveBeenCalled();
});

it("copies nothing when an option's saved terms can't be read", async () => {
  client.readTerms.mockImplementation(
    async (roomTypeId: string, offerId: string, revision: string) =>
      offerId === linked ? null : { roomTypeId, offerId, revision, ...termsOf(offerId) },
  );
  await expect(copyOf(savedWithOriginal())).rejects.toThrow();
  client.readTerms.mockRejectedValue(new ApiErrorResponse(409, { message: "changed" }));
  await expect(copyOf(savedWithOriginal())).rejects.toBeInstanceOf(ApiErrorResponse);
  expect(client.termsAction).not.toHaveBeenCalled();
});

it("refuses a copy's save when someone published prices for the copy after the read", async () => {
  const read = savedWithOriginal();
  const prices = await copyOf(read);
  await expect(
    publishNewRoomPrices(
      client as unknown as ReturnType<typeof createReplacementPricingClient>,
      prices!,
      { ...read, rooms: [...read.rooms, { ...otherRoom, roomTypeId: created }] },
    ),
  ).rejects.toBeInstanceOf(ApiErrorResponse);
  expect(client.prepare).not.toHaveBeenCalled();
});
