// Definition rules of AI changes (VAY-2522).
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AUTHORITY_SITES } from "./authoritySites.js";
import { changeRequest, defineChangeAction } from "./defineChangeAction.js";
import { ActionDefinitionError } from "./defineRouteAction.js";
import { ROUTE_MANIFEST } from "../routeManifest.generated.js";
import {
  AI_ACTIONS,
  aiActionRouteGate,
  assertChangeRegistry,
  CHANGE_ACTIONS,
  delegatedWriteProblem,
  findChangeAction,
} from "./registry.js";
import { roomStatusSet } from "./roomStatusSet.js";

const PROPERTY = "cccccccc-0000-4000-8000-000000000001";
const BLOCK = "eeeeeeee-0000-4000-8000-000000000006";
const KEY = "op_7d2f0c1e-1111-4222-8333-444455556666:1";
const ROOM_TYPE = "eeeeeeee-0000-4000-8000-000000000002";
const ROOM = "eeeeeeee-0000-4000-8000-000000000003";

const base = {
  name: "test_release",
  version: 1,
  description: "Releases one room block for the tests; the person confirms it first.",
  route: "DELETE /api/pms/properties/:propertyId/room-blocks/:blockId",
  pathParams: { blockId: z.uuid() },
  body: z.strictObject({ expectedVersion: z.string() }),
  idempotency: { in: "body", fields: ["commandId", "idempotencyKey"] },
  preconditions: ["expectedVersion"],
  authoritySites: [],
  group: "ask",
  permission: "pms.calendar.manage",
  output: z.object({ propertyId: z.string() }),
  surfaces: [],
  reviewedBy: "test",
} as const;

describe("defineChangeAction (VAY-2522)", () => {
  it("takes path parameters and body fields as one strict input", () => {
    const action = defineChangeAction(base);
    expect(action).toMatchObject({
      key: "test_release@1",
      method: "DELETE",
      pathParamNames: ["propertyId", "blockId"],
      bodyFields: ["expectedVersion"],
    });
    const input = { propertyId: PROPERTY, blockId: BLOCK, expectedVersion: "3" };
    expect(action.input.safeParse(input).success).toBe(true);
    expect(action.input.safeParse({ ...input, extra: 1 }).success).toBe(false);
    expect(action.input.safeParse({ ...input, blockId: "b1" }).success).toBe(false);
  });

  it.each([
    ["a read route", { route: "GET /api/pms/properties/:propertyId/rooms", pathParams: {} }],
    ["a route without a property", { route: "POST /api/support", pathParams: {} }],
    ["a check that does not take the AI's limits", { authoritySites: ["pms_manage_scope"] }],
    ["an unknown check", { authoritySites: ["made_up"] }],
    [
      "a check listed twice",
      { authoritySites: ["pms_physical_room_scope", "pms_physical_room_scope"] },
    ],
    ["Just do it before Undo exists", { group: "do" }],
    [
      "a body field named like a path parameter",
      { body: z.strictObject({ blockId: z.string() }), preconditions: [] },
    ],
    [
      "a retry key the AI could send",
      { body: z.strictObject({ expectedVersion: z.string(), idempotencyKey: z.string() }) },
    ],
    ["a body retry key without fields", { idempotency: { in: "body", fields: [] } }],
    ["a precondition that is not a body field", { preconditions: ["version"] }],
    ["a change to something that exists without a precondition", { preconditions: [] }],
    ["a precondition on something said to be new", { addsNew: true }],
    ["something new on a DELETE", { addsNew: true, preconditions: [] }],
    [
      "a rule across body fields, which the input would lose",
      {
        body: z
          .strictObject({ expectedVersion: z.string() })
          .refine((body) => body.expectedVersion !== "0"),
      },
    ],
    [
      "a retry key field the AI could send on a header-key route",
      {
        idempotency: { in: "header" },
        body: z.strictObject({ expectedVersion: z.string(), commandId: z.string() }),
      },
    ],
    [
      "a field that reaches an object's prototype",
      { body: z.strictObject({ expectedVersion: z.string(), constructor: z.string() }) },
    ],
    ["a redefined property id", { pathParams: { blockId: z.uuid(), propertyId: z.string() } }],
    ["a body that keeps unknown keys", { body: z.looseObject({ expectedVersion: z.string() }) }],
    [
      "a body with a record",
      {
        body: z.strictObject({ expectedVersion: z.string(), m: z.record(z.string(), z.string()) }),
      },
    ],
    ["an output that keeps unknown keys", { output: z.looseObject({ a: z.string() }) }],
    ["no reviewer", { reviewedBy: " " }],
    ["a description with an id", { description: `Releases block ${BLOCK} for the tests.` }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => defineChangeAction({ ...base, ...overrides } as never)).toThrow(
      ActionDefinitionError,
    );
  });

  it("lets a change that adds something new have no precondition", () => {
    expect(() =>
      defineChangeAction({
        ...base,
        name: "test_note",
        route: "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/notes",
        pathParams: { guestBookingId: z.uuid() },
        body: z.strictObject({ body: z.string() }),
        preconditions: [],
        addsNew: true,
      }),
    ).not.toThrow();
  });

  it("keeps guest text off MCP until the owner turns it on (VAY-2529)", () => {
    const output = z.object({ note: z.object({ body: z.string() }) });
    expect(() => defineChangeAction({ ...base, surfaces: ["mcp"], output })).toThrow(/MCP/);
  });

  it("lists only checks that take the AI's limits as threaded", () => {
    expect(
      Object.entries(AUTHORITY_SITES)
        .filter(([, site]) => site.threaded)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["pms_calendar_room_follow_up", "pms_inbox_triage_scope", "pms_physical_room_scope"]);
  });
});

