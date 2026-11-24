// A room's state: available, maintenance or out of order (VAY-2522, first change batch).
import { z } from "zod";

import { defineChangeAction, sameRecordId } from "./defineChangeAction.js";

const rooms = z.object({
  items: z.array(
    z.object({
      roomId: z.string(),
      roomTypeId: z.string(),
      metadata: z.object({ roomUnitsRevision: z.number().optional() }).nullish(),
    }),
  ),
});

export const roomStatusSet = defineChangeAction({
  name: "room_status_set",
  version: 1,
  description:
    "Sets one room of a property to available, maintenance or out of order. Use rooms_list for " +
    "the room and its room type. vayada refuses it for a room that ever had a booking or a " +
    "block, and maintenance or out of order once its room type sells rooms from today on. The " +
    "person confirms it in vayada before it runs.",
  // The physical-room update; the AI may send only the state (not the number or the floor).
  route: "PUT /api/pms/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId",
  pathParams: { roomTypeId: z.uuid(), roomUnitId: z.uuid() },
  body: z.strictObject({
    expectedRevision: z.number().int().min(1).max(2147483646),
    changes: z.strictObject({ status: z.enum(["available", "maintenance", "out_of_order"]) }),
  }),
  idempotency: { in: "header" },
  preconditions: ["expectedRevision"],
  // The room type's rooms revision, from the rooms list, as the PMS sends it back.
  currentState: {
    route: "GET /api/pms/properties/:propertyId/rooms",
    pick(answer, input) {
      const room = rooms
        .parse(answer)
        .items.find(
          (item) =>
            sameRecordId(item.roomId, input.roomUnitId) &&
            sameRecordId(item.roomTypeId, input.roomTypeId),
        );
      return room ? { expectedRevision: room.metadata?.roomUnitsRevision } : null;
    },
  },
  authoritySites: ["pms_physical_room_scope", "pms_calendar_room_follow_up"],
  group: "ask",
  permission: "pms.operations.manage",
  output: z.object({
    propertyId: z.string(),
    roomTypeId: z.string(),
    roomUnitId: z.string(),
    roomUnitsRevision: z.number(),
    outcome: z.enum(["created", "updated", "retired"]),
  }),
  surfaces: [],
  reviewedBy: "VAY-2522",
});
