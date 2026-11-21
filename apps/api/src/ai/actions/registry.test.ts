// Registration rules of the AI action registry (VAY-2507).
import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { calendarDays } from "./calendarDays.js";
import { ActionDefinitionError, defineRouteAction } from "./defineRouteAction.js";
import {
  AI_ACTIONS,
  aiActionRouteGate,
  assertRegistry,
  listActionsFor,
  toolDefinition,
} from "./registry.js";
import { runRouteAction } from "./runRouteAction.js";

const base = {
  name: "test_action",
  version: 1,
  description: "A test action that reads something harmless for the tests.",
  route: "GET /api/pms/properties/:propertyId/room-types",
  output: z.object({ propertyId: z.string() }),
  permission: "pms.room_status.read",
  tier: "R1",
  surfaces: ["in_app"],
  reviewedBy: "test",
} as const;

describe("defineRouteAction (VAY-2507)", () => {
  it("builds a strict input from the route's path parameters and the query", () => {
    const action = defineRouteAction({ ...base, query: { limit: z.number().int().max(50) } });
    expect(action.key).toBe("test_action@1");
    expect(action.pathParamNames).toEqual(["propertyId"]);
    expect(action.input.safeParse({ propertyId: crypto.randomUUID(), limit: 5 }).success).toBe(
      true,
    );
    expect(action.input.safeParse({ propertyId: "p1" }).success).toBe(false);
    expect(
      action.input.safeParse({ propertyId: crypto.randomUUID(), extra: "smuggled" }).success,
    ).toBe(false);
  });

  it.each([
    [
      "a change (Phase 1 is read-only)",
      { route: "POST /api/pms/properties/:propertyId/room-blocks" },
    ],
    ["a bad name", { name: "Rooms List" }],
    ["a description with an id", { description: `Rooms of ${crypto.randomUUID()} and more.` }],
    ["no reviewer", { reviewedBy: " " }],
    ["no surface", { surfaces: [] }],
    ["an output that keeps unknown keys", { output: z.looseObject({ a: z.string() }) }],
    ["an output with an unknown value", { output: z.object({ a: z.unknown() }) }],
    ["an output with a record", { output: z.object({ a: z.record(z.string(), z.string()) }) }],
    ["an output with a transform", { output: z.object({ a: z.string().transform((v) => v) }) }],
    [
      "a path parameter without a schema",
      { route: "GET /api/pms/properties/:propertyId/room-types/:roomTypeId" },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(() => defineRouteAction({ ...base, ...overrides } as never)).toThrow(
      ActionDefinitionError,
    );
  });

  it.each([
    ["guest names", z.object({ items: z.array(z.object({ primaryGuest: z.string() })) })],
    ["contact details", z.object({ email: z.string() })],
    ["money", z.object({ totalAmount: z.string() })],
    ["payouts", z.object({ payout: z.object({ id: z.string() }) })],
    ["staff names", z.object({ items: z.array(z.object({ assignedToName: z.string() })) })],
    ["booking prices", z.object({ pricing: z.object({ currency: z.string() }) })],
    ["special requests", z.object({ specialRequests: z.string() })],
    ["message text", z.object({ body: z.string() })],
  ])("keeps %s off MCP until the owner turns them on (VAY-2529)", (_label, output) => {
    expect(() => defineRouteAction({ ...base, surfaces: ["mcp"], output })).toThrow(/MCP/);
    expect(() => defineRouteAction({ ...base, surfaces: ["in_app"], output })).not.toThrow();
  });
});

describe("reviewed MCP fields", () => {
  it("lets a reviewed path through, with its reason, and refuses a stale one", () => {
    const output = z.object({ hotel: z.object({ displayName: z.string() }) });
    expect(() => defineRouteAction({ ...base, surfaces: ["mcp"], output })).toThrow(/MCP/);
    expect(() =>
      defineRouteAction({
        ...base,
        surfaces: ["mcp"],
        output,
        mcpReviewedFields: { "hotel.displayName": "the property's own public name" },
      }),
    ).not.toThrow();
    expect(() =>
      defineRouteAction({
        ...base,
        surfaces: ["mcp"],
        output,
        mcpReviewedFields: { "hotel.name": "stale" },
      }),
    ).toThrow(/not in the output/);
  });
});

describe("the registry", () => {
  it("refuses an action on a never-list route at load, from the never list itself", () => {
    const payouts = defineRouteAction({
      ...base,
      name: "payout_destination",
      route: "GET /api/finance/properties/:propertyId/payout-destination",
    });
    expect(() => assertRegistry([payouts])).toThrow(/bank_accounts_and_payouts/);
  });

  it("refuses an action on a deny-listed or not-yet-sorted-as-action route", () => {
    const reservations = defineRouteAction({
      ...base,
      name: "booking_admin_reservations",
      route: "GET /api/booking/hotels/:hotelId/reservations",
    });
    expect(() => assertRegistry([reservations])).toThrow(/data_deny_list/);
    // room-types is "later": it has to leave the classification when it becomes an action.
    expect(() => assertRegistry([defineRouteAction(base)])).toThrow(/later/);
  });

  it("refuses two versions or two copies of one action", () => {
    expect(() => assertRegistry([calendarDays, calendarDays])).toThrow(/twice/);
    const v2 = defineRouteAction({ ...calendarDays, version: 2 });
    expect(() => assertRegistry([calendarDays, v2])).toThrow(/two versions/);
  });

  it("lets the AI run exactly the routes of registered actions", () => {
    for (const action of AI_ACTIONS) {
      expect(aiActionRouteGate.allowsRoute("GET", action.routeUrl)).toBe(true);
      expect(aiActionRouteGate.allowsRoute("POST", action.routeUrl)).toBe(false);
    }
    expect(
      aiActionRouteGate.allowsRoute(
        "GET",
        "/api/finance/properties/:propertyId/payout-destination",
      ),
    ).toBe(false);
    expect(aiActionRouteGate.allowsRoute("GET", "/api/pms/properties/:propertyId/room-types")).toBe(
      false,
    );
  });

  it("offers an action only to users whose route would let them in, on the delegation's surface", () => {
    const context = (permissions: string[], channel?: "mcp" | "in_app") =>
      ({
        membership: { permissions },
        ...(channel ? { delegation: { channel, toolCallId: "t" } } : {}),
      }) as unknown as RequestContext;
    const names = (permissions: string[], channel?: "mcp" | "in_app") =>
      listActionsFor(context(permissions, channel)).map((action) => action.name);
    expect(names([], "mcp")).toEqual([]);
    expect(names(["pms.calendar.read"], "mcp")).toEqual(["calendar_days"]);
    expect(names(["pms.calendar.read"])).toEqual([]);
  });

  it("gives both surfaces one tool definition with a closed input schema", () => {
    for (const action of AI_ACTIONS) {
      const tool = toolDefinition(action);
      expect(tool.name).toBe(action.name);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
  });

  it("checks input before anything runs: the calendar range is capped at 62 nights", async () => {
    const context = {
      membership: { permissions: ["pms.calendar.read"] },
      delegation: { channel: "in_app", toolCallId: "t" },
    } as unknown as RequestContext;
    const app = {} as never; // never reached
    const propertyId = crypto.randomUUID();
    const tooLong = await runRouteAction(app, context, calendarDays, {
      propertyId,
      from: "2026-12-01",
      to: "2027-02-15",
    });
    expect(tooLong).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const backwards = await runRouteAction(app, context, calendarDays, {
      propertyId,
      from: "2026-12-05",
      to: "2026-12-01",
    });
    expect(backwards).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const smuggled = await runRouteAction(app, context, calendarDays, {
      propertyId,
      from: "2026-12-01",
      to: "2026-12-02",
      hotelId: propertyId,
    });
    expect(smuggled).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
