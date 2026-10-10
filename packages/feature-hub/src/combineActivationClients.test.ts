import { describe, expect, it, vi } from "vitest";

import { combineActivationClients, PMS_NAVIGATION_MODULE_IDS } from "./combineActivationClients";
import { activeNavModules, CORE_NAV_ITEMS, FEATURE_MODULE_NAV_INDEX } from "./registry";
import type { FeatureActivationClient, ModuleActivationsResponse } from "./types";

const at = "2026-10-09T08:00:00.000Z";

function store(response: Partial<ModuleActivationsResponse>) {
  return {
    list: vi.fn(async () => ({
      hotelId: "property-1",
      canManage: false,
      supportedModules: [],
      activeModules: [],
      activations: [],
      ...response,
    })),
    update: vi.fn(async (moduleId: string, isActive: boolean) => ({
      moduleId,
      isActive,
      activatedAt: at,
      deactivatedAt: null,
      updatedAt: at,
    })),
  } satisfies FeatureActivationClient;
}

describe("combineActivationClients", () => {
  it("lists both stores as one hub and keeps manage rights per store", async () => {
    // An operator can switch Inbox and Reviews but not the Owner-only Financials.
    const navigation = store({
      canManage: true,
      supportedModules: ["inbox", "reviews"],
      activeModules: ["inbox"],
    });
    const financials = store({ canManage: false, supportedModules: ["financials"] });
    const client = combineActivationClients([
      { client: navigation, modules: PMS_NAVIGATION_MODULE_IDS },
      { client: financials },
    ]);

    await expect(client.list()).resolves.toEqual({
      hotelId: "property-1",
      canManage: true,
      supportedModules: ["inbox", "reviews", "financials"],
      activeModules: ["inbox"],
      activations: [],
      manageableModules: ["inbox", "reviews"],
    });
  });

  it("sends each switch to the store that owns the module", async () => {
    const navigation = store({});
    const financials = store({});
    const client = combineActivationClients([
      { client: navigation, modules: PMS_NAVIGATION_MODULE_IDS },
      { client: financials },
    ]);

    await client.update("reviews", true);
    await client.update("financials", false);

    expect(navigation.update).toHaveBeenCalledExactlyOnceWith("reviews", true);
    expect(financials.update).toHaveBeenCalledExactlyOnceWith("financials", false);
  });

  it("fails the whole list when one store cannot be read", async () => {
    const navigation = store({});
    navigation.list.mockRejectedValueOnce(new Error("navigation unavailable"));
    const client = combineActivationClients([
      { client: navigation, modules: PMS_NAVIGATION_MODULE_IDS },
      { client: store({ supportedModules: ["financials"] }) },
    ]);

    await expect(client.list()).rejects.toThrow("navigation unavailable");
  });
});

describe("optional module stores", () => {
  it("leaves an unreadable optional store out instead of failing the hub", async () => {
    const navigation = store({});
    navigation.list.mockRejectedValueOnce(new Error("forbidden"));
    const client = combineActivationClients([
      { client: navigation, modules: PMS_NAVIGATION_MODULE_IDS, optional: true },
      { client: store({ canManage: true, supportedModules: ["financials"] }) },
    ]);

    await expect(client.list()).resolves.toMatchObject({
      supportedModules: ["financials"],
      manageableModules: ["financials"],
    });
  });
});

describe("PMS navigation preview", () => {
  it("mirrors the sidebar: modules after Reservations, in sidebar order", () => {
    const core = CORE_NAV_ITEMS.pms.map(({ label }) => label);
    expect(core).toEqual([
      "Dashboard",
      "Calendar",
      "Reservations",
      "Rooms & Rates",
      "Channel Manager",
      "Settings",
    ]);
    expect(core[FEATURE_MODULE_NAV_INDEX.pms - 1]).toBe("Reservations");
    expect(activeNavModules("pms", ["financials", "reviews", "inbox"]).map(({ id }) => id)).toEqual(
      ["inbox", "reviews", "financials"],
    );
  });
});
