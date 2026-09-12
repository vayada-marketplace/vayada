import { buildApp } from "./app.js";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerMarketplacePublicHotelRoutes } from "./routes/marketplacePublicHotel.js";

const propertyId = "e1943000-0000-4000-8000-000000000003";
const hotel = {
  propertyId,
  revisionId: "e1943000-0000-4000-8000-000000000005",
  displayName: "Approved hotel",
  propertyType: "hotel",
  shortDescription: "Approved description",
  locality: null,
  media: [],
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function harness() {
  const app = Fastify();
  apps.push(app);
  const read = vi.fn().mockResolvedValue(hotel);
  await app.register(registerMarketplacePublicHotelRoutes, { prefix: "/api/marketplace", read });
  return { app, read };
}
it("allows anonymous read with canonical property scope and no caching", async () => {
  const { app, read } = await harness();
  const response = await app.inject(
    `/api/marketplace/hotels/${propertyId.toUpperCase()}?organizationId=untrusted`,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(hotel);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(read).toHaveBeenCalledExactlyOnceWith(propertyId);
});
it("does not query malformed property IDs", async () => {
  const { app, read } = await harness();
  const response = await app.inject("/api/marketplace/hotels/invalid");
  expect(response.statusCode).toBe(400);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(read).not.toHaveBeenCalled();
});
it("returns the same uncached 404 for unavailable profiles", async () => {
  const { app, read } = await harness();
  read.mockResolvedValue(null);
  const response = await app.inject(`/api/marketplace/hotels/${propertyId}`);
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ code: "hotel_not_found" });
  expect(response.headers["cache-control"]).toBe("no-store");
});
it("hides provider errors and cross-property results", async () => {
  const { app, read } = await harness();
  read.mockRejectedValueOnce(new Error("private snapshot/provider details"));
  read.mockResolvedValueOnce({ ...hotel, propertyId: "wrong" });
  for (let i = 0; i < 2; i++) {
    const response = await app.inject(`/api/marketplace/hotels/${propertyId}`);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "public_hotel_unavailable" });
    expect(response.headers["cache-control"]).toBe("no-store");
  }
});

it("registers the public read through the application middleware", async () => {
  const read = vi.fn().mockResolvedValue(hotel);
  const app = buildApp({ logger: false, marketplacePublicHotel: { read } });
  apps.push(app);
  const response = await app.inject(`/api/marketplace/hotels/${propertyId}`);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(hotel);
});
