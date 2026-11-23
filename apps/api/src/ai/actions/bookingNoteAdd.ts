// A private staff note on a booking (VAY-2522, first change batch).
import { z } from "zod";

import { defineChangeAction } from "./defineChangeAction.js";

export const bookingNoteAdd = defineChangeAction({
  name: "booking_note_add",
  version: 1,
  description:
    "Adds a private staff note to one booking of a property. Guests never see it. The person " +
    "confirms it in vayada before it runs.",
  route: "POST /api/pms/properties/:propertyId/reservations/:guestBookingId/notes",
  pathParams: { guestBookingId: z.uuid() },
  body: z.strictObject({ body: z.string().trim().min(1).max(5000) }),
  // The route takes its retry key from the body; a new note has nothing to compare.
  idempotency: { in: "body", fields: ["commandId", "idempotencyKey"] },
  preconditions: [],
  addsNew: true,
  authoritySites: [],
  group: "ask",
  permission: "pms.reservation.update",
  output: z.object({
    propertyId: z.string(),
    guestBookingId: z.string(),
    note: z.object({ noteId: z.string(), createdAt: z.string() }),
  }),
  surfaces: [],
  contractVersion: "pms-operations.v1",
  reviewedBy: "VAY-2522",
});