describe("changeRequest (VAY-2522)", () => {
  it("puts the retry key, bound to the action, where the route reads it", () => {
    const release = defineChangeAction(base);
    expect(
      changeRequest(release, { propertyId: PROPERTY, blockId: BLOCK, expectedVersion: "3" }, KEY),
    ).toEqual({
      ok: true,
      request: {
        method: "DELETE",
        routeUrl: "/api/pms/properties/:propertyId/room-blocks/:blockId",
        url: `/api/pms/properties/${PROPERTY}/room-blocks/${BLOCK}`,
        body: {
          expectedVersion: "3",
          commandId: `${KEY}:test_release`,
          idempotencyKey: `${KEY}:test_release`,
        },
        idempotencyKey: `${KEY}:test_release`,
      },
    });
    const roomType = "eeeeeeee-0000-4000-8000-000000000002";
    const room = "eeeeeeee-0000-4000-8000-000000000003";
    expect(
      changeRequest(
        roomStatusSet,
        {
          propertyId: PROPERTY,
          roomTypeId: roomType,
          roomUnitId: room,
          expectedRevision: 2,
          changes: { status: "out_of_order" },
        },
        KEY,
      ),
    ).toMatchObject({
      ok: true,
      request: {
        method: "PUT",
        body: { expectedRevision: 2, changes: { status: "out_of_order" } },
        idempotencyKey: `${KEY}:room_status_set`,
      },
    });
  });

  it("refuses input it can't send, naming the field but never the value", () => {
    const result = changeRequest(
      roomStatusSet,
      {
        propertyId: PROPERTY,
        roomTypeId: "eeeeeeee-0000-4000-8000-000000000002",
        roomUnitId: "eeeeeeee-0000-4000-8000-000000000003",
        expectedRevision: 2,
        // The room's number is not the AI's to change through this action.
        changes: { status: "maintenance", operationalLabel: "SECRET-101" },
      },
      KEY,
    );
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("SECRET-101");
  });
});

