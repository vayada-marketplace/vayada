import { expect, it } from "vitest";
import { getPmsSettingsCards, legacySettingsAnchorTarget } from "./navigation";

const t = (key: string) => key;

it("lists the cards in Timo's order with Feature Hub on top", () => {
  const { featured, cards } = getPmsSettingsCards(t);
  expect(featured.href).toBe("/settings/feature-hub");
  expect(cards.map((card) => [card.id, card.href])).toEqual([
    ["property", "/settings/property"],
    ["calendar", "/settings/calendar"],
    ["checkIn", "/settings/check-in"],
    ["guestData", "/settings/guest-data"],
    ["guestFlows", "/settings/guest-flows"],
    ["otaCommissions", "/settings/ota-commissions"],
    ["team", "/settings/team"],
    ["account", undefined],
    ["billing", "/settings/billing"],
  ]);
});

it("shows only Team and Account to a manager without general settings access", () => {
  expect(
    getPmsSettingsCards(t, {
      membershipId: "manager",
      roleKey: "hotel_manager",
      permissions: ["identity.staff.manage"],
    }).cards.map((card) => card.id),
  ).toEqual(["team", "account"]);
});

it("keeps billing exclusive to the account administrator", () => {
  const permissions = ["pms.settings.read"];
  const ids = (roleKey: string) =>
    getPmsSettingsCards(t, { membershipId: roleKey, roleKey, permissions }).cards.map(
      (card) => card.id,
    );
  expect(ids("hotel_manager")).not.toContain("billing");
  expect(ids("hotel_owner")).toContain("billing");
});

it("sends old single-page anchors to the page that holds them now", () => {
  expect(legacySettingsAnchorTarget("#language")).toBe("/settings/property#language");
  expect(legacySettingsAnchorTarget("#booking-engine")).toBe("/settings/property#arrival-times");
  expect(legacySettingsAnchorTarget("#checkout-inspection")).toBe(
    "/settings/guest-flows#check-out",
  );
  expect(legacySettingsAnchorTarget("#checkin-checklist")).toBe("/settings/check-in#extra-checks");
  expect(legacySettingsAnchorTarget("")).toBeNull();
  expect(legacySettingsAnchorTarget("#unknown")).toBeNull();
});
