// The rights checks a change repeats inside its own transaction (VAY-2522; engineering/
// ai-actions-authority-inventory.md, section E). They read the user's rights from the database,
// which knows nothing of an AI request's limits, so each takes the limits from the command
// (`authorityNarrowing`) before it may serve an AI change. A change action lists every one it
// passes through; it may list only those that already do ("threaded").
export const AUTHORITY_SITES = {
  pms_inbox_triage_scope: {
    threaded: true,
    where: "pmsInboxTriageCommand.ts lockActorScope, before lockPmsInboxRolePermissions",
  },
  pms_physical_room_scope: {
    threaded: true,
    where:
      "lockAuthorizedPmsPhysicalRoomScope, for physical-room management (owner key, or Rooms & Rates edit via lockMemberPermissions)",
  },
  pms_calendar_room_follow_up: {
    threaded: true,
    where:
      "followRoomChangesInCalendar: impact preview, lockPmsManageScope and the inventory build, " +
      "on the command's property, only where the narrowing allows a change",
  },
  // Not threaded yet: an action that passes through one of these can not be registered.
  pms_inbox_role_permissions: {
    threaded: false,
    where: "lockPmsInboxRolePermissions in the other inbox commands (reply, assignment, ...)",
  },
  pms_physical_room_units: {
    threaded: false,
    where: "room count and room label: their routes refuse AI requests",
  },
  pms_manage_scope: { threaded: false, where: "lockPmsManageScope: closures, operating calendar" },
  member_permissions: {
    threaded: false,
    where: "lockMemberPermissions: booking page, setup, physical rooms for staff",
  },
  replacement_pricing: {
    threaded: false,
    where: "lockReplacementPricingAuthorization: pricing-v2",
  },
} as const satisfies Record<string, { threaded: boolean; where: string }>;

export type AuthoritySite = keyof typeof AUTHORITY_SITES;
