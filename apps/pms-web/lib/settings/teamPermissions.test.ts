import { expect, it } from "vitest";
import {
  changeProductSections,
  changeSectionDetail,
  changeSectionAccess,
  memberPermissionOverrides,
  sectionAccess,
  sectionCounts,
  supportsSectionAccess,
  teamSections,
} from "./teamPermissions";
const find = (id: string) => teamSections.find((section) => section.id === id)!;
const all = teamSections.flatMap((section) => [
  ...section.read,
  ...section.edit,
  ...(section.details ?? []).map((detail) => detail.key),
]);

it("keeps contact access separate from editing and removes cancellation on View", () => {
  const permissions = [
    "pms.reservation.read",
    "pms.reservation.update",
    "pms.reservation.cancel",
    "pms.guest_contact.read",
    "booking.analytics.read",
  ];
  expect(changeSectionAccess(permissions, find("reservations"), "view", all)).toEqual([
    "booking.analytics.read",
    "pms.guest_contact.read",
    "pms.reservation.read",
  ]);
  expect(changeSectionAccess(permissions, find("reservations"), "none", all)).toEqual([
    "booking.analytics.read",
  ]);
  expect(changeSectionAccess([], find("reservations"), "edit", all)).toEqual([
    "pms.reservation.read",
    "pms.reservation.update",
  ]);
});
it("does not invent dashboard, finance, channel, analytics, Chat or Team View capabilities", () => {
  for (const id of ["dashboard", "financials", "channelManager", "analytics", "chat"])
    expect(supportsSectionAccess(find(id), "edit", all)).toBe(false);
  expect(supportsSectionAccess(find("team"), "view", all)).toBe(false);
  expect(supportsSectionAccess(find("chat"), "view", all)).toBe(false);
  const changed = changeProductSections([], "pms", "edit", all);
  expect(sectionAccess(changed, find("financials"))).toBe("view");
  expect(changed).not.toContain("pms.guest_contact.read");
  expect(changed).not.toContain("pms.dashboard.finance.read");
});
it("preserves narrow room-status access and unrelated permissions until that section changes", () => {
  const permissions = ["pms.dashboard.read", "pms.calendar.read", "pms.room_status.read"];
  expect(sectionCounts(permissions)).toEqual({ edit: 0, view: 2 });
  expect(changeSectionAccess(permissions, find("calendar"), "edit", all)).toContain(
    "pms.room_status.read",
  );
  expect(changeSectionAccess(permissions, find("roomsRates"), "none", all)).not.toContain(
    "pms.room_status.read",
  );
});
it("limits bulk changes to the product and role ceiling", () => {
  const allowed = ["pms.calendar.read", "pms.dashboard.read"];
  expect(changeProductSections(["booking.analytics.read"], "pms", "view", allowed)).toEqual([
    "booking.analytics.read",
    "pms.calendar.read",
    "pms.dashboard.read",
  ]);
  expect(changeSectionAccess([], find("calendar"), "edit", allowed)).toEqual([]);
});
it("computes explicit grants and denies without replacing unchanged defaults", () => {
  expect(
    memberPermissionOverrides(
      ["pms.calendar.read", "booking.analytics.read"],
      ["pms.calendar.read", "pms.calendar.manage"],
    ),
  ).toEqual({ grant: ["pms.calendar.manage"], deny: ["booking.analytics.read"] });
});

it("maintains dashboard and room-rate dependencies", () => {
  const enabled = changeSectionDetail(
    [],
    find("dashboard"),
    "pms.dashboard.finance.read",
    true,
    all,
  );
  expect(enabled).toEqual([
    "pms.dashboard.finance.read",
    "pms.dashboard.operations.read",
    "pms.dashboard.read",
  ]);
  expect(
    changeSectionDetail(enabled, find("dashboard"), "pms.dashboard.operations.read", false, all),
  ).toEqual(["pms.dashboard.read"]);
  expect(changeSectionAccess([], find("roomsRates"), "view", all)).toEqual([
    "pms.room_status.read",
    "pms.rooms_rates.read",
  ]);
  expect(
    changeSectionDetail(
      ["pms.room_status.read", "pms.rooms_rates.read", "pms.rooms_rates.manage"],
      find("roomsRates"),
      "pms.room_status.read",
      false,
      all,
    ),
  ).toEqual([]);
});

it("bulk View removes Team management instead of retaining write-only access", () => {
  expect(
    changeProductSections(
      ["identity.staff.manage", "pms.calendar.read", "pms.calendar.manage"],
      "pms",
      "view",
      all,
    ),
  ).not.toContain("identity.staff.manage");
});
