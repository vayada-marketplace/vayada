// One fixture per registered AI action (VAY-2507): how to mount its route on fake storage, what to
// ask, and which values must never leave. The generated safety tests run every action through its
// real route with these. A registered action without a fixture fails CI.
import type { PermissionKey } from "@vayada/backend-auth";

import type { buildApp } from "../../app.js";
import type { PmsOperationsReadRepository } from "../../domains/pmsOperationsReadModel.js";
import { FORBIDDEN, WORLD } from "./actionTestWorld.fixtures.js";

type AppOptions = NonNullable<Parameters<typeof buildApp>[0]>;

export type ActionFixture = {
  /** The action's key, e.g. "rooms_list@1". */
  action: string;
  /** buildApp options that mount the route on fake storage. Plant FORBIDDEN in dropped fields. */
  appOptions: () => Partial<AppOptions>;
  /** The input for a property (ignored by actions without a property). */
  input: (propertyId: string) => Record<string, unknown>;
  /** Permissions the route needs besides the action's own key. */
  alsoNeeds?: readonly PermissionKey[];
  /** Actions without a property in the route: the property ids an answer covers. */
  propertyIdsIn?: (data: unknown) => string[];
};

const room = (propertyId: string, n: number) => ({
  roomId: `room-${propertyId.slice(-2)}-${n}`,
  roomTypeId: `type-${propertyId.slice(-2)}`,
  roomNumber: `${n}01`,
  floor: `${n}`,
  status: "available",
  sortOrder: n,
  metadata: { note: FORBIDDEN, guest: FORBIDDEN },
});

const block = (propertyId: string) => ({
  blockId: `block-${propertyId.slice(-2)}`,
  version: FORBIDDEN,
  roomTypeId: `type-${propertyId.slice(-2)}`,
  roomId: null,
  startsOn: "2026-12-01",
  endsOn: "2026-12-02",
  blockedCount: 1,
  reason: `${FORBIDDEN}: staff free text`,
  status: "active",
  kind: "linked_booking",
  sourceRoomTypeId: null,
  sourceRoomTypeName: FORBIDDEN,
  sourceSummary: `${FORBIDDEN} Booking B-123`,
  protected: false,
});

const pmsOperationsRepository = {
  async listRoomsByPropertyId(propertyId: string) {
    return {
      items: [room(propertyId, 1), room(propertyId, 2)],
      sourceFreshness: { rooms: FORBIDDEN },
    };
  },
  async listCalendarDaysByPropertyId(propertyId: string, range: { from: string; to: string }) {
    return {
      items: [
        {
          stayDate: range.from,
          roomTypeId: `type-${propertyId.slice(-2)}`,
          totalCount: 4,
          assignedCount: 1,
          occupiedCount: 1,
          blockedCount: 1,
          availableCount: 2,
          status: "limited",
          blocks: [block(propertyId)],
          assignmentRefs: [FORBIDDEN],
          sourceFreshness: { calendar: FORBIDDEN },
        },
      ],
      sourceFreshness: { calendar: FORBIDDEN },
    };
  },
} as unknown as PmsOperationsReadRepository;

const shared_identity = {
  taskId: "shared_identity",
  ownerProgress: "not_started",
  readiness: "actionable",
  reasonCodes: ["shared_identity_incomplete"],
  sourceRevision: "1",
  freshness: "fresh",
};

export const ACTION_FIXTURES: readonly ActionFixture[] = [
  {
    action: "properties_list@1",
    appOptions: () => ({
      sharedHotelSetupStatusRepository: {
        async getHotelSetupStatus({ propertyIds }: { propertyIds: string[] }) {
          return {
            hotelGroupDisplayName: FORBIDDEN,
            hotelGroupWebsiteUrl: FORBIDDEN,
            properties: propertyIds.map((propertyId) => ({
              propertyId,
              publicId: `${FORBIDDEN}-${propertyId}`,
              // P2 is still in setup without a name: the action must still answer.
              displayName: propertyId === WORLD.P2 ? null : `Hotel ${propertyId.slice(-1)}`,
              locationSummary: "Munich, DE",
              taskFacts: { shared_identity },
            })),
          };
        },
      } as unknown as AppOptions["sharedHotelSetupStatusRepository"],
      hotelSetupTrackCommandRepository: {
        async getTrackStatus() {
          return { trackRevision: 1, selectedTracks: ["hotel_operations"], tracks: [] };
        },
        async updateTracks() {
          throw new Error("not used");
        },
        async close() {},
      } as unknown as AppOptions["hotelSetupTrackCommandRepository"],
    }),
    input: () => ({}),
    propertyIdsIn: (data) =>
      (
        data as { propertySelection: { availableProperties: { propertyId: string }[] } }
      ).propertySelection.availableProperties.map((p) => p.propertyId),
  },
  {
    action: "rooms_list@1",
    appOptions: () => ({ pmsOperationsRepository }),
    input: (propertyId) => ({ propertyId }),
  },
  {
    action: "calendar_days@1",
    appOptions: () => ({ pmsOperationsRepository }),
    input: (propertyId) => ({ propertyId, from: "2026-12-01", to: "2026-12-07" }),
  },
];

export { WORLD };
