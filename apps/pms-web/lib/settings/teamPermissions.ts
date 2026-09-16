export type TeamAccessLevel = "none" | "view" | "edit";
export type TeamProduct = "pms" | "booking";
export type TeamSection = {
  id: string;
  product: TeamProduct;
  read: string[];
  edit: string[];
  details?: { key: string; requires: string[]; write?: boolean }[];
};

export const teamSections: TeamSection[] = [
  {
    id: "dashboard",
    product: "pms",
    read: ["pms.dashboard.read"],
    edit: [],
    details: [
      { key: "pms.dashboard.operations.read", requires: ["pms.dashboard.read"] },
      {
        key: "pms.dashboard.finance.read",
        requires: ["pms.dashboard.read", "pms.dashboard.operations.read"],
      },
    ],
  },
  { id: "calendar", product: "pms", read: ["pms.calendar.read"], edit: ["pms.calendar.manage"] },
  {
    id: "reservations",
    product: "pms",
    read: ["pms.reservation.read"],
    edit: ["pms.reservation.update"],
    details: [
      {
        key: "pms.reservation.cancel",
        requires: ["pms.reservation.read", "pms.reservation.update"],
        write: true,
      },
      { key: "pms.guest_contact.read", requires: ["pms.reservation.read"] },
    ],
  },
  {
    id: "roomsRates",
    product: "pms",
    read: ["pms.room_status.read", "pms.rooms_rates.read"],
    edit: ["pms.rooms_rates.manage"],
    details: [{ key: "pms.room_status.read", requires: [] }],
  },
  { id: "inbox", product: "pms", read: ["pms.inbox.read"], edit: ["pms.inbox.reply"] },
  { id: "financials", product: "pms", read: ["pms.finance.read"], edit: [] },
  { id: "channelManager", product: "pms", read: ["pms.channel_manager.read"], edit: [] },
  { id: "settings", product: "pms", read: ["pms.settings.read"], edit: ["pms.settings.manage"] },
  { id: "team", product: "pms", read: [], edit: ["identity.staff.manage"] },
  { id: "analytics", product: "booking", read: ["booking.analytics.read"], edit: [] },
  { id: "chat", product: "booking", read: [], edit: [] },
  {
    id: "design",
    product: "booking",
    read: ["booking.design.read"],
    edit: ["booking.design.manage"],
  },
  { id: "flow", product: "booking", read: ["booking.flow.read"], edit: ["booking.flow.manage"] },
  {
    id: "addons",
    product: "booking",
    read: ["booking.addons.read"],
    edit: ["booking.addons.manage"],
  },
  {
    id: "promos",
    product: "booking",
    read: ["booking.promos.read"],
    edit: ["booking.promos.manage"],
  },
  {
    id: "settings",
    product: "booking",
    read: ["booking.settings.read"],
    edit: ["booking.settings.manage"],
  },
];

export function sectionAccess(
  permissions: readonly string[],
  section: TeamSection,
): TeamAccessLevel {
  if (
    section.edit.length &&
    [...section.read, ...section.edit].every((key) => permissions.includes(key))
  )
    return "edit";
  return section.read.length && section.read.every((key) => permissions.includes(key))
    ? "view"
    : "none";
}
export function supportsSectionAccess(
  section: TeamSection,
  level: TeamAccessLevel,
  allowed: readonly string[],
): boolean {
  if (level === "none") return true;
  const keys = level === "edit" ? [...section.read, ...section.edit] : section.read;
  return (
    (level === "edit" ? section.edit.length > 0 : section.read.length > 0) &&
    keys.every((key) => allowed.includes(key))
  );
}
export function changeSectionAccess(
  permissions: readonly string[],
  section: TeamSection,
  level: TeamAccessLevel,
  allowed: readonly string[],
): string[] {
  if (!supportsSectionAccess(section, level, allowed)) return [...permissions];
  const controlled = new Set([
    ...section.read,
    ...section.edit,
    ...(section.details ?? [])
      .filter((detail) => level === "none" || (level === "view" && detail.write))
      .map((detail) => detail.key),
  ]);
  const next = new Set(permissions.filter((key) => !controlled.has(key)));
  if (level !== "none") section.read.forEach((key) => next.add(key));
  if (level === "edit") section.edit.forEach((key) => next.add(key));
  return Array.from(next).sort();
}
export function changeProductSections(
  permissions: readonly string[],
  product: TeamProduct,
  level: TeamAccessLevel,
  allowed: readonly string[],
): string[] {
  return teamSections
    .filter((section) => section.product === product)
    .reduce(
      (keys, section) => {
        // All edit gives View on supported read-only sections, never invents an edit grant.
        const effective =
          level === "view" && !section.read.length
            ? "none"
            : level === "edit" && !section.edit.length
              ? "view"
              : level;
        return changeSectionAccess(keys, section, effective, allowed);
      },
      [...permissions],
    );
}
export function sectionCounts(permissions: readonly string[], product?: TeamProduct) {
  return teamSections
    .filter((section) => !product || section.product === product)
    .reduce(
      (counts, section) => {
        const level = sectionAccess(permissions, section);
        if (level !== "none") counts[level]++;
        return counts;
      },
      { edit: 0, view: 0 },
    );
}
export function memberPermissionOverrides(defaults: readonly string[], desired: readonly string[]) {
  return {
    grant: desired.filter((key) => !defaults.includes(key)),
    deny: defaults.filter((key) => !desired.includes(key)),
  };
}

export function changeSectionDetail(
  permissions: readonly string[],
  section: TeamSection,
  key: string,
  enabled: boolean,
  allowed: readonly string[],
): string[] {
  const detail = section.details?.find((item) => item.key === key);
  if (!detail || (enabled && [key, ...detail.requires].some((item) => !allowed.includes(item))))
    return [...permissions];
  if (!enabled && section.read.includes(key))
    return changeSectionAccess(permissions, section, "none", allowed);
  const next = new Set(permissions);
  if (enabled) [key, ...detail.requires].forEach((item) => next.add(item));
  else {
    next.delete(key);
    for (const dependent of section.details ?? [])
      if (dependent.requires.includes(key)) next.delete(dependent.key);
  }
  return Array.from(next).sort();
}
