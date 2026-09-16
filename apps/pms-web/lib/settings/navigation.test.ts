import { expect, it } from "vitest";
import { getPmsSettingsSections } from "./navigation";

const t = (key: string) => key;

it("shows only Team settings to a manager without general settings access", () => {
  expect(
    getPmsSettingsSections(false, t, {
      membershipId: "manager",
      roleKey: "hotel_manager",
      permissions: ["identity.staff.manage"],
    }).map((section) => section.id),
  ).toEqual(["team"]);
});

it("keeps billing exclusive to the account administrator", () => {
  const permissions = ["pms.settings.read"];
  expect(
    getPmsSettingsSections(false, t, {
      membershipId: "manager",
      roleKey: "hotel_manager",
      permissions,
    }).some((section) => section.id === "billing"),
  ).toBe(false);
  expect(
    getPmsSettingsSections(false, t, {
      membershipId: "owner",
      roleKey: "hotel_owner",
      permissions,
    }).some((section) => section.id === "billing"),
  ).toBe(true);
});
