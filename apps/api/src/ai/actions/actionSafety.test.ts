// Safety tests generated for every registered AI action (VAY-2507). Each action runs through its
// real route, as a real delegated user, on the fake storage of its fixture:
//   - no forbidden field leaves (planted values, and guest/contact/money keys planted everywhere),
//     and every allow-listed field is really exercised;
//   - no permission is skipped (without the declared key the route itself refuses);
//   - no other hotel: other property of the account for an assigned-only member, other account;
//   - every surface the action lists works, through the app's default delegation gate.
import { injectAsDelegate, type PermissionKey } from "@vayada/backend-auth";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { runDelegatedRead } from "../delegatedRead.js";
import { ACTION_FIXTURES, type ActionFixture } from "./actionFixtures.fixtures.js";
import { FORBIDDEN, WORLD, worldAuthorization, worldContext } from "./actionTestWorld.fixtures.js";
import { allowListPaths, type RouteAction } from "./defineRouteAction.js";
import { AI_ACTIONS } from "./registry.js";
import { runRouteAction } from "./runRouteAction.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

/** Guest, contact and money keys planted at every object level of a real route answer. */
const PLANTED_KEYS = [
  "email",
  "phone",
  "guestName",
  "primaryGuest",
  "passportNumber",
  "documentNumber",
  "totalAmount",
  "balanceAmount",
  "payout",
  "notes",
  "reason",
];

function plantEverywhere(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plantEverywhere);
  if (!value || typeof value !== "object") return value;
  const planted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) planted[key] = plantEverywhere(child);
  for (const key of PLANTED_KEYS) if (!(key in planted)) planted[key] = FORBIDDEN;
  return planted;
}

/** Every key path present in an answer, written like allowListPaths ("items[].roomNumber"). */
function presentPaths(value: unknown, path = ""): Set<string> {
  const found = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) for (const p of presentPaths(item, `${path}[]`)) found.add(p);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      found.add(childPath);
      for (const p of presentPaths(child, childPath)) found.add(p);
    }
  }
  return found;
}

/** A refusal must come from the route, not from the delegation layer. */
function expectRouteRefusal(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(403);
  expect(response.json().code).not.toBe("delegation_refused");
}

function split(action: RouteAction, input: Record<string, unknown>) {
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (action.pathParamNames.includes(name)) params[name] = String(value);
    else query[name] = String(value);
  }
  return { params, query };
}

function urlFor(action: RouteAction, fixture: ActionFixture, propertyId: string): string {
  const { query } = split(action, fixture.input(propertyId));
  const text = new URLSearchParams(query).toString();
  return action.routeUrl.replace(/:(propertyId|hotelId)/, propertyId) + (text ? `?${text}` : "");
}

describe("every registered AI action has a fixture (VAY-2507)", () => {
  it("adding an action without its safety tests fails", () => {
    expect(ACTION_FIXTURES.map((f) => f.action).sort()).toEqual(
      AI_ACTIONS.map((a) => a.key).sort(),
    );
  });
});

