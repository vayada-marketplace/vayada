import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import { ApiErrorResponse } from "@/services/api/client";
import { RoomTypeRetirementBlockedError, type RoomTypeRetirementImpact } from "@/services/rooms";
import {
  roomTypeDeleteBlockedMessage,
  roomTypeDeleteErrorText,
  roomTypeDeleteMessage,
} from "./roomTypeDeleteText";

const t = (key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );
const impact = (overrides: Partial<RoomTypeRetirementImpact> = {}): RoomTypeRetirementImpact => ({
  contractVersion: "pms-room-type-lifecycle.v1",
  propertyId: "property-1",
  roomTypeId: "room-type-1",
  version: "room-type-facts-v3",
  canRetire: false,
  blockers: [],
  cleanup: { physicalUnits: 1, futureNights: 363, roomBlocks: 0, linkedGroups: 0 },
  ...overrides,
});

describe("room type Delete text (VAY-2132)", () => {
  it("says what one Delete cleans up", () => {
    expect(roomTypeDeleteMessage(t, "TEST ONLY calendar check", impact().cleanup!)).toBe(
      "Delete “TEST ONLY calendar check”? Its rooms (1) are retired. Its future nights (363) are closed and it leaves the calendar. Past bookings stay in your records. This can't be undone.",
    );
    expect(
      roomTypeDeleteMessage(t, "Villa", {
        physicalUnits: 2,
        futureNights: 3,
        roomBlocks: 2,
        linkedGroups: 1,
      }),
    ).toContain("Its room blocks (2) are released. It is taken out of its linked rooms.");
    // A room the calendar doesn't hold has no nights to mention.
    expect(
      roomTypeDeleteMessage(t, "Added later", {
        physicalUnits: 1,
        futureNights: 0,
        roomBlocks: 0,
        linkedGroups: 0,
      }),
    ).toBe(
      "Delete “Added later”? Its rooms (1) are retired. Past bookings stay in your records. This can't be undone.",
    );
  });

  it("says why Delete can't run yet, one sentence per blocker", () => {
    expect(
      roomTypeDeleteBlockedMessage(
        t,
        impact({
          blockers: [
            { category: "reservations", code: "active_reservations", affectedCount: 2, action: "" },
            { category: "inventory", code: "last_room_type", affectedCount: 1, action: "" },
          ],
        }),
      ),
    ).toBe(
      "This room type can't be deleted yet. It has bookings or holds (2): cancel, check out or move them first. It is your only room type: add another room type first.",
    );
  });

  it("explains a refused or changed Delete, and keeps today's text without the cleanup", () => {
    const blocked = impact({
      blockers: [
        { category: "publication", code: "channel_mapping", affectedCount: 1, action: "" },
      ],
    });
    expect(roomTypeDeleteErrorText(t, new RoomTypeRetirementBlockedError(blocked), "")).toContain(
      "It is connected in the Channel Manager",
    );
    expect(
      roomTypeDeleteErrorText(
        t,
        new ApiErrorResponse(409, {
          code: "room_type_retirement_blocked",
          impact: blocked,
        } as never),
        "",
      ),
    ).toContain("It is connected in the Channel Manager");
    expect(
      roomTypeDeleteErrorText(
        t,
        new ApiErrorResponse(403, { code: "room_type_delete_not_allowed", message: "Only…" }),
        "",
      ),
    ).toBe("Only the property's owner or operator can delete a room type.");
    // The route's own permission refusal keeps its text.
    expect(
      roomTypeDeleteErrorText(
        t,
        new ApiErrorResponse(403, {
          code: "missing_permission",
          message: "Missing required PMS operations permission.",
        }),
        "",
      ),
    ).toBe("Missing required PMS operations permission.");
    const legacy = new RoomTypeRetirementBlockedError(
      impact({
        cleanup: undefined,
        blockers: [
          {
            category: "physical_units",
            code: "active_physical_units",
            affectedCount: 1,
            action: "Retire every unit.",
          },
        ],
      }),
    );
    expect(roomTypeDeleteErrorText(t, legacy, "fallback")).toBe(
      "Room type cannot be retired yet. 1 affected: Retire every unit.",
    );
  });
});
