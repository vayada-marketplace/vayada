import type { BookingPublicQuotedOffer } from "@vayada/domain-distribution/booking-publication";
import type { BookingPublicationSnapshotContent } from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import {
  type PmsInventoryLaunchReadinessReadPort,
  type RoomPublicationRoomSnapshot,
} from "@vayada/domain-pms";

export function buildPmsBookingPublicationContent(input: {
  rooms: readonly RoomPublicationRoomSnapshot[];
  offers: readonly { roomTypeId: string; offers: readonly BookingPublicQuotedOffer[] }[];
  inventory: NonNullable<
    Awaited<ReturnType<PmsInventoryLaunchReadinessReadPort["getInventoryLaunchReadiness"]>>
  >["snapshot"];
  currentLocalDate: string;
  observedAt: string;
}): BookingPublicationSnapshotContent["pms"] | null {
  const roomIds = input.rooms.map((room) => room.roomTypeId).sort();
  const sameRooms = (ids: readonly string[]) =>
    JSON.stringify([...ids].sort()) === JSON.stringify(roomIds);
  if (
    !roomIds.length ||
    new Set(roomIds).size !== roomIds.length ||
    !sameRooms(input.offers.map((room) => room.roomTypeId)) ||
    !sameRooms(input.inventory.coverage.roomTypeIds)
  )
    return null;
  const offers = new Map(input.offers.map((room) => [room.roomTypeId, room.offers]));
  const rooms = input.rooms.map((room) => {
    const rates = offers.get(room.roomTypeId);
    if (!rates?.length) return null;
    const images = room.media.flatMap((assignment) => {
      const image = assignment.publicVariants.find(
        ({ variantName }) => variantName === "original_safe",
      );
      return image ? [{ url: image.publicUrl, alt: assignment.altText }] : [];
    });
    return {
      roomTypeId: room.roomTypeId,
      name: room.facts.name,
      description: room.facts.description,
      category: room.facts.category,
      occupancy: { ...room.facts.occupancy },
      beds: room.facts.beds.map((bed) => ({ ...bed })),
      bedrooms: room.facts.bedrooms,
      bathrooms: room.facts.bathrooms,
      bathroomType: room.facts.bathroomType,
      size: room.facts.size && { ...room.facts.size },
      images,
      amenities: [...(room.amenities ?? [])],
      rates,
    };
  });
  if (rooms.some((room) => room === null)) return null;
  const calendarRevision = input.inventory.configuration.source.revision;
  const observedAt = new Date(input.observedAt).toISOString();
  return {
    availabilityReady: true,
    rooms: rooms as NonNullable<(typeof rooms)[number]>[],
    calendar: {
      sourceRevision: calendarRevision,
      materializedRevision: calendarRevision,
      currentLocalDate: input.currentLocalDate,
      coverageFrom: input.inventory.coverage.coverageFrom,
      coverageThrough: input.inventory.coverage.coverageThrough,
      materializedThrough: input.inventory.coverage.coverageThrough,
      expectedDayCount: input.inventory.coverage.expectedDayCount,
      materializedDayCount: input.inventory.coverage.materializedDayCount,
      gapCount: input.inventory.coverage.gaps.length,
      roomTypeIds: input.inventory.coverage.roomTypeIds,
      observedAt,
    },
    freshness: { status: "fresh", lastUpdatedAt: observedAt },
  };
}
