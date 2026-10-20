import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ context: null as unknown }));
vi.mock("./policy.js", () => ({ enforceRoutePolicy: vi.fn(() => policy.context) }));
vi.mock("@vayada/backend-authorization", async (original) => ({
  ...(await original<typeof import("@vayada/backend-authorization")>()),
  resolveEffectivePropertyAccess: vi.fn(async () => ({ propertyIds: [propertyId] })),
}));

import { registerHotelFirstRunRoutes, type HotelFirstRunRouteService } from "./hotelFirstRun.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const body = {
  room: { name: "Classic Double", numberOfRooms: 8, maxGuests: 2, pricePerNight: "145" },
  pricesIncludeMandatoryCharges: true,
  guestPayment: "pay_at_property",
  plan: "commission",
};
/** The same body as `rooms` (VAY-2247 1.12). */
const { room: classicDouble, ...shared } = body;
const state = { contractVersion: "hotel-first-run.v1", propertyId, steps: [], nextStep: null };

function ownerContext(overrides: { roleKey?: string; sessionId?: string | null } = {}) {
  return {
    selectedOrganization: { organizationId, kind: "hotel_group" },
    membership: { roleKey: overrides.roleKey ?? "hotel_owner" },
    actor: {
      internalUserId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
      email: "owner@example.com",
      providerIdentity: {
        sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
      },
    },
    linkedResources: [
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
    ],
    audit: { requestId: "req-1", receivedAt: "2026-10-20T09:00:00.000Z" },
  };
}

async function call(
  method: "GET" | "POST",
  service: Partial<HotelFirstRunRouteService>,
  payload?: unknown,
  id = propertyId,
) {
  const app = Fastify();
  await registerHotelFirstRunRoutes(app, {
    createService: () => service as HotelFirstRunRouteService,
    propertyAccessRepository: {} as never,
  });
  const response = await app.inject({
    method,
    url: `/properties/${id}/first-run`,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
  await app.close();
  return response;
}

beforeEach(() => {
  policy.context = ownerContext();
});

describe("hotel first run routes (VAY-2247)", () => {
  it("GET returns the owner's first-run state", async () => {
    const read = vi.fn(async (_actor: unknown) => state as never);
    const response = await call("GET", { read } as never);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(state);
    expect(read).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      userId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
      requestId: "req-1",
      correlationId: null,
      requestedAt: "2026-10-20T09:00:00.000Z",
    });
  });

  it("POST runs the first run with the owner's email and returns the state, the steps that wrote and the checkout", async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      state,
      ran: ["currency"],
      checkoutUrl: "https://stripe.example/c",
    }));
    const response = await call("POST", { run } as never, body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state,
      ran: ["currency"],
      checkout: { url: "https://stripe.example/c" },
    });
    const [, sent, email] = run.mock.calls[0] as unknown as [unknown, unknown, unknown];
    // The first version's single `room` arrives as one room type.
    expect(sent).toEqual({ ...shared, rooms: [classicDouble] });
    expect(email).toBe("owner@example.com");
  });

  it("POST takes several room types (VAY-2247 1.12)", async () => {
    const run = vi.fn(async () => ({ ok: true as const, state, ran: [], checkoutUrl: null }));
    const rooms = [
      classicDouble,
      { name: "Alpine Suite", numberOfRooms: 4, maxGuests: 3, pricePerNight: "210" },
    ];
    expect((await call("POST", { run } as never, { ...shared, rooms })).statusCode).toBe(200);
    expect((run.mock.calls[0] as unknown as [unknown, unknown])[1]).toEqual({ ...shared, rooms });
  });

  it("POST tells a request it can't use (422) from a step that conflicts (409)", async () => {
    const stopped = (code: string) =>
      vi.fn(async () => ({
        ok: false as const,
        code,
        step: "pricing" as const,
        state,
        ran: ["currency"],
      }));
    const unusable = await call(
      "POST",
      { run: stopped("mandatory_charges_declaration_required") } as never,
      body,
    );
    expect(unusable.statusCode).toBe(422);
    expect(unusable.json()).toMatchObject({
      code: "mandatory_charges_declaration_required",
      step: "pricing",
    });
    expect(
      (await call("POST", { run: stopped("first_run_pricing_stale") } as never, body)).statusCode,
    ).toBe(409);
  });

  it.each([
    { ...body, plan: "card" },
    { ...body, guestPayment: "card" },
    { ...body, room: { ...body.room, numberOfRooms: "8" } },
    { ...body, extra: true },
    { room: body.room },
    // VAY-2247 1.12: rooms instead of room, never both; 1–10 room types with different names.
    { ...body, rooms: [body.room] },
    { ...shared, rooms: [] },
    {
      ...shared,
      rooms: Array.from({ length: 11 }, (_, index) => ({
        ...body.room,
        name: `Room type ${index}`,
      })),
    },
    {
      ...shared,
      rooms: [body.room, { ...body.room, name: " classic double " }],
    },
  ])("POST refuses a body that isn't exactly what the setup sends: %j", async (invalid) => {
    const run = vi.fn();
    const response = await call("POST", { run } as never, invalid);
    expect(response.statusCode).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["a staff member", { roleKey: "hotel_manager" }],
    ["a session without a WorkOS session id", { sessionId: null }],
  ])("refuses %s (owner only)", async (_who, overrides) => {
    policy.context = ownerContext(overrides);
    const read = vi.fn();
    const response = await call("GET", { read });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "owner_session_required" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a property the owner link doesn't cover", async () => {
    const other = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    expect((await call("GET", { read: vi.fn() }, undefined, other)).statusCode).toBe(403);
    expect((await call("GET", { read: vi.fn() }, undefined, "not-a-uuid")).statusCode).toBe(400);
  });
});