describe.each(ACTION_FIXTURES.map((fixture) => [fixture.action, fixture] as const))(
  "AI action %s",
  (key, fixture: ActionFixture) => {
    const action = AI_ACTIONS.find((candidate) => candidate.key === key)!;
    const granted: PermissionKey[] = [action.permission, ...(fixture.alsoNeeds ?? [])];
    // No `delegation` option: the app's own default gate (the registry) is what is tested.
    const withPermissions = (permissions: readonly PermissionKey[]) => {
      const app = buildApp({
        logger: false,
        ...fixture.appOptions(),
        auth: worldAuthorization(permissions).auth,
      });
      apps.push(app);
      return app;
    };
    const app = withPermissions(granted);
    const as = (userId: string, orgId: string, permissions = granted) =>
      worldContext(userId, orgId, permissions);
    const hasProperty = action.pathParamNames.some((n) => n === "propertyId" || n === "hotelId");
    const raw = async (userId: string, orgId: string, propertyId: string) =>
      injectAsDelegate(app, {
        context: await as(userId, orgId),
        method: "GET",
        routeUrl: action.routeUrl,
        url: urlFor(action, fixture, propertyId),
      });

    it("answers the owner, exercises every allow-listed field, and nothing planted leaves", async () => {
      const result = await runRouteAction(
        app,
        await as(WORLD.OWNER, WORLD.ORG_A),
        action,
        fixture.input(WORLD.P1),
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
      const present = presentPaths((result as { data: unknown }).data);
      expect(allowListPaths(action.output).filter((path) => !present.has(path))).toEqual([]);
    });

    it.each(action.surfaces)("runs on its %s surface", async (surface) => {
      const context = await worldContext(WORLD.OWNER, WORLD.ORG_A, granted, surface);
      const result = await runRouteAction(app, context, action, fixture.input(WORLD.P1));
      expect(result).toMatchObject({ ok: true });
    });

    it("drops guest, contact and money keys planted anywhere in the route's answer", async () => {
      const response = await runDelegatedRead(app, {
        context: await as(WORLD.OWNER, WORLD.ORG_A),
        routeUrl: action.routeUrl,
        ...split(action, fixture.input(WORLD.P1)),
      });
      expect(response.statusCode).toBe(200);
      const projected = action.output.parse(plantEverywhere(response.body));
      expect(JSON.stringify(projected)).not.toContain(FORBIDDEN);
    });

    it("is written against the route's current contract", async () => {
      if (!action.contractVersion) return;
      const response = await runDelegatedRead(app, {
        context: await as(WORLD.OWNER, WORLD.ORG_A),
        routeUrl: action.routeUrl,
        ...split(action, fixture.input(WORLD.P1)),
      });
      expect((response.body as { contractVersion?: string }).contractVersion).toBe(
        action.contractVersion,
      );
    });

    it(`the route itself refuses a user without ${action.permission}`, async () => {
      const without = granted.filter((permission) => permission !== action.permission);
      const appWithout = withPermissions(without);
      const context = await as(WORLD.OWNER, WORLD.ORG_A, without);
      expectRouteRefusal(
        await injectAsDelegate(appWithout, {
          context,
          method: "GET",
          routeUrl: action.routeUrl,
          url: urlFor(action, fixture, WORLD.P1),
        }),
      );
      const result = await runRouteAction(appWithout, context, action, fixture.input(WORLD.P1));
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    });

    it("answers an assigned-only member for their property only", async () => {
      const member = await as(WORLD.MEMBER, WORLD.ORG_A);
      const own = await runRouteAction(app, member, action, fixture.input(WORLD.P1));
      expect(own).toMatchObject({ ok: true });
      if (!hasProperty) {
        expect(fixture.propertyIdsIn!((own as { data: unknown }).data)).toEqual([WORLD.P1]);
        return;
      }
      const other = await runRouteAction(app, member, action, fixture.input(WORLD.P2));
      expect(other).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expectRouteRefusal(await raw(WORLD.MEMBER, WORLD.ORG_A, WORLD.P2));
    });

    it("never answers for another hotel account", async () => {
      const outsider = await as(WORLD.OTHER, WORLD.ORG_B);
      const result = await runRouteAction(app, outsider, action, fixture.input(WORLD.P1));
      if (!hasProperty) {
        expect(result).toMatchObject({ ok: true });
        expect(fixture.propertyIdsIn!((result as { data: unknown }).data)).toEqual([WORLD.P3]);
        return;
      }
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expectRouteRefusal(await raw(WORLD.OTHER, WORLD.ORG_B, WORLD.P1));
    });
  },
);

describe("the app's default delegation gate", () => {
  it("refuses a mounted route that is not a registered action's", async () => {
    const fixture = ACTION_FIXTURES.find((f) => f.action === "rooms_list@1")!;
    const app = buildApp({
      logger: false,
      ...fixture.appOptions(),
      auth: worldAuthorization(["pms.room_status.read", "pms.operations.read"]).auth,
    });
    apps.push(app);
    const routeUrl = "/api/pms/properties/:propertyId/room-types";
    const response = await injectAsDelegate(app, {
      context: await worldContext(WORLD.OWNER, WORLD.ORG_A, ["pms.room_status.read"]),
      method: "GET",
      routeUrl,
      url: routeUrl.replace(":propertyId", WORLD.P1),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "delegation_refused",
      message: expect.stringContaining("not delegable"),
    });
  });
});
