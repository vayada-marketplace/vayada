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

it("shows Inbox and Reviews only while their Feature Hub switch is on", () => {
  const permissions = ["pms.inbox.read", "pms.operations.read", "pms.reservation.read"];
  const hrefs = (modules: ReadonlySet<string> | null) =>
    visiblePmsNavigation(permissions, false, modules).map((item) => item.href);

  expect(hrefs(new Set())).toEqual(["/bookings"]);
  expect(hrefs(new Set(["inbox"]))).toEqual(["/bookings", "/inbox"]);
  expect(hrefs(new Set(["inbox", "reviews"]))).toEqual(["/bookings", "/inbox", "/reviews"]);
  // A failed switch read must not hide a module the property may already use.
  expect(hrefs(null)).toEqual(["/bookings", "/inbox", "/reviews"]);
});

it("keeps permissions authoritative over an active switch", () => {
  expect(
    visiblePmsNavigation(["pms.reservation.read"], false, new Set(["inbox", "reviews"])).map(
      (item) => item.href,
    ),
  ).toEqual(["/bookings"]);
});
