// Refusal tests generated for every registered AI change (VAY-2522). Each change runs through its
// real route, the app's default delegation gate, the real auth plugin and authorization resolver,
// as a real delegated user of the test world, on the fake storage of its fixture:
//   - the owner's change delegation runs it, and only the allow-listed answer comes back; an
//     assigned-only member runs it on their own property;
//   - a command that carries the AI's limits to its own rights check gets them, narrowed;
//   - refused: a read delegation, a property outside the delegation, an assigned-only member on
//     another property, another hotel account, a user without one of the route's permissions;
//   - the app holds the request itself to the change: no other field, no foreign retry key;
//   - the AI's input is checked first, and the AI never sets the retry key.
// The rights checks inside the transaction are tested on PostgreSQL in their domains
// (pmsInboxTriageCommand, pmsPhysicalRoomManagementRepository, pmsOperatingCalendarRoomRefresh).
import { randomUUID } from "node:crypto";

import {
  DelegationRefusedError,
  injectAsDelegate,
  resolveDelegatedChangeContext,
  type PermissionKey,
  type RequestContext,
} from "@vayada/backend-auth";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { CHANGE_FIXTURES, type ChangeFixture } from "./changeFixtures.fixtures.js";
import {
  WORLD,
  FORBIDDEN,
  worldAuthorization,
  worldContext,
  worldIdentity,
} from "./actionTestWorld.fixtures.js";
import { changeRequest, type ChangeAction } from "./defineChangeAction.js";
import { CHANGE_ACTIONS } from "./registry.js";

const { OWNER, MEMBER, OTHER, ORG_A, ORG_B, P1, P2 } = WORLD;
const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

let calls = 0;

/** `userId`'s change delegation in `organizationId`, as the executor will mint it (VAY-2524). */
function changeContext(
  userId: string,
  organizationId: string,
  permissions: readonly PermissionKey[],
  propertyIds?: string[],
): Promise<RequestContext> {
  return resolveDelegatedChangeContext(
    worldIdentity,
    {
      userId,
      organizationId,
      delegation: {
        channel: "in_app",
        conversationId: WORLD.CONVERSATION,
        toolCallId: `call_change_${++calls}`,
      },
      ...(propertyIds ? { propertyIds } : {}),
    },
    { authorizationResolver: worldAuthorization(permissions).resolver },
  );
}

/** A refusal from the route itself, not from the delegation layer. */
function expectRouteRefusal(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(403);
  expect(response.json().code).not.toBe("delegation_refused");
}

describe("every registered AI change has a fixture (VAY-2522)", () => {
  it("adding a change without its refusal tests fails", () => {
    expect(CHANGE_FIXTURES.map((f) => f.action).sort()).toEqual(
      CHANGE_ACTIONS.map((a) => a.key).sort(),
    );
  });

  it("checks that the AI's limits reach every change that lists a rights check", () => {
    for (const fixture of CHANGE_FIXTURES) {
      const action = CHANGE_ACTIONS.find((candidate) => candidate.key === fixture.action)!;
      expect(Boolean(fixture.narrowing), action.key).toBe(action.authoritySites.length > 0);
    }
  });
});

