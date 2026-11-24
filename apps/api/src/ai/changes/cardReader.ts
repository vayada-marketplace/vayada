// Reads the records a Yes/No card names (VAY-2524) through the app's own read routes, as the
// person who answers: their access token, their rights, their property scope. Nothing here acts as
// anyone else, and nothing reaches the model.
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { CardReadError, type CardReader } from "./changeCard.js";

const rooms = z.object({
  items: z.array(
    z.object({
      roomId: z.string(),
      roomTypeId: z.string(),
      roomNumber: z.string(),
      status: z.string(),
      // The room type's rooms revision, as the PMS sends it back with a room change.
      metadata: z.object({ roomUnitsRevision: z.number().optional() }).nullish(),
    }),
  ),
});
const roomTypes = z.object({
  items: z.array(z.object({ roomTypeId: z.string(), name: z.string() })),
});
const roomBlocks = z.object({
  items: z.array(
    z.object({
      blockId: z.string(),
      version: z.string(),
      roomTypeId: z.string(),
      roomId: z.string().nullable(),
      startsOn: z.string(),
      endsOn: z.string(),
      blockedCount: z.number(),
      status: z.string(),
    }),
  ),
});
const linkedGroups = z.object({
  items: z.array(z.object({ memberRoomTypeIds: z.array(z.string()) })),
});
const thread = z.object({
  thread: z.object({
    version: z.number(),
    channel: z.enum(["ota", "email"]),
    providerChannel: z.string().nullable(),
    guest: z.object({ displayName: z.string().nullable() }),
    lastMessage: z.object({ at: z.string().nullable() }),
  }),
});
const booking = z.object({
  item: z.object({
    bookingReference: z.string(),
    stay: z.object({ checkIn: z.string(), checkOut: z.string() }),
    primaryGuest: z.object({ displayName: z.string() }),
  }),
});

const property = (propertyId: string) => `/api/pms/properties/${encodeURIComponent(propertyId)}`;

/** A reader for one card, as the person whose bearer token this is. */
export function createCardReader(app: FastifyInstance, authorization: string): CardReader {
  const reads = new Map<string, Promise<unknown>>();
  const get = <T>(url: string, schema: z.ZodType<T>): Promise<T | null> => {
    let read = reads.get(url);
    if (!read) {
      read = (async () => {
        const response = await app.inject({ method: "GET", url, headers: { authorization } });
        if (response.statusCode === 404) return null;
        if (response.statusCode === 401 || response.statusCode === 403) {
          throw new CardReadError("not_allowed");
        }
        if (response.statusCode !== 200) throw new CardReadError("unavailable");
        const parsed = schema.safeParse(response.json());
        if (!parsed.success) throw new CardReadError("unavailable");
        return parsed.data;
      })();
      reads.set(url, read);
    }
    return read as Promise<T | null>;
  };
  // A property's lists are never "gone" while the person may read the property.
  const list = async <T>(url: string, schema: z.ZodType<T>): Promise<T> => {
    const value = await get(url, schema);
    if (value === null) throw new CardReadError("not_allowed");
    return value;
  };

  return {
    async rooms(propertyId) {
      return (await list(`${property(propertyId)}/rooms`, rooms)).items.map(
        ({ metadata, ...room }) => ({
          ...room,
          roomUnitsRevision: metadata?.roomUnitsRevision ?? null,
        }),
      );
    },
    async roomTypeNames(propertyId) {
      const { items } = await list(`${property(propertyId)}/room-types`, roomTypes);
      return new Map(items.map((item) => [item.roomTypeId, item.name]));
    },
    async roomBlock(propertyId, blockId) {
      const { items } = await list(`${property(propertyId)}/room-blocks`, roomBlocks);
      return items.find((item) => item.blockId.toLowerCase() === blockId.toLowerCase()) ?? null;
    },
    async linkedRoomTypeIds(propertyId, roomTypeId) {
      const { items } = await list(`${property(propertyId)}/linked-inventory-groups`, linkedGroups);
      const id = roomTypeId.toLowerCase();
      const linked = new Set<string>();
      for (const group of items) {
        const members = group.memberRoomTypeIds.map((member) => member.toLowerCase());
        if (members.includes(id))
          for (const member of members) if (member !== id) linked.add(member);
      }
      return [...linked];
    },
    async thread(propertyId, threadId) {
      const value = await get(
        // The guest's name only: one message is the least the route reads.
        `${property(propertyId)}/messaging/threads/${encodeURIComponent(threadId)}?messageLimit=1`,
        thread,
      );
      return (
        value && {
          version: value.thread.version,
          guestName: value.thread.guest.displayName,
          channel: value.thread.channel,
          providerChannel: value.thread.providerChannel,
          lastMessageAt: value.thread.lastMessage.at,
        }
      );
    },
    async booking(propertyId, guestBookingId) {
      const value = await get(
        `${property(propertyId)}/reservations/${encodeURIComponent(guestBookingId)}`,
        booking,
      );
      return (
        value && {
          guestName: value.item.primaryGuest.displayName,
          reference: value.item.bookingReference,
          checkIn: value.item.stay.checkIn,
          checkOut: value.item.stay.checkOut,
        }
      );
    },
  };
}
