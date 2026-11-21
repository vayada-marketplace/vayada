// Rooms of one property and their state (VAY-2507 proving action; design note §3.2 rooms_status).
import { z } from "zod";

import { defineRouteAction } from "./defineRouteAction.js";

export const roomsList = defineRouteAction({
  name: "rooms_list",
  version: 1,
  description:
    "Lists the rooms of one property with their room number, floor, room type and state " +
    "(available, maintenance, out of order or retired). There is no clean/dirty housekeeping " +
    "state. Use properties_list first to get the property id.",
  route: "GET /api/pms/properties/:propertyId/rooms",
  output: z.object({
    propertyId: z.string(),
    items: z.array(
      z.object({
        roomId: z.string(),
        roomTypeId: z.string(),
        roomNumber: z.string(),
        floor: z.string().nullable(),
        status: z.enum(["available", "maintenance", "out_of_order", "retired"]),
      }),
    ),
  }),
  permission: "pms.room_status.read",
  tier: "R1",
  surfaces: ["mcp", "in_app"],
  contractVersion: "pms-operations.v1",
  reviewedBy: "VAY-2507",
});
