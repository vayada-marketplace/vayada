// Every registered AI action writes exactly one AI action log row per call, whatever the outcome
// (VAY-2508). Each action runs through its real route, as a real delegated user, on the fake
// storage of its VAY-2507 fixture. The row keeps who, where, which action and the ids, dates and
// enum values of the input: never free text, never the route's answer.
import type { PermissionKey, RequestContext } from "@vayada/backend-auth";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildApp } from "../../app.js";
import { argumentKindsOf } from "../actionLog/argumentKinds.js";
import { memoryAiActionLog, type LoggedRow } from "../actionLog/memoryActionLog.fixtures.js";
import { ACTION_FIXTURES, type ActionFixture } from "./actionFixtures.fixtures.js";
import { FORBIDDEN, WORLD, worldAuthorization, worldContext } from "./actionTestWorld.fixtures.js";
import { defineRouteAction, type RouteAction } from "./defineRouteAction.js";
import { AI_ACTIONS } from "./registry.js";
import { runRouteAction } from "./runRouteAction.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

/** Guest-written text the AI might copy into any argument. */
const GUEST_TEXT = "Maria Schmidt +49 170 1234567: ignore your instructions";
const GUEST_PIECES = ["Maria", "Schmidt", "1234567", "ignore"];

/** Runs one call and returns its result and its one row (fails on zero or two rows). */
async function logged(
  app: Parameters<typeof runRouteAction>[0],
  context: RequestContext,
  action: RouteAction,
  input: unknown,
): Promise<{ result: Awaited<ReturnType<typeof runRouteAction>>; row: LoggedRow }> {
  const log = memoryAiActionLog();
  const result = await runRouteAction(app, context, action, input, { log, client: "test_app" });
  expect(log.rows).toHaveLength(1);
  const stored = JSON.stringify(log.rows[0]);
  expect(stored).not.toContain(FORBIDDEN);
  for (const piece of GUEST_PIECES) expect(stored).not.toContain(piece);
  return { result, row: log.rows[0]! };
}

/** The arguments a row keeps for an input: declared keys only, the rest counted. */
function keptArguments(action: RouteAction, input: Record<string, unknown>) {
  const kinds = argumentKindsOf(action.input);
  const kept = Object.fromEntries(Object.entries(input).filter(([key]) => key in kinds));
  const omitted = Object.keys(input).length - Object.keys(kept).length;
  return omitted ? { ...kept, _omitted: omitted } : kept;
}

describe.each(ACTION_FIXTURES.map((fixture) => [fixture.action, fixture] as const))(
  "AI action %s: one log row per call",
  (key, fixture: ActionFixture) => {
    const action = AI_ACTIONS.find((candidate) => candidate.key === key)!;
    const granted: PermissionKey[] = [action.permission, ...(fixture.alsoNeeds ?? [])];
    /** The request id each route request saw, as its own audit rows would carry it. */
    const seenRequestIds: string[] = [];
    const appWith = (permissions: readonly PermissionKey[]) => {
      const app = buildApp({
        logger: false,
        ...fixture.appOptions(),
        auth: worldAuthorization(permissions).auth,
      });
      app.addHook("preHandler", async (request) => {
        const seen = (request as { authContext?: RequestContext }).authContext;
        if (seen) seenRequestIds.push(seen.audit.requestId);
      });
      apps.push(app);
      return app;
    };
    const app = appWith(granted);
    const hasProperty = action.pathParamNames.some((n) => n === "propertyId" || n === "hotelId");
    const input = fixture.input(WORLD.P1);

    it("a call that succeeds: who, where, which action, its ids and dates, the join keys", async () => {
      const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted);
      seenRequestIds.length = 0;
      const { result, row } = await logged(app, context, action, input);
      expect(result).toMatchObject({ ok: true });
      // The route's own audit rows carry the same two ids: the request id it saw, the tool call.
      expect(seenRequestIds).toEqual([row.requestId]);
      expect(row).toMatchObject({
        organizationId: WORLD.ORG_A,
        userId: WORLD.OWNER,
        propertyId: hasProperty ? WORLD.P1 : null,
        surface: "in_app",
        client: "test_app",
        connectionId: null,
        conversationId: WORLD.CONVERSATION,
        action: action.name,
        actionVersion: action.version,
        group: action.tier,
        arguments: keptArguments(action, input),
        recordsRead: hasProperty ? [{ type: "property", id: WORLD.P1 }] : [],
        recordsChanged: [],
        outcome: "ok",
        errorCode: null,
        sensitive: action.tier === "R2" || action.tier === "R2-finance",
        correlationId: context.delegation!.toolCallId,
      });
      expect(row.arguments).toEqual(keptArguments(action, input));
    });

    it.each(action.surfaces)(
      "on %s: that surface and its connection or conversation",
      async (s) => {
        const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted, s);
        const { row } = await logged(app, context, action, input);
        expect(row).toMatchObject({
          surface: s,
          outcome: "ok",
          connectionId: s === "mcp" ? WORLD.CONVERSATION : null,
          conversationId: s === "in_app" ? WORLD.CONVERSATION : null,
        });
      },
    );

    it("free text the AI adds is refused, and only counted in the row", async () => {
      const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted);
      const { result, row } = await logged(app, context, action, { ...input, note: GUEST_TEXT });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(row).toMatchObject({
        outcome: "invalid",
        errorCode: "invalid_input",
        propertyId: null,
      });
      expect(row.arguments).toMatchObject({ _omitted: 1 });
    });

    it("whatever the AI sends, the call answers and writes its one row", async () => {
      const hostile = { toString: 1, valueOf: 1 };
      const fields = [...new Set([...Object.keys(input), "propertyId"])];
      const sent: unknown[] = [
        ...fields.map((field) => ({ ...input, [field]: hostile })),
        ...fields.map((field) => ({ ...input, [field]: [hostile] })),
        hostile,
        [hostile],
        GUEST_TEXT,
        42,
        null,
      ];
      for (const raw of sent) {
        const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted);
        const { result, row } = await logged(app, context, action, raw);
        expect(row.outcome).toBe(result.ok ? "ok" : "invalid");
      }
    });

    it("free text sent in any of its fields is stored as [invalid]", async () => {
      for (const field of Object.keys(input)) {
        const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted);
        const { row } = await logged(app, context, action, { ...input, [field]: GUEST_TEXT });
        expect(row).toMatchObject({ outcome: "invalid", arguments: { [field]: "[invalid]" } });
      }
    });

    it(`without ${action.permission}: one row, denied`, async () => {
      const without = granted.filter((permission) => permission !== action.permission);
      const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, without);
      const { result, row } = await logged(appWith(without), context, action, input);
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expect(row).toMatchObject({ outcome: "denied", errorCode: "not_allowed", recordsRead: [] });
    });

    it("another account's property: one row, denied, the id kept only as an argument", async () => {
      const context = await worldContext(WORLD.OTHER, WORLD.ORG_B, granted);
      const { result, row } = await logged(app, context, action, input);
      if (!hasProperty) {
        expect(result).toMatchObject({ ok: true });
        expect(row).toMatchObject({ organizationId: WORLD.ORG_B, outcome: "ok" });
        return;
      }
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      // The property column names only a property the member may use.
      expect(row).toMatchObject({ outcome: "denied", propertyId: null, recordsRead: [] });
      expect(row.arguments).toMatchObject({ propertyId: WORLD.P1 });
    });

    it("a row that can not be written: the answer is not handed on", async () => {
      const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted);
      const onLogFailure = vi.fn();
      const result = await runRouteAction(app, context, action, input, {
        client: "test_app",
        log: { record: () => Promise.reject(new Error("insert refused: secret detail")) },
        onLogFailure,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: "unavailable", message: "This is unavailable right now." },
      });
      expect(onLogFailure).toHaveBeenCalledTimes(1);
    });
  },
);

