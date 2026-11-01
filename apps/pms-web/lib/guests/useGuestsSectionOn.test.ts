import { expect, it } from "vitest";

import { guestsSectionOn } from "./useGuestsSectionOn";

it("hides Guests only when the API knows the switch and says it is off (VAY-2423)", () => {
  const supportedModules = ["inbox", "reviews", "guests"];
  expect(guestsSectionOn({ supportedModules, activeModules: ["guests"] })).toBe(true);
  expect(guestsSectionOn({ supportedModules, activeModules: ["inbox"] })).toBe(false);
  // An API from before the switch, or a malformed or missing read, leaves Guests on.
  expect(guestsSectionOn({ supportedModules: ["inbox", "reviews"], activeModules: [] })).toBe(true);
  expect(guestsSectionOn({ activeModules: [] })).toBe(true);
  expect(guestsSectionOn(null)).toBe(true);
});