describe("the change registry (VAY-2522)", () => {
  it("lets the AI reach exactly each change's route, with its own method", () => {
    for (const action of CHANGE_ACTIONS) {
      expect(aiActionRouteGate.allowsRoute(action.method, action.routeUrl)).toBe(true);
      expect(aiActionRouteGate.allowsRoute("GET", action.routeUrl)).toBe(false);
      expect(findChangeAction(action.key)).toBe(action);
    }
    // The room-block edit and the room's number stay out.
    expect(
      aiActionRouteGate.allowsRoute(
        "PATCH",
        "/api/pms/properties/:propertyId/room-blocks/:blockId",
      ),
    ).toBe(false);
    expect(
      aiActionRouteGate.allowsRoute(
        "PUT",
        "/api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId/operational-label",
      ),
    ).toBe(false);
  });

  it("lets the AI reach exactly the routes of registered actions, nothing else", () => {
    const reachable = ROUTE_MANIFEST.filter((route) => {
      const space = route.indexOf(" ");
      return aiActionRouteGate.allowsRoute(route.slice(0, space), route.slice(space + 1));
    });
    expect(reachable.sort()).toEqual(
      [...AI_ACTIONS, ...CHANGE_ACTIONS].map((action) => action.route).sort(),
    );
    expect(reachable).toHaveLength(10);
  });

  it("registers one change per route: the app holds a write to the change of its route", () => {
    const twin = defineChangeAction({
      ...base,
      name: "test_release_twin",
      route:
        "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId",
      pathParams: { roomTypeId: z.uuid(), roomUnitId: z.uuid() },
    });
    expect(() => assertChangeRegistry([roomStatusSet, twin], [])).toThrow(/second on its route/);
  });

  it("registers only changes defineChangeAction made", () => {
    expect(() => assertChangeRegistry([{ ...roomStatusSet }], [])).toThrow(/defineChangeAction/);
  });

  it("offers no change on any surface until Ask first exists (VAY-2524)", () => {
    expect(CHANGE_ACTIONS.filter((action) => action.surfaces.length > 0)).toEqual([]);
    const offered = defineChangeAction({ ...base, surfaces: ["in_app"] });
    expect(() => assertChangeRegistry([offered], [])).toThrow(/Ask first/);
  });

  it("refuses a change whose name a read action already has", () => {
    const clash = defineChangeAction({ ...base, name: AI_ACTIONS[0]!.name, version: 2 });
    expect(() => assertChangeRegistry([clash], AI_ACTIONS)).toThrow(/two versions/);
  });

  it("refuses a change on a route that is sorted for later", () => {
    const edit = defineChangeAction({
      ...base,
      route: "PATCH /api/pms/properties/:propertyId/room-blocks/:blockId",
    });
    expect(() => assertChangeRegistry([edit], [])).toThrow(/later/);
  });
});

describe("delegatedWriteProblem: a delegated write is held to its change (VAY-2522)", () => {
  const key = `${KEY}:room_status_set`;
  const write = (overrides: Record<string, unknown> = {}) => ({
    method: "PUT",
    routeUrl: roomStatusSet.routeUrl,
    params: { propertyId: PROPERTY, roomTypeId: ROOM_TYPE, roomUnitId: ROOM },
    query: {},
    body: { expectedRevision: 2, changes: { status: "maintenance" } },
    idempotencyKey: key,
    ...overrides,
  });

  it("lets through exactly what the change lets the AI send", () => {
    expect(delegatedWriteProblem(write())).toBeNull();
  });

  const NOT_THIS_CHANGE = /not what this change lets/;
  it.each([
    [
      "another route",
      { routeUrl: "/api/pms/properties/:propertyId/room-blocks/:blockId" },
      /not the route/,
    ],
    ["another method on the route", { method: "DELETE" }, /not the route/],
    [
      "the room's number",
      { body: { expectedRevision: 2, changes: { operationalLabel: "9" } } },
      NOT_THIS_CHANGE,
    ],
    [
      "the room's floor next to its state",
      { body: { expectedRevision: 2, changes: { status: "maintenance", floor: "3" } } },
      NOT_THIS_CHANGE,
    ],
    [
      "a field of its own",
      { body: { expectedRevision: 2, changes: { status: "maintenance" }, extra: 1 } },
      NOT_THIS_CHANGE,
    ],
    [
      "a body field for a path parameter",
      { body: { expectedRevision: 2, propertyId: PROPERTY } },
      /path parameter/,
    ],
    ["a query", { query: { force: "1" } }, /query/],
    ["no retry key", { idempotencyKey: undefined }, /retry key/],
    ["a retry key of another change", { idempotencyKey: `${KEY}:room_block_release` }, /retry key/],
    ["a body that is not an object", { body: [1] }, /malformed/],
  ])("refuses %s", (_label, overrides, reason) => {
    expect(delegatedWriteProblem(write(overrides))).toMatch(reason);
  });

  it("holds a body retry key to the request's own", () => {
    const release = `${KEY}:room_block_release`;
    const body = { expectedVersion: "room-block-v2", commandId: release, idempotencyKey: release };
    const blockWrite = {
      method: "DELETE",
      routeUrl: "/api/pms/properties/:propertyId/room-blocks/:blockId",
      params: { propertyId: PROPERTY, blockId: BLOCK },
      query: {},
      body,
      idempotencyKey: release,
    };
    expect(delegatedWriteProblem(blockWrite)).toBeNull();
    expect(delegatedWriteProblem({ ...blockWrite, body: { ...body, commandId: "other" } })).toMatch(
      /retry key/,
    );
    const withoutKey = { expectedVersion: body.expectedVersion, commandId: release };
    expect(delegatedWriteProblem({ ...blockWrite, body: withoutKey })).toMatch(/retry key/);
  });
});