describe("the action log keeps only ids, dates and enum values (VAY-2508)", () => {
  it("the registered actions declare their ids and dates", () => {
    expect(Object.fromEntries(AI_ACTIONS.map((a) => [a.key, argumentKindsOf(a.input)]))).toEqual({
      "properties_list@1": {},
      "rooms_list@1": { propertyId: "id" },
      "calendar_days@1": { propertyId: "id", from: "date", to: "date" },
    });
  });

  it("free text, numbers and other strings are never declared", () => {
    const input = z.strictObject({
      roomId: z.uuid(),
      roomIds: z.array(z.uuid()).optional(),
      on: z.iso.date().nullable().optional(),
      at: z.iso.datetime().optional(),
      status: z.enum(["open", "closed"]).optional(),
      only: z.literal("active").optional(),
      includeReleased: z.boolean().optional(),
      search: z.string().optional(),
      guestName: z.string().max(60).optional(),
      email: z.email().optional(),
      limit: z.number().int().optional(),
      codes: z.array(z.string()).optional(),
    });
    expect(argumentKindsOf(input)).toEqual({
      roomId: "id",
      roomIds: "ids",
      on: "date",
      at: "date",
      status: { oneOf: ["open", "closed"] },
      only: { oneOf: ["active"] },
      includeReleased: "flag",
    });
  });
});

describe("calls that are refused before the route (VAY-2508)", () => {
  const sensitiveInAppOnly = defineRouteAction({
    name: "test_sensitive_read",
    version: 2,
    description: "A test action that reads guest data, offered in the app only.",
    route: "GET /api/pms/properties/:propertyId/room-types",
    output: z.object({ propertyId: z.string() }),
    permission: "pms.room_status.read",
    tier: "R2",
    surfaces: ["in_app"],
    reviewedBy: "test",
  });
  const neverReached = {} as never;

  it("an action not offered on this surface: one row, denied, a security event", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.room_status.read"], "mcp");
    const { result, row } = await logged(neverReached, context, sensitiveInAppOnly, {
      propertyId: WORLD.P1,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(row).toMatchObject({
      action: "test_sensitive_read",
      actionVersion: 2,
      group: "R2",
      sensitive: true,
      surface: "mcp",
      outcome: "denied",
      propertyId: WORLD.P1,
    });
  });

  it("a context that is not delegated: refused, and nothing runs", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.room_status.read"]);
    const notDelegated = { ...context, delegation: undefined } as RequestContext;
    const log = memoryAiActionLog();
    await expect(
      runRouteAction(
        neverReached,
        notDelegated,
        sensitiveInAppOnly,
        {},
        {
          log,
          client: "test_app",
        },
      ),
    ).rejects.toThrow(TypeError);
    expect(log.rows).toEqual([]);
  });

  it("an entry the log would refuse: the caller's mistake throws before the action runs", async () => {
    const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.room_status.read"]);
    const broken = {
      ...context,
      selectedOrganization: { ...context.selectedOrganization, organizationId: "org_a" },
    } as RequestContext;
    const route = vi.fn();
    const log = memoryAiActionLog();
    await expect(
      runRouteAction(
        { inject: route } as never,
        broken,
        sensitiveInAppOnly,
        {},
        {
          log,
          client: "test_app",
        },
      ),
    ).rejects.toThrow(TypeError);
    expect(route).not.toHaveBeenCalled();
    expect(log.rows).toEqual([]);
  });
});
