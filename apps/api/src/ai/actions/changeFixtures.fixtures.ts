// Fake storage for every registered AI change (VAY-2522): the real routes run on it, as the
// world's delegated users (actionTestWorld.fixtures.ts). Each records the commands its route
// hands to storage, and plants FORBIDDEN in every answer field the change's allow-list drops.
import type { PermissionKey } from "@vayada/backend-auth";
import type { ManagePhysicalRoomCommand } from "@vayada/domain-pms";

import type { buildApp } from "../../app.js";
import type { PmsInboxTriagePort } from "../../domains/pmsInbox.js";
import type { PmsOperationsCommandRepository } from "../../routes/pmsOperations.js";
import { ACTION_FIXTURES } from "./actionFixtures.fixtures.js";
import { FORBIDDEN } from "./actionTestWorld.fixtures.js";

type AppOptions = NonNullable<Parameters<typeof buildApp>[0]>;

export type ChangeFixture = {
  /** The change's key, e.g. "thread_mark_done@1". */
  action: string;
  /** buildApp options that mount the route on this fixture's fake storage. */
  appOptions: () => Partial<AppOptions>;
  /** The AI's input for a property. */
  input: (propertyId: string) => Record<string, unknown>;
  /** Permissions the route needs besides the change's own key. */
  alsoNeeds?: readonly PermissionKey[];
  /** The commands the route handed to storage so far. */
  commands: () => readonly unknown[];
  /** For a command that carries the AI's limits to its own rights check: the last one's. */
  narrowing?: () => unknown;
};

const ROOM_TYPE = "eeeeeeee-0000-4000-8000-000000000002";
const ROOM = "eeeeeeee-0000-4000-8000-000000000003";
const THREAD = "eeeeeeee-0000-4000-8000-000000000004";
const BOOKING = "eeeeeeee-0000-4000-8000-000000000005";
const BLOCK = "eeeeeeee-0000-4000-8000-000000000006";
const NOW = "2026-12-01T09:00:00.000Z";

/** The PMS read storage the PMS routes need to be mounted at all. */
const pmsRoutes = () => ACTION_FIXTURES.find((f) => f.action === "rooms_list@1")!.appOptions();

const commandMeta = {
  contractVersion: "pms-operations.v1",
  commandId: FORBIDDEN,
  idempotencyKey: FORBIDDEN,
  acceptedAt: NOW,
  sideEffects: [],
};

const triageInputs: Parameters<PmsInboxTriagePort["transition"]>[0][] = [];
const triagePort: PmsInboxTriagePort = {
  async transition(input) {
    triageInputs.push(input);
    return {
      ok: true,
      value: {
        propertyId: input.propertyId,
        threadId: input.threadId,
        attentionState:
          input.action === "done"
            ? "done"
            : input.action === "follow_up"
              ? "follow_up"
              : "needs_attention",
        followUpAt: input.followUpAt,
        threadVersion: input.expectedThreadVersion + 1,
      },
    };
  },
};

const roomCommands: ManagePhysicalRoomCommand[] = [];
const roomPort = {
  async managePhysicalRoom(command: ManagePhysicalRoomCommand) {
    roomCommands.push(command);
    return {
      ok: true as const,
      response: {
        propertyId: command.propertyId,
        roomTypeId: command.roomTypeId,
        roomUnitId: ROOM,
        roomUnitsRevision: command.expectedRevision + 1,
        outcome: "updated" as const,
      },
    };
  },
};

const opsCommands: unknown[] = [];
const block = (status: "active" | "released") => ({
  blockId: BLOCK,
  version: "2",
  roomTypeId: ROOM_TYPE,
  roomId: ROOM,
  startsOn: "2026-12-10",
  endsOn: "2026-12-12",
  blockedCount: 1,
  reason: `${FORBIDDEN}: staff free text`,
  status,
  sourceSummary: FORBIDDEN,
});
const opsRepository = {
  async createPrivateNote(command: { propertyId: string }) {
    opsCommands.push(command);
    return {
      ok: true,
      note: {
        noteId: "note-1",
        body: FORBIDDEN,
        authorUserId: FORBIDDEN,
        authorDisplayName: FORBIDDEN,
        createdAt: NOW,
        auditMetadata: { requestId: FORBIDDEN },
      },
      commandMeta,
    };
  },
  async createRoomBlocks(command: unknown) {
    opsCommands.push(command);
    return { ok: true, items: [block("active")], commandMeta };
  },
  async updateRoomBlock(command: unknown) {
    opsCommands.push(command);
    return { ok: true, items: [block("active")], commandMeta };
  },
  async releaseRoomBlock(command: unknown) {
    opsCommands.push(command);
    return { ok: true, items: [block("released")], commandMeta };
  },
} as unknown as PmsOperationsCommandRepository;

const threadFixture = (action: string, extra: Record<string, unknown> = {}): ChangeFixture => ({
  action,
  appOptions: () => ({ ...pmsRoutes(), pmsInboxTriagePort: triagePort }),
  input: (propertyId) => ({ propertyId, threadId: THREAD, expectedThreadVersion: 4, ...extra }),
  alsoNeeds: ["pms.inbox.read"],
  commands: () => triageInputs,
  narrowing: () => triageInputs.at(-1)?.narrowing,
});

export const CHANGE_FIXTURES: readonly ChangeFixture[] = [
  {
    action: "booking_note_add@1",
    appOptions: () => ({ ...pmsRoutes(), pmsOperationsCommandRepository: opsRepository }),
    input: (propertyId) => ({ propertyId, guestBookingId: BOOKING, body: "Late arrival, ~23:00" }),
    commands: () => opsCommands,
  },
  {
    action: "room_block_create@1",
    appOptions: () => ({ ...pmsRoutes(), pmsOperationsCommandRepository: opsRepository }),
    input: (propertyId) => ({
      propertyId,
      roomTypeId: ROOM_TYPE,
      roomIds: [ROOM],
      startsOn: "2026-12-10",
      endsOn: "2026-12-12",
      reason: "Painting",
    }),
    commands: () => opsCommands,
  },
  {
    action: "room_block_release@1",
    appOptions: () => ({ ...pmsRoutes(), pmsOperationsCommandRepository: opsRepository }),
    input: (propertyId) => ({ propertyId, blockId: BLOCK, expectedVersion: "1" }),
    commands: () => opsCommands,
  },
  {
    action: "room_status_set@1",
    appOptions: () => ({ pmsPhysicalRoomManagement: { commandPort: roomPort } }),
    input: (propertyId) => ({
      propertyId,
      roomTypeId: ROOM_TYPE,
      roomUnitId: ROOM,
      expectedRevision: 2,
      changes: { status: "maintenance" },
    }),
    commands: () => roomCommands,
    narrowing: () => roomCommands.at(-1)?.narrowing,
  },
  threadFixture("thread_mark_done@1"),
  threadFixture("thread_follow_up@1", { followUpAt: "2026-12-02T09:00:00.000Z" }),
  threadFixture("thread_reopen@1"),
];
