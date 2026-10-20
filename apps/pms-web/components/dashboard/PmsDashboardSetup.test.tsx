import { buildHotelSetupChecklist, type HotelSetupChecklistFacts } from "@vayada/domain-hotels";
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
  PMS_CHECKLIST_PAGES,
  PmsDashboardSetupBanner,
  PmsDashboardSetupCard,
  PmsDashboardSetupChip,
  usePmsSetupChecklist,
} from "./PmsDashboardSetup";

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const LIVE: HotelSetupChecklistFacts = {
  propertyId: PROPERTY,
  nextSetupStep: null,
  hotelBasics: true,
  firstRoom: true,
  guestPayment: true,
  bookingPublished: true,
  photos: false,
  style: false,
  calendar: "default",
  guestTerms: "default",
  onlineCardReady: false,
  onlineCardsOffered: false,
  viewer: { hidden: false, dismissed: false },
};
const checklist = (facts: Partial<HotelSetupChecklistFacts> = {}) =>
  buildHotelSetupChecklist({ ...LIVE, ...facts });

class NotFound extends Error {
  status = 404;
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

async function mount(load: () => Promise<unknown>, navigate = vi.fn()) {
  const client = {
    load: vi.fn(load),
    looksGood: vi.fn(async () => checklist({ calendar: "acknowledged" })),
    setViewer: vi.fn(async (_id: string, change: { hidden?: boolean }) =>
      checklist({ viewer: { hidden: change.hidden === true, dismissed: false } }),
    ),
  };
  function Dashboard() {
    const setup = usePmsSetupChecklist({
      client: client as never,
      resolvePropertyId: async () => PROPERTY,
      hotelName: async () => "Hotel Alpenrose",
    });
    return (
      <div>
        <PmsDashboardSetupBanner setup={setup} incompleteSetupPropertyId={PROPERTY} />
        <PmsDashboardSetupChip setup={setup} />
        <PmsDashboardSetupCard setup={setup} roomCount={8} navigate={navigate} />
      </div>
    );
  }
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<Dashboard />);
  });
  await act(async () => undefined);
  const click = async (label: string) => {
    const button = renderer!.root.findAll(
      (node) => node.type === "button" && textOf(node).includes(label),
    )[0]!;
    await act(async () => button.props.onClick());
  };
  return { renderer: renderer!, client, click, text: () => textOf(renderer!.root) };
}

describe("PMS dashboard setup checklist (VAY-2247 wave 2)", () => {
  it("keeps today's amber banner while the checklist API isn't mounted (404)", async () => {
    const dashboard = await mount(async () => Promise.reject(new NotFound("Not Found")));
    expect(dashboard.text()).toContain("Your property setup isn't complete.");
    expect(dashboard.text()).toContain("Resume setup");
    expect(dashboard.text()).not.toContain("Finish setting up");
    expect(dashboard.renderer.root.findByType("a").props.href).toBe(
      `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${PROPERTY}`,
    );
    dashboard.renderer.unmount();
  });

  it("shows the checklist instead of the banner once the server answers", async () => {
    const navigate = vi.fn();
    const dashboard = await mount(async () => checklist(), navigate);
    expect(dashboard.text()).not.toContain("Your property setup isn't complete.");
    expect(dashboard.text()).toContain("Finish setting up Hotel Alpenrose");
    expect(dashboard.text()).toContain("all 8 rooms bookable");

    await dashboard.click("Add photos");
    expect(navigate).toHaveBeenLastCalledWith("/rooms");
    await dashboard.click("Looks good");
    expect(dashboard.client.looksGood).toHaveBeenCalledWith(PROPERTY, "calendar");
    expect(dashboard.text()).toContain("5 of 9 done");
    dashboard.renderer.unmount();
  });

  it("hides the card for this person, leaving the Setup pill to bring it back", async () => {
    const dashboard = await mount(async () => checklist());
    await dashboard.click("Hide for now");
    expect(dashboard.client.setViewer).toHaveBeenLastCalledWith(PROPERTY, { hidden: true });
    expect(dashboard.text()).not.toContain("Finish setting up");
    expect(dashboard.text()).toContain("Setup 4 of 9");
    await dashboard.click("Setup 4 of 9");
    expect(dashboard.client.setViewer).toHaveBeenLastCalledWith(PROPERTY, { hidden: false });
    expect(dashboard.text()).toContain("Finish setting up");
    dashboard.renderer.unmount();
  });

  it("speaks German from the PMS catalog", async () => {
    i18n.lang = "de";
    try {
      const dashboard = await mount(async () => checklist());
      expect(dashboard.text()).toContain("Hotel Alpenrose fertig einrichten");
      expect(dashboard.text()).toContain("4 von 9 erledigt");
      expect(dashboard.text()).toContain("alle 8 Zimmer buchbar");
      expect(dashboard.text()).toContain("Passt so");
      expect(dashboard.text()).toContain("Fotos hinzufügen");
      dashboard.renderer.unmount();
    } finally {
      i18n.lang = "en";
    }
  });

  it("sends Booking Admin's items to Booking Admin and the PMS's to the PMS", () => {
    expect(PMS_CHECKLIST_PAGES.photos).toEqual({ app: "pms", path: "/rooms" });
    expect(PMS_CHECKLIST_PAGES.calendar).toEqual({ app: "pms", path: "/settings" });
    expect(PMS_CHECKLIST_PAGES.style).toEqual({ app: "booking_admin", path: "/design-studio" });
    expect(PMS_CHECKLIST_PAGES.guest_terms).toEqual({
      app: "booking_admin",
      path: "/settings/policies",
    });
    expect(PMS_CHECKLIST_PAGES.online_cards).toEqual({
      app: "booking_admin",
      path: "/settings/payments",
    });
  });
});
