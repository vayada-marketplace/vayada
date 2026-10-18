import { describe, expect, it } from "vitest";

import {
  isPmsSetupExitPath,
  pmsSetupExitPath,
  pmsSetupExitPropertyId,
  setupExitTarget,
} from "./setupExit";

describe("PMS setup exit routing", () => {
  it("lands a selected property on the dashboard", () => {
    expect(pmsSetupExitPath(" property-1 ")).toBe(
      "/dashboard?setup=incomplete&propertyId=property-1",
    );
  });

  it("lands setup without a property on the property picker", () => {
    expect(pmsSetupExitPath(null)).toBe("/choose-property?setup=incomplete");
  });

  it("recognizes only intentional PMS setup-exit destinations", () => {
    expect(isPmsSetupExitPath("/dashboard?setup=incomplete&propertyId=property-1")).toBe(true);
    expect(isPmsSetupExitPath("https://pms.vayada.com/choose-property?setup=incomplete")).toBe(
      true,
    );
    expect(isPmsSetupExitPath("/dashboard?setup=incomplete")).toBe(false);
    expect(isPmsSetupExitPath("/dashboard")).toBe(false);
    expect(isPmsSetupExitPath("/settings?setup=incomplete")).toBe(false);
    expect(
      isPmsSetupExitPath(
        "https://attacker.example/dashboard?setup=incomplete&propertyId=property-1",
      ),
    ).toBe(false);
  });

  it("reads the selected property only from a dashboard setup exit", () => {
    expect(pmsSetupExitPropertyId("/dashboard?setup=incomplete&propertyId=%20property-1%20")).toBe(
      "property-1",
    );
    expect(pmsSetupExitPropertyId("/dashboard?propertyId=property-1")).toBeNull();
    expect(
      pmsSetupExitPropertyId("/choose-property?setup=incomplete&propertyId=property-1"),
    ).toBeNull();
    expect(
      pmsSetupExitPropertyId(
        "https://attacker.example/dashboard?setup=incomplete&propertyId=property-1",
      ),
    ).toBeNull();
  });
});

describe("setup exit target (VAY-2249)", () => {
  const exit = (query: string, extra: Partial<Parameters<typeof setupExitTarget>[0]> = {}) =>
    setupExitTarget({ query, propertyId: "property-1", defaultProduct: "marketplace", ...extra });

  it("returns Booking Engine setup to Booking Admin's dashboard", () => {
    expect(exit("entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard")).toEqual({
      surface: "booking-admin",
      path: "/dashboard?setup=incomplete&propertyId=property-1",
    });
  });

  it("returns PMS setup to the PMS dashboard and keeps calendar recovery", () => {
    expect(exit("entryProduct=pms&returnProduct=pms")).toEqual({
      surface: "pms-web",
      path: "/dashboard?setup=incomplete&propertyId=property-1",
    });
    expect(
      exit("entryProduct=pms&returnProduct=pms&recovery=pms-calendar&returnTo=%2Fsettings%23calendar"),
    ).toEqual({ surface: "pms-web", path: "/settings#calendar" });
  });

  it("keeps Marketplace hotels in the Marketplace, on a safe return path", () => {
    expect(exit("entryProduct=marketplace&returnProduct=marketplace&returnTo=%2Fprofile")).toEqual({
      surface: "marketplace-web",
      path: "/profile",
    });
    expect(
      exit("entryProduct=marketplace&returnProduct=marketplace&returnTo=https%3A%2F%2Fevil.example"),
    ).toEqual({ surface: "marketplace-web", path: "/marketplace" });
    expect(exit("", { selectedTracks: ["creator_marketplace"] })).toEqual({
      surface: "marketplace-web",
      path: "/marketplace",
    });
  });

  it("sends a Marketplace entry without the Marketplace track to PMS", () => {
    expect(exit("entryProduct=marketplace", { selectedTracks: ["hotel_operations"] })).toEqual({
      surface: "pms-web",
      path: "/dashboard?setup=incomplete&propertyId=property-1",
    });
    expect(exit("", { selectedTracks: [], propertyId: null })).toEqual({
      surface: "pms-web",
      path: "/choose-property?setup=incomplete",
    });
  });

  it("prefers the product the hotel will return to over the entry product", () => {
    expect(exit("entryProduct=marketplace&returnProduct=booking").surface).toBe("booking-admin");
    expect(exit("entryProduct=booking").surface).toBe("booking-admin");
  });
});
