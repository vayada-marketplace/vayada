import { buildHotelGoLiveChecklist } from "@vayada/domain-hotels";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const i18n = vi.hoisted(() => ({ lang: "en" as "en" | "de" }));
vi.mock("@/lib/i18n", async () => {
  const catalogs = {
    en: (await import("../../messages/en.json")).default as Record<string, string>,
    de: (await import("../../messages/de.json")).default as Record<string, string>,
  };
  // As the app's translate: the catalog's text with {params} filled in, English when missing.
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      catalogs[i18n.lang][key] ?? catalogs.en[key] ?? key,
    );
  return { useTranslation: () => ({ t }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  PmsDashboardSetupBanner,
  PmsDashboardSetupCard,
  usePmsSetupChecklist,
} from "./PmsDashboardSetup";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

const goLive = (setupFinished: boolean) =>
  buildHotelGoLiveChecklist({
    propertyId: PROPERTY,
    propertyDetails: true,
    setupFinished,
    roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1, priced: true }],
    placeholderPrices: true,
    bookingRules: "default",
    propertyPhotos: false,
    bookingPublished: false,
    onlineCardReady: false,
    onlineCardsOffered: false,
    viewer: { hidden: false, dismissed: false },
  });

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

async function mount(
  load: () => Promise<ReturnType<typeof goLive> | null>,
  navigate = vi.fn(),
  hotelName = "Hotel Alpenrose",
) {
  const client = {
    loadGoLive: vi.fn(load),
    looksGoodGoLive: vi.fn(async () => (await load())!),
    setGoLiveViewer: vi.fn(async () => (await load())!),
  };
  function Dashboard() {
    const setup = usePmsSetupChecklist({
      client,
      resolvePropertyId: async () => PROPERTY,
      hotelName: async () => hotelName,
    });
    return (
      <div>
        <PmsDashboardSetupBanner setup={setup} incompleteSetupPropertyId={PROPERTY} />
        <PmsDashboardSetupCard setup={setup} navigate={navigate} />
      </div>
    );
  }
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Dashboard />);
  });
  await act(async () => undefined);
  return { renderer: renderer!, client, text: () => textOf(renderer!.root) };
}

describe("the go-live cards on the PMS dashboard (VAY-2247 wave 2, VAY-2451)", () => {
  it("keeps today's amber banner while the checklist API isn't mounted (404) or fails", async () => {
    for (const load of [async () => null, async () => Promise.reject(new Error("offline"))]) {
      const dashboard = await mount(load);
      expect(dashboard.text()).toContain("Your property setup isn't complete.");
      expect(dashboard.text()).toContain("Resume setup");
      expect(dashboard.text()).not.toContain("Finish setting up");
      expect(dashboard.renderer.root.findByType("a").props.href).toBe(
        `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${PROPERTY}`,
      );
      dashboard.renderer.unmount();
    }
  });

  it("before Finish setup: the setup card instead of the banner, continuing in setup", async () => {
    const navigate = vi.fn();
    const dashboard = await mount(async () => goLive(false), navigate);
    expect(dashboard.text()).not.toContain("Your property setup isn't complete.");
    expect(dashboard.text()).toContain("Finish setting up Hotel Alpenrose");
    await act(async () =>
      dashboard.renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Continue setup")
        .props.onClick(),
    );
    expect(navigate).toHaveBeenCalledWith(
      `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${PROPERTY}`,
    );
    dashboard.renderer.unmount();
  });

  it("shows the go-live list once setup is finished, with rates opening Rooms & Rates", async () => {
    const navigate = vi.fn();
    const dashboard = await mount(async () => goLive(true), navigate);
    expect(dashboard.text()).toContain("Get ready to go live");
    expect(dashboard.text()).toContain("Later, when you're ready");
    expect(dashboard.text()).not.toContain("Your property setup isn't complete.");
    expect(dashboard.client.loadGoLive).toHaveBeenCalledWith(PROPERTY);
    await act(async () =>
      dashboard.renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Add rates")
        .props.onClick(),
    );
    expect(navigate).toHaveBeenCalledWith("/rooms");
    dashboard.renderer.unmount();
  });

  it("speaks German from the PMS catalog", async () => {
    i18n.lang = "de";
    try {
      const setup = await mount(async () => goLive(false));
      expect(setup.text()).toContain("Hotel Alpenrose fertig einrichten");
      expect(setup.text()).toContain("Einrichtung fortsetzen");
      setup.renderer.unmount();
      const finished = await mount(async () => goLive(true));
      expect(finished.text()).toContain("Livegang vorbereiten");
      finished.renderer.unmount();
    } finally {
      i18n.lang = "en";
    }
  });
});
