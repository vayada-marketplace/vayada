import { describe, expect, it } from "vitest";

import {
  CORE_NAV_ITEMS,
  FEATURE_MODULE_NAV_INDEX,
  FEATURE_MODULES,
  isModuleNew,
  visibleNavModules,
} from "./registry";

const inbox = FEATURE_MODULES.find(({ id }) => id === "inbox")!;
const financials = FEATURE_MODULES.find(({ id }) => id === "financials")!;

describe("Feature Hub modules (VAY-2200)", () => {
  it("lists five switchable modules and the unavailable Affiliate Tracking card", () => {
    expect(FEATURE_MODULES.filter((m) => !m.unavailable).map(({ id }) => id)).toEqual([
      "inbox",
      "reviews",
      "financials",
      "add-ons",
      "promos",
    ]);
    const affiliates = FEATURE_MODULES.find(({ id }) => id === "affiliates")!;
    expect(affiliates).toMatchObject({ unavailable: true });
    expect(affiliates.navItem).toBeUndefined();
  });

  it("marks a module NEW for 30 days after it joins Feature Hub", () => {
    expect(isModuleNew(inbox, new Date("2026-10-09T23:59:59Z"))).toBe(false);
    expect(isModuleNew(inbox, new Date("2026-10-10T00:00:00Z"))).toBe(true);
    expect(isModuleNew(inbox, new Date("2026-11-08T23:59:59Z"))).toBe(true);
    expect(isModuleNew(inbox, new Date("2026-11-09T00:00:00Z"))).toBe(false);
    expect(isModuleNew(financials, new Date("2026-10-15T00:00:00Z"))).toBe(false);
  });

  it("keeps a Booking Engine item unless its store says it is off", () => {
    const ids = (active: string[], supported: string[]) =>
      visibleNavModules("booking_engine", active, supported).map(({ id }) => id);
    // Not read yet, or the read failed: nothing is hidden by mistake.
    expect(ids([], [])).toEqual(["add-ons", "promos"]);
    expect(ids(["add-ons"], ["add-ons", "promos"])).toEqual(["add-ons"]);
    expect(ids([], ["add-ons", "promos"])).toEqual([]);
  });

  it("previews module items after Design Studio in the Booking Engine menu", () => {
    const core = CORE_NAV_ITEMS.booking_engine.map(({ label }) => label);
    expect(core).toEqual(["Dashboard", "Design Studio", "Settings"]);
    expect(core[FEATURE_MODULE_NAV_INDEX.booking_engine - 1]).toBe("Design Studio");
  });
});
