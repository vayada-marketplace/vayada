// Occupancy and blocks per room type and night (VAY-2507 proving action; design note §3.2
// calendar_get). Drops other bookings' ids, block reasons (staff free text) and source summaries.
import { z } from "zod";

import { defineRouteAction } from "./defineRouteAction.js";

/** At most about two months per call (VAY-2567 rank 8: the route allows 370 days). */
export const CALENDAR_MAX_DAYS = 62;

const isoDate = z.iso.date();

export const calendarDays = defineRouteAction({
  name: "calendar_days",
  version: 1,
  description:
    "Shows, for one property and a date range of at most 62 nights, how many rooms of each " +
    "room type are free, occupied, assigned or blocked per night, the night's status " +
    "(open, closed or limited) and the room blocks. `from` and `to` are dates (YYYY-MM-DD), " +
    "both included.",
  route: "GET /api/pms/properties/:propertyId/calendar",
  query: { from: isoDate, to: isoDate },
  check: ({ from, to }) => {
    const nights = (Date.parse(String(to)) - Date.parse(String(from))) / 86_400_000 + 1;
    if (!(nights >= 1)) return "to must be on or after from";
    return nights > CALENDAR_MAX_DAYS ? `ask for at most ${CALENDAR_MAX_DAYS} nights` : null;
  },
  output: z.object({
    propertyId: z.string(),
    days: z.array(
      z.object({
        stayDate: z.string(),
        roomTypeId: z.string(),
        totalCount: z.number(),
        assignedCount: z.number(),
        occupiedCount: z.number(),
        blockedCount: z.number(),
        availableCount: z.number(),
        status: z.enum(["open", "closed", "limited"]),
        blocks: z.array(
          z.object({
            blockId: z.string(),
            roomTypeId: z.string(),
            roomId: z.string().nullable(),
            startsOn: z.string(),
            endsOn: z.string(),
            blockedCount: z.number(),
            status: z.enum(["active", "released", "expired"]),
          }),
        ),
      }),
    ),
  }),
  permission: "pms.calendar.read",
  tier: "R1",
  surfaces: ["mcp", "in_app"],
  contractVersion: "pms-operations.v1",
  reviewedBy: "VAY-2507",
});
