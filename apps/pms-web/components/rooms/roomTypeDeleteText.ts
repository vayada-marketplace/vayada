import { ApiErrorResponse } from "@/services/api/client";
import { RoomTypeRetirementBlockedError, type RoomTypeRetirementImpact } from "@/services/rooms";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Cleanup = NonNullable<RoomTypeRetirementImpact["cleanup"]>;
type Blocker = RoomTypeRetirementImpact["blockers"][number];

/** The confirmation when Delete also does the cleanup (VAY-2132). */
export function roomTypeDeleteMessage(t: Translate, name: string, cleanup: Cleanup): string {
  return [
    t("rooms.edit.deleteCleanupMessage", { name }),
    cleanup.physicalUnits
      ? t("rooms.edit.deleteCleanupUnits", { count: cleanup.physicalUnits })
      : "",
    cleanup.futureNights
      ? t("rooms.edit.deleteCleanupNights", { count: cleanup.futureNights })
      : "",
    cleanup.roomBlocks ? t("rooms.edit.deleteCleanupBlocks", { count: cleanup.roomBlocks }) : "",
    cleanup.linkedGroups ? t("rooms.edit.deleteCleanupLinked") : "",
    t("rooms.edit.deleteCleanupFinal"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Why Delete can't run yet: one sentence per blocker. */
export function roomTypeDeleteBlockedMessage(t: Translate, impact: RoomTypeRetirementImpact) {
  return [
    t("rooms.edit.deleteBlocked"),
    ...impact.blockers.map((blocker) => blockerText(t, blocker)),
  ]
    .filter(Boolean)
    .join(" ");
}

/** The banner text after a failed Delete. */
export function roomTypeDeleteErrorText(t: Translate, error: unknown, fallback: string): string {
  if (error instanceof RoomTypeRetirementBlockedError && error.impact.cleanup)
    return roomTypeDeleteBlockedMessage(t, error.impact);
  if (error instanceof ApiErrorResponse) {
    if (error.status === 403 && error.data.code === "room_type_delete_not_allowed")
      return t("rooms.edit.deleteNotAllowed");
    // Something changed between the confirmation and the Delete.
    const impact = (error.data as { impact?: RoomTypeRetirementImpact }).impact;
    if (error.status === 409 && impact?.cleanup) return roomTypeDeleteBlockedMessage(t, impact);
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function blockerText(t: Translate, { code, affectedCount: count, action }: Blocker): string {
  switch (code) {
    case "active_reservations":
      return t("rooms.edit.deleteBlockedBookings", { count });
    case "channel_mapping":
      return t("rooms.edit.deleteBlockedChannel");
    case "last_room_type":
      return t("rooms.edit.deleteBlockedLastRoomType");
    case "calendar_not_current":
      return t("rooms.edit.deleteBlockedCalendar");
    case "protected_inventory":
      return t("rooms.edit.deleteBlockedLimits", { count });
    case "unavailable_units":
      return t("rooms.edit.deleteBlockedUnits", { count });
    default:
      return action;
  }
}
