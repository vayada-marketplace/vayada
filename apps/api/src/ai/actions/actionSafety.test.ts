// Safety tests generated for every registered AI action (VAY-2507). Each action runs through its
// real route, as a real delegated user, on the fake storage of its fixture:
//   - no forbidden field leaves (planted values, and guest/contact/money keys planted everywhere);
//   - no permission is skipped (without the declared key the route itself refuses);
//   - no other hotel: other property of the account for an assigned-only member, other account.
import { injectAsDelegate, type PermissionKey } from "@vayada/backend-auth";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { runDelegatedRead } from "../delegatedRead.js";
import { ACTION_FIXTURES, type ActionFixture } from "./actionFixtures.fixtures.js";
import { FORBIDDEN, WORLD, worldAuthorization, worldContext } from "./actionTestWorld.fixtures.js";
import { AI_ACTIONS, aiActionRouteGate } from "./registry.js";
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
    const withPermissions = (permissions: readonly PermissionKey[]) => {
      const app = buildApp({
        logger: false,
        ...fixture.appOptions(),
        auth: { ...worldAuthorization(permissions).auth, delegation: aiActionRouteGate },
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
        url:
          action.routeUrl.replace(/:(propertyId|hotelId)/, propertyId) + query(fixture, propertyId),
      });

    it("answers the owner for their property, with nothing planted in its output", async () => {
      const result = await runRouteAction(
        app,
        await as(WORLD.OWNER, WORLD.ORG_A),
        action,
        fixture.input(WORLD.P1),
        "in_app",
      );
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain(FORBIDDEN);
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
      const response = await injectAsDelegate(appWithout, {
        context,
        method: "GET",
        routeUrl: action.routeUrl,
        url: action.routeUrl.replace(/:(propertyId|hotelId)/, WORLD.P1) + query(fixture, WORLD.P1),
      });
      expect([401, 403]).toContain(response.statusCode);
      const result = await runRouteAction(
        appWithout,
        context,
        action,
        fixture.input(WORLD.P1),
        "in_app",
      );
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    });

    it("answers an assigned-only member for their property only", async () => {
      const member = await as(WORLD.MEMBER, WORLD.ORG_A);
      const own = await runRouteAction(app, member, action, fixture.input(WORLD.P1), "in_app");
      expect(own).toMatchObject({ ok: true });
      if (!hasProperty) {
        expect(fixture.propertyIdsIn!((own as { data: unknown }).data)).toEqual([WORLD.P1]);
        return;
      }
      const other = await runRouteAction(app, member, action, fixture.input(WORLD.P2), "in_app");
      expect(other).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expect((await raw(WORLD.MEMBER, WORLD.ORG_A, WORLD.P2)).statusCode).toBe(403);
    });

    it("never answers for another hotel account", async () => {
      const outsider = await as(WORLD.OTHER, WORLD.ORG_B);
      const result = await runRouteAction(app, outsider, action, fixture.input(WORLD.P1), "in_app");
      if (!hasProperty) {
        expect(result).toMatchObject({ ok: true });
        expect(fixture.propertyIdsIn!((result as { data: unknown }).data)).toEqual([WORLD.P3]);
        return;
      }
      expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expect((await raw(WORLD.OTHER, WORLD.ORG_B, WORLD.P1)).statusCode).toBe(403);
    });
  },
);

function split(action: (typeof AI_ACTIONS)[number], input: Record<string, unknown>) {
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (action.pathParamNames.includes(name)) params[name] = String(value);
    else query[name] = String(value);
  }
  return { params, query };
}

function query(fixture: ActionFixture, propertyId: string): string {
  const action = AI_ACTIONS.find((candidate) => candidate.key === fixture.action)!;
  const { query: values } = split(action, fixture.input(propertyId));
  const text = new URLSearchParams(values).toString();
  return text ? `?${text}` : "";
}