describe.each(CHANGE_FIXTURES.map((fixture) => [fixture.action, fixture] as const))(
  "AI change %s",
  (key, fixture: ChangeFixture) => {
    const action: ChangeAction = CHANGE_ACTIONS.find((candidate) => candidate.key === key)!;
    const granted: PermissionKey[] = [action.permission, ...(action.alsoNeeds ?? [])];
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
    const run = (context: RequestContext, propertyId: string, on = app) => {
      const built = changeRequest(action, fixture.input(propertyId), `op_${randomUUID()}:1`);
      if (!built.ok) throw new Error(built.message);
      return injectAsDelegate(on, { context, ...built.request });
    };
    const refusedWithoutCommand = async (response: Promise<LightMyRequestResponse>) => {
      const before = fixture.commands().length;
      expectRouteRefusal(await response);
      expect(fixture.commands().length).toBe(before);
    };
    const runsOnce = async (response: Promise<LightMyRequestResponse>) => {
      const before = fixture.commands().length;
      const done = await response;
      expect(done.statusCode, done.body).toBeLessThan(300);
      expect(fixture.commands().length).toBe(before + 1);
    };

    it("runs for the owner's change delegation; only the allow-listed answer comes back", async () => {
      const before = fixture.commands().length;
      const response = await run(await changeContext(OWNER, ORG_A, granted), P1);
      expect(response.statusCode, response.body).toBeLessThan(300);
      expect(fixture.commands().length).toBe(before + 1);
      const answer = action.output.safeParse(response.json());
      expect(answer.success).toBe(true);
      expect(JSON.stringify(answer.data)).not.toContain(FORBIDDEN);
      if (action.contractVersion) {
        expect(response.json().contractVersion).toBe(action.contractVersion);
      }
    });

    it("runs for an assigned-only member on their own property", async () => {
      await runsOnce(run(await changeContext(MEMBER, ORG_A, granted), P1));
    });

    it.runIf(fixture.narrowing)(
      "hands the AI's limits to the command's own rights check",
      async () => {
        await runsOnce(run(await changeContext(OWNER, ORG_A, granted), P1));
        expect(fixture.narrowing!()).toEqual({ access: "change", propertyIds: [P1, P2] });
        await runsOnce(run(await changeContext(OWNER, ORG_A, granted, [P2]), P2));
        expect(fixture.narrowing!()).toEqual({ access: "change", propertyIds: [P2] });
        await runsOnce(run(await changeContext(MEMBER, ORG_A, granted), P1));
        expect(fixture.narrowing!()).toEqual({ access: "change", propertyIds: [P1] });
      },
    );

    it("the app refuses a request that is not exactly the change", async () => {
      const context = () => changeContext(OWNER, ORG_A, granted);
      const built = changeRequest(action, fixture.input(P1), `op_${randomUUID()}:1`);
      if (!built.ok) throw new Error(built.message);
      const refused = async (request: typeof built.request, reason: RegExp) => {
        const before = fixture.commands().length;
        const response = await injectAsDelegate(app, { context: await context(), ...request });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: "delegation_refused", message: reason });
        expect(fixture.commands().length).toBe(before);
      };
      // A field the change does not let the AI send, also one the route itself would take.
      await refused(
        { ...built.request, body: { ...built.request.body, smuggled: FORBIDDEN } },
        /not what this change lets/,
      );
      // A retry key that is not bound to this change, in the header and the body alike.
      const loose = `op_${randomUUID()}:1`;
      const keyFields = action.idempotency.in === "body" ? action.idempotency.fields : [];
      const looseBody = { ...built.request.body };
      for (const field of keyFields) looseBody[field] = loose;
      await refused(
        { ...built.request, idempotencyKey: loose, body: looseBody },
        /retry key is not this change's/,
      );
      if (keyFields.length > 0) {
        // The body's retry key must be the request's own.
        await refused(
          { ...built.request, body: { ...built.request.body, [keyFields[0]!]: "other-key-1" } },
          /retry key in the body/,
        );
      }
    });

    it("refuses a read delegation: only the executor's may write", async () => {
      const before = fixture.commands().length;
      await expect(run(await worldContext(OWNER, ORG_A, granted), P1)).rejects.toThrow(
        DelegationRefusedError,
      );
      expect(fixture.commands().length).toBe(before);
    });

    it("the route refuses a property outside the delegation's limits", async () => {
      await refusedWithoutCommand(run(await changeContext(OWNER, ORG_A, granted, [P1]), P2));
    });

    it("the route refuses an assigned-only member on another property", async () => {
      await refusedWithoutCommand(run(await changeContext(MEMBER, ORG_A, granted), P2));
    });

    it("never changes another hotel account", async () => {
      await refusedWithoutCommand(run(await changeContext(OTHER, ORG_B, granted), P1));
    });

    it(`the route itself refuses a user without ${action.permission}`, async () => {
      for (const missing of granted) {
        const without = granted.filter((permission) => permission !== missing);
        await refusedWithoutCommand(
          run(await changeContext(OWNER, ORG_A, without), P1, withPermissions(without)),
        );
      }
    });

    it("checks the AI's input before anything runs; the AI never sets the retry key", () => {
      const key = `op_${randomUUID()}:1`;
      const input = fixture.input(P1);
      expect(changeRequest(action, { ...input, smuggled: FORBIDDEN }, key)).toMatchObject({
        ok: false,
      });
      expect(changeRequest(action, { ...input, propertyId: "P1" }, key)).toMatchObject({
        ok: false,
      });
      const built = changeRequest(action, input, key);
      const routeKey = `${key}:${action.name}`;
      expect(built).toMatchObject({ ok: true, request: { idempotencyKey: routeKey } });
      if (action.idempotency.in === "body") {
        for (const field of action.idempotency.fields) {
          expect(changeRequest(action, { ...input, [field]: "mine" }, key)).toMatchObject({
            ok: false,
          });
          expect(built.ok && built.request.body[field]).toBe(routeKey);
        }
      }
    });
  },
);
