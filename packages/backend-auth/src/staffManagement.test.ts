import { describe, expect, it } from "vitest";
import { withinStaffManagementScope, type ManagedStaffAccess } from "./staffManagement.js";

const manager: ManagedStaffAccess = {
  membershipId: "manager",
  roleKey: "hotel_manager",
  accessOrigin: "agency",
  propertyAccessMode: "assigned",
  propertyIds: ["one"],
  productAccess: { pms: true, booking: false },
  permissions: [
    "identity.staff.manage",
    "pms.calendar.read",
    "pms.calendar.manage",
    "booking.design.read",
  ],
};
const worker: ManagedStaffAccess = {
  ...manager,
  membershipId: "worker",
  roleKey: "hotel_custom",
  permissions: ["pms.calendar.read"],
};

describe("manager command ceiling", () => {
  it("allows a worker within the manager's permission, property and product scope", () => {
    expect(withinStaffManagementScope(manager, worker)).toBe(true);
    expect(
      withinStaffManagementScope(
        { ...manager, propertyAccessMode: "all" },
        { ...worker, propertyAccessMode: "all", propertyIds: [] },
      ),
    ).toBe(true);
  });
  it.each<Partial<ManagedStaffAccess>>([
    { membershipId: "manager" },
    { roleKey: "hotel_owner" },
    { roleKey: "hotel_manager" },
    { accessOrigin: "external_owner" },
    { propertyAccessMode: "all", propertyIds: [] },
    { propertyIds: ["two"] },
    { productAccess: { pms: true, booking: true } },
    { permissions: ["identity.staff.manage"] },
    { permissions: ["finance.billing.manage"] },
    { permissions: ["pms.reservation.read"] },
    { permissions: ["booking.design.read"] },
  ])("rejects protected or broader access %j", (patch) => {
    expect(withinStaffManagementScope(manager, { ...worker, ...patch })).toBe(false);
  });
});
