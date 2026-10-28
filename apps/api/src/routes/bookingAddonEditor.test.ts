import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  registerBookingAddonItemRoutes,
  type BookingAddonItemsRepository,
} from "./bookingAddonItems.js";
vi.mock("./policy.js", () => ({ enforceRoutePolicy: vi.fn() }));
const photo = {
  mediaObjectId: "d3000000-0000-4000-8000-000000000684",
  imageUrl: "",
  isCover: true,
};
const body = {
  name: "Breakfast",
  price: "15.00",
  currency: "EUR",
  category: "dining",
  pricingModel: "per_guest_night",
  photos: [photo],
  maxQuantity: 2,
  maxGuests: 6,
  leadTime: "24h before",
  location: "Room",
};
async function request(payload: unknown) {
  const create = vi.fn().mockResolvedValue({ outcome: "created", addonItem: payload });
  const app = Fastify();
  await registerBookingAddonItemRoutes(app, {
    createAddonItemByHotelId: create,
  } as unknown as BookingAddonItemsRepository);
  const response = await app.inject({
    method: "POST",
    url: "/hotels/property/addon-items",
    payload: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  await app.close();
  return { response, create };
}
describe("add-on editor payload", () => {
  it("persists all descriptive fields and explicit pricing", async () => {
    const { response, create } = await request(body);
    expect(response.statusCode).toBe(201);
    expect(create.mock.calls[0][1]).toMatchObject(body);
  });
  it.each([
    {
      photos: Array.from({ length: 6 }, (_, i) => ({
        ...photo,
        mediaObjectId: `d3000000-0000-4000-8000-00000000068${i}`,
        isCover: i === 0,
      })),
    },
    { photos: [{ ...photo, isCover: false }] },
    { photos: [photo, photo] },
    { maxQuantity: 0 },
    { maxQuantity: 1.5 },
    { maxGuests: -1 },
    { price: "" },
    { pricingModel: "flat" },
    // VAY-2232: only the editor's fixed choices.
    { leadTimeHours: 10 },
    { leadTimeHours: 0 },
    { leadTimeHours: "24" },
    { leadTimeHours: 24.5 },
    { photos: [{ imageUrl: "https://arbitrary.test/image", isCover: true }] },
  ])("rejects invalid editor values before persistence: %j", async (invalid) => {
    const { response, create } = await request({ ...body, ...invalid });
    expect(response.statusCode).toBe(422);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([12, 24, 48, 72, 168, null])("accepts the lead time choice %j", async (hours) => {
    const { response, create } = await request({ ...body, leadTimeHours: hours });
    expect(response.statusCode).toBe(201);
    expect(create.mock.calls[0][1]).toMatchObject({ leadTimeHours: hours });
  });
  it("allows removing the complete gallery", async () => {
    expect((await request({ ...body, photos: [] })).response.statusCode).toBe(201);
  });
  // VAY-2391: when it happens. Whether a mode fits the price is checked when it is saved.
  it.each([
    { scheduleMode: "weekly" },
    { scheduleMode: null },
    { bookableWeekdays: [] },
    { bookableWeekdays: [0, 1] },
    { bookableWeekdays: [1, 1] },
    { bookableWeekdays: "1,2" },
  ])("rejects invalid schedule values before persistence: %j", async (invalid) => {
    const { response, create } = await request({ ...body, ...invalid });
    expect(response.statusCode).toBe(422);
    expect(create).not.toHaveBeenCalled();
  });
  it("accepts a schedule that fits the price, with weekdays in order", async () => {
    const daily = await request({ ...body, scheduleMode: "daily" });
    expect(daily.response.statusCode).toBe(201);
    const pick = await request({
      ...body,
      pricingModel: "per_stay",
      scheduleMode: "guest_pick",
      bookableWeekdays: [6, 5],
    });
    expect(pick.response.statusCode).toBe(201);
    expect(pick.create.mock.calls[0][1]).toMatchObject({
      scheduleMode: "guest_pick",
      bookableWeekdays: [5, 6],
    });
  });
});
