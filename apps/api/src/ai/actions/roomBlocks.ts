// Blocking rooms for some nights, and releasing a block (VAY-2522, first change batch).
import { z } from "zod";

import { defineChangeAction } from "./defineChangeAction.js";

const shared = {
  version: 1,
  // The route takes its retry key from the body.
  idempotency: { in: "body", fields: ["commandId", "idempotencyKey"] },
  authoritySites: [],
  group: "ask",
  permission: "pms.calendar.manage",
  // The block's own reason text stays out: it is free text the hotel wrote.
  output: z.object({
    propertyId: z.string(),
    items: z.array(
      z.object({
        blockId: z.string(),
        version: z.string(),
        roomTypeId: z.string(),
        roomId: z.string().nullable(),
        startsOn: z.string(),
        endsOn: z.string(),
        status: z.enum(["active", "released", "expired"]),
      }),
    ),
  }),
  surfaces: [],
  contractVersion: "pms-operations.v1",
  reviewedBy: "VAY-2522",
} as const;

export const roomBlockCreate = defineChangeAction({
  ...shared,
  name: "room_block_create",
  description:
    "Blocks rooms of one room type of a property from the first to the last night given, so they " +
    "can't be booked. Use rooms_list for the rooms. The person confirms it in vayada before it " +
    "runs.",
  route: "POST /api/pms/properties/:propertyId/room-blocks",
  body: z.strictObject({
    roomTypeId: z.uuid(),
    roomIds: z.array(z.uuid()).min(1).max(100),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    reason: z.string().trim().max(500).optional(),
  }),
  preconditions: [],
});

export const roomBlockRelease = defineChangeAction({
  ...shared,
  name: "room_block_release",
  description:
    "Releases one room block of a property, so its rooms can be booked again. Send the block's " +
    "current version. The person confirms it in vayada before it runs.",
  route: "DELETE /api/pms/properties/:propertyId/room-blocks/:blockId",
  pathParams: { blockId: z.uuid() },
  body: z.strictObject({ expectedVersion: z.string().min(1).max(100) }),
  preconditions: ["expectedVersion"],
});
