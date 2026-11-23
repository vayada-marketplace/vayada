// The first AI changes hand the delegation's limits to the rights check their command repeats inside
// its transaction (VAY-2522). Each runs through its real route as a real change delegation, behind a
// gate that lets exactly these routes through (no change action is registered yet); the command
// must carry the narrowing. A person's request carries null (app.test.ts,
// pmsPhysicalRoomUnitRoutes.test.ts); the checks themselves are tested on PostgreSQL.
import {
  injectAsDelegate,
  resolveDelegatedChangeContext,
  type AuthorityNarrowing,
  type PermissionKey,
} from "@vayada/backend-auth";
import type { ManagePhysicalRoomCommand } from "@vayada/domain-pms";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import type { PmsInboxTriagePort } from "../../domains/pmsInbox.js";
import { ACTION_FIXTURES } from "./actionFixtures.fixtures.js";
import { WORLD, worldAuthorization, worldIdentity } from "./actionTestWorld.fixtures.js";

const { OWNER, MEMBER, ORG_A, P1, P2 } = WORLD;
const PERMISSIONS: PermissionKey[] = ["pms.inbox.read", "pms.inbox.reply", "pms.operations.manage"];
const THREAD = "eeeeeeee-0000-4000-8000-000000000001";
const ROOM_TYPE = "eeeeeeee-0000-4000-8000-000000000002";
const ROOM_UNIT = "eeeeeeee-0000-4000-8000-000000000003";

/** Marking a thread done, and room status (the physical-room update). */
const ROUTES = {
  thread_done: {
    method: "POST",
    routeUrl: "/api/pms/properties/:propertyId/messaging/threads/:threadId/done",
    body: { expectedThreadVersion: 4 },
  },
  room_status: {
    method: "PUT",
    routeUrl: "/api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId",
    body: { expectedRevision: 2, changes: { status: "maintenance" } },
  },
} as const;
type Route = keyof typeof ROUTES;

const triageInputs: Parameters<PmsInboxTriagePort["transition"]>[0][] = [];
const roomCommands: ManagePhysicalRoomCommand[] = [];
const app = buildApp({
  logger: false,
  ...ACTION_FIXTURES.find((fixture) => fixture.action === "rooms_list@1")!.appOptions(),
  auth: {
    ...worldAuthorization(PERMISSIONS).auth,
    delegation: {
      allowsRoute: (method, routeUrl) =>
        Object.values(ROUTES).some(
          (route) => route.method === method && route.routeUrl === routeUrl,
        ),
    },
  },
  pmsInboxTriagePort: {
    async transition(input) {
      triageInputs.push(input);
      return {
        ok: true,
        value: {
          propertyId: input.propertyId,
          threadId: input.threadId,
          attentionState: "done",
          followUpAt: null,
          threadVersion: input.expectedThreadVersion + 1,
        },
      };
    },
  },
  pmsPhysicalRoomManagement: {
    commandPort: {
      async managePhysicalRoom(command) {
        roomCommands.push(command);
        return {
          ok: true,
          response: {
            propertyId: command.propertyId,
            roomTypeId: command.roomTypeId,
            roomUnitId: ROOM_UNIT,
            roomUnitsRevision: command.expectedRevision + 1,
            outcome: "updated",
          },
        };
      },
    },
  },
});
afterAll(() => app.close());

let calls = 0;

/** Runs the route as `userId`'s change delegation in account A, optionally narrowed. */
async function change(route: Route, userId: string, propertyId: string, propertyIds?: string[]) {
  const call = ++calls;
  const context = await resolveDelegatedChangeContext(
    worldIdentity,
    {
      userId,
      organizationId: ORG_A,
      delegation: {
        channel: "in_app",
        conversationId: WORLD.CONVERSATION,
        toolCallId: `call_narrowing_${call}`,
      },
      ...(propertyIds ? { propertyIds } : {}),
    },
    { authorizationResolver: worldAuthorization(PERMISSIONS).resolver },
  );
  const { method, routeUrl, body } = ROUTES[route];
  return injectAsDelegate(app, {
    context,
    method,
    routeUrl,
    url: routeUrl
      .replace(":propertyId", propertyId)
      .replace(":threadId", THREAD)
      .replace(":roomTypeId", ROOM_TYPE)
      .replace(":roomUnitId", ROOM_UNIT),
    body,
    idempotencyKey: `op_narrowing_${call}:1`,
  });
}

const commands = () => triageInputs.length + roomCommands.length;

/** The narrowing the route's last command carried. */
const lastNarrowing = (route: Route): AuthorityNarrowing | null | undefined =>
  route === "thread_done" ? triageInputs.at(-1)?.narrowing : roomCommands.at(-1)?.narrowing;

describe.each(Object.keys(ROUTES) as Route[])(
  "%s hands the delegation's limits to its command (VAY-2522)",
  (route) => {
    it("an owner's full delegation: change, on every property of the account", async () => {
      const before = commands();
      expect((await change(route, OWNER, P1)).statusCode).toBe(200);
      expect(commands()).toBe(before + 1);
      expect(lastNarrowing(route)).toEqual({ access: "change", propertyIds: [P1, P2] });
    });

    it("a delegation narrowed to one property: that property only", async () => {
      expect((await change(route, OWNER, P2, [P2])).statusCode).toBe(200);
      expect(lastNarrowing(route)).toEqual({ access: "change", propertyIds: [P2] });
    });

    it("a member assigned to one property: that property only", async () => {
      expect((await change(route, MEMBER, P1)).statusCode).toBe(200);
      expect(lastNarrowing(route)).toEqual({ access: "change", propertyIds: [P1] });
    });

    it("the route itself still refuses a property outside the narrowing", async () => {
      const before = commands();
      const response = await change(route, OWNER, P2, [P1]);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).not.toBe("delegation_refused");
      expect(commands()).toBe(before);
    });
  },
);
