import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import { visiblePmsNavigation } from "./Sidebar";

it("hides navigation sections without a live read permission", () => {
  expect(
    visiblePmsNavigation([
      "pms.calendar.read",
      "pms.room_status.read",
      "identity.staff.manage",
    ]).map((item) => item.href),
  ).toEqual(["/calendar", "/rooms", "/settings"]);
});

it("matches Reviews visibility to its server read policy", () => {
  expect(visiblePmsNavigation(["pms.operations.read"]).map((item) => item.href)).toContain(
    "/reviews",
  );
  expect(visiblePmsNavigation(["pms.reservation.read"]).map((item) => item.href)).not.toContain(
    "/reviews",
  );
});

it("shows Financials only after the property access check succeeds", () => {
  expect(visiblePmsNavigation(["pms.finance.read"]).map((item) => item.href)).not.toContain(
    "/financials",
  );
  expect(visiblePmsNavigation(["pms.finance.read"], true).map((item) => item.href)).toContain(
    "/financials",
  );
  expect(visiblePmsNavigation([], true).map((item) => item.href)).not.toContain("/financials");
});
