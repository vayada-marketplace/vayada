// The versions vayada reads when the AI asks for a change (VAY-2524), through the app's real read
// routes, the default delegation gate and the real auth plugin, as a delegated user of the test
// world, on fake storage: each change to a record that exists gets its record's version from its
// own read route, with the person's rights and the delegation's property scope.
import type { PermissionKey } from "@vayada/backend-auth";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import type { PmsInboxReadPort } from "../../domains/pmsInbox.js";
import type { PmsOperationsReadRepository } from "../../domains/pmsOperationsReadModel.js";
import { WORLD, worldAuthorization, worldContext } from "../actions/actionTestWorld.fixtures.js";
import type { ChangeAction } from "../actions/defineChangeAction.js";
import { CHANGE_ACTIONS, findChangeAction } from "../actions/registry.js";
import { readCurrentState } from "./currentState.js";

const { OWNER, MEMBER, ORG_A, P1, P2 } = WORLD;
const DELUXE = "eeeeeeee-0000-4000-8000-000000000001";
const R12 = "ffffffff-0000-4000-8000-000000000012";
const BLOCK = "abababab-0000-4000-8000-000000000001";
const RELEASED = "abababab-0000-4000-8000-000000000002";
const THREAD = "acacacac-0000-4000-8000-000000000001";
const OTHER = "abababab-0000-4000-8000-000000000099";
const READS: PermissionKey[] = ["pms.room_status.read", "pms.calendar.read", "pms.inbox.read"];

const block = (blockId: string, status: string) => ({
  blockId,
  version: status === "active" ? "3" : "4",
  roomTypeId: DELUXE,
  roomId: R12,
  startsOn: "2026-12-12",
  endsOn: "2026-12-14",
  blockedCount: 1,
  reason: "staff text",
  status,
});

let broken: "shape" | "throws" | undefined;
const repository = {
  async listRoomsByPropertyId() {
    if (broken === "throws") throw new Error("read model down");
    const room = {
      roomId: R12,
      roomTypeId: DELUXE,
      roomNumber: "12",
      floor: "1",
      status: "available",
      sortOrder: 1,
      // The read model adds the room type's rooms revision to every room's metadata.
      metadata: { roomUnitsRevision: 7 },
    };
    return {
      items: [broken === "shape" ? { ...room, metadata: { roomUnitsRevision: "7" } } : room],
    };
  },
  async listRoomBlocksByPropertyId() {
    return { items: [block(BLOCK, "active"), block(RELEASED, "released")] };
  },
} as unknown as PmsOperationsReadRepository;

const inbox = {
  async getThread({ propertyId, threadId }: { propertyId: string; threadId: string }) {
    if (threadId !== THREAD) return { ok: false, error: { code: "thread_not_found" } };
    return {
      ok: true,
      value: {
        propertyId,
        thread: {
          id: threadId,
          version: 4,
          attentionState: "needs_attention",
          followUpAt: null,
          assignedTo: null,
          channel: "ota",
          providerChannel: "airbnb",
          guest: { displayName: "Anna Keller" },
          conversationContext: { state: "unlinked" },
          unreadCount: 1,
          activityAt: "2026-12-09T08:00:00.000Z",
          lastMessage: { preview: null, at: "2026-12-09T08:00:00.000Z", hasAttachments: false },
          replyRoute: { kind: "none" },
        },
        availableProviderActions: [],
        timeline: [],
        previousCursor: null,
      },
    };
  },
} as unknown as PmsInboxReadPort;

let app: ReturnType<typeof buildApp> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  broken = undefined;
});

const change = (key: string): ChangeAction => findChangeAction(key)!;

/** Reads `key`'s versions as `user`'s in-app tool call, with `permissions`. */
async function read(
  key: string,
  input: Record<string, unknown>,
  { user = OWNER, permissions = READS }: { user?: string; permissions?: PermissionKey[] } = {},
) {
  await app?.close();
  // No `delegation` option: the app's own default gate (the registry) is what is tested.
  app = buildApp({
    logger: false,
    pmsOperationsRepository: repository,
    pmsInboxReadPort: inbox,
    auth: worldAuthorization(permissions).auth,
  });
  const context = await worldContext(user, ORG_A, permissions);
  return readCurrentState(app, context, change(key), input);
}

const status = { propertyId: P1, roomTypeId: DELUXE, roomUnitId: R12 };

describe("the versions vayada reads when the AI asks (VAY-2524)", () => {
  it("reads every change to a record that exists from its own read route", async () => {
    expect(
      await read("room_status_set@1", { ...status, changes: { status: "maintenance" } }),
    ).toEqual({ ok: true, values: { expectedRevision: 7 } });
    expect(await read("room_block_release@1", { propertyId: P1, blockId: BLOCK })).toEqual({
      ok: true,
      values: { expectedVersion: "3" },
    });
    for (const key of ["thread_mark_done@1", "thread_reopen@1"]) {
      expect(await read(key, { propertyId: P1, threadId: THREAD }), key).toEqual({
        ok: true,
        values: { expectedThreadVersion: 4 },
      });
    }
    // A note is new: nothing to read.
    expect(
      await read("booking_note_add@1", { propertyId: P1, guestBookingId: R12, body: "x" }),
    ).toEqual({ ok: true, values: {} });
    // Every change that has preconditions is covered above or shares its read.
    expect(
      CHANGE_ACTIONS.filter((action) => action.currentState).map((action) => action.key),
    ).toEqual(
      expect.arrayContaining(["room_block_release@1", "room_status_set@1", "thread_mark_done@1"]),
    );
  });

  it("finds the record in any letter case", async () => {
    expect(
      await read("room_block_release@1", { propertyId: P1, blockId: BLOCK.toUpperCase() }),
    ).toEqual({ ok: true, values: { expectedVersion: "3" } });
  });

  it("answers missing for a record that is not there, or a block already released", async () => {
    expect(
      await read("room_status_set@1", {
        ...status,
        roomUnitId: OTHER,
        changes: { status: "maintenance" },
      }),
    ).toEqual({ ok: false, reason: "missing" });
    // The room exists, but not in the room type the change names.
    expect(
      await read("room_status_set@1", {
        ...status,
        roomTypeId: OTHER,
        changes: { status: "maintenance" },
      }),
    ).toEqual({ ok: false, reason: "missing" });
    expect(await read("room_block_release@1", { propertyId: P1, blockId: OTHER })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await read("room_block_release@1", { propertyId: P1, blockId: RELEASED })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await read("thread_mark_done@1", { propertyId: P1, threadId: OTHER })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reads only what the person may read, on the delegation's properties", async () => {
    // The member may use P1 only: P2 is outside the delegation.
    expect(
      await read("room_block_release@1", { propertyId: P2, blockId: BLOCK }, { user: MEMBER }),
    ).toEqual({ ok: false, reason: "not_allowed" });
    // Without the inbox read the route itself refuses the conversation.
    expect(
      await read(
        "thread_mark_done@1",
        { propertyId: P1, threadId: THREAD },
        { permissions: ["pms.calendar.read"] },
      ),
    ).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("answers unavailable when the read fails or answers another shape", async () => {
    broken = "throws";
    expect(
      await read("room_status_set@1", { ...status, changes: { status: "maintenance" } }),
    ).toEqual({ ok: false, reason: "unavailable" });
    broken = "shape";
    expect(
      await read("room_status_set@1", { ...status, changes: { status: "maintenance" } }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });
});
