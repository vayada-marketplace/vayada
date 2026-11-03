import { buildHotelGoLiveChecklist } from "@vayada/domain-hotels";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const i18n = vi.hoisted(() => ({ lang: "en" as "en" | "de" | "ja" }));
vi.mock("@/lib/i18n", async () => {
  const catalogs = {
    en: (await import("../../messages/en.json")).default as Record<string, string>,
    de: (await import("../../messages/de.json")).default as Record<string, string>,
    ja: (await import("../../messages/ja.json")).default as Record<string, string>,
  };
  // As the app's translate: the catalog's text with {params} filled in, English when missing.
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      catalogs[i18n.lang][key] ?? catalogs.en[key] ?? key,
    );
  return { useTranslation: () => ({ t }) };
});

import { SELECTED_HOTEL_CHANGED_EVENT } from "@/services/api/bookingHotelScope";
import {
  BOOKING_PAGE_ONLINE_EVENT,
  PUBLISH_BOOKING_PAGE_EVENT,
  DashboardSetupChecklistCard,
  useDashboardSetupChecklist,
} from "./DashboardSetupChecklist";

// Tests run in node: the hook only listens on window for the header's hotel selection.
vi.stubGlobal("window", new EventTarget());

const PROPERTY = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("the go-live cards on the Booking Admin dashboard (VAY-2451)", () => {
  const goLive = (
    setupFinished: boolean,
    placeholderPrices = true,
    extra: Partial<Parameters<typeof buildHotelGoLiveChecklist>[0]> = {},
  ) =>
    buildHotelGoLiveChecklist({
      propertyId: PROPERTY,
      propertyDetails: true,
      setupFinished,
      roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1, priced: true }],
      placeholderPrices,
      bookingRules: "default",
      propertyPhotos: false,
      bookingPublished: false,
      onlineCardReady: false,
      onlineCardsOffered: false,
      viewer: { hidden: false, dismissed: false },
      ...extra,
    });

  async function mountGoLive(
    answer: ReturnType<typeof goLive> | null | (() => Promise<ReturnType<typeof goLive> | null>),
    navigate = vi.fn(),
    {
      resolvePropertyId = async (): Promise<string | null> => PROPERTY,
      hotelName = "Lumansa Hiriketiya",
    }: { resolvePropertyId?: () => Promise<string | null>; hotelName?: string } = {},
  ) {
    const load = typeof answer === "function" ? answer : async () => answer;
    const client = {
      loadGoLive: vi.fn(load),
      looksGoodGoLive: vi.fn(async () => (await load())!),
      setGoLiveViewer: vi.fn(async () => ({
        ...(await load())!,
        viewer: { hidden: false, dismissed: true },
      })),
    };
    let kind = "";
    function Dashboard() {
      const setup = useDashboardSetupChecklist({ client, resolvePropertyId });
      kind = setup.state.kind;
      return (
        <div>
          <DashboardSetupChecklistCard setup={setup} hotelName={hotelName} navigate={navigate} />
        </div>
      );
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Dashboard />);
    });
    await act(async () => undefined);
    return { renderer: renderer!, client, navigate, state: () => kind };
  }

  it("shows nothing while the API isn't mounted (404) or fails", async () => {
    const missing = await mountGoLive(null);
    expect(missing.state()).toBe("unavailable");
    expect(textOf(missing.renderer.root)).toBe("");
    missing.renderer.unmount();
    const failing = await mountGoLive(async () => {
      throw new Error("offline");
    });
    expect(failing.state()).toBe("unavailable");
    expect(textOf(failing.renderer.root)).toBe("");
    failing.renderer.unmount();
  });

  it("waits for the header to pick a hotel, then loads once", async () => {
    let selected: string | null = null;
    const dashboard = await mountGoLive(goLive(true), vi.fn(), {
      resolvePropertyId: async () => selected,
    });
    expect(dashboard.state()).toBe("loading");
    expect(dashboard.client.loadGoLive).not.toHaveBeenCalled();
    selected = PROPERTY;
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_HOTEL_CHANGED_EVENT));
      window.dispatchEvent(new Event(SELECTED_HOTEL_CHANGED_EVENT));
    });
    await act(async () => undefined);
    expect(dashboard.state()).toBe("go_live");
    expect(dashboard.client.loadGoLive).toHaveBeenCalledTimes(1);
    dashboard.renderer.unmount();
  });

  it("speaks the admin's language from Booking Admin's catalogs", async () => {
    i18n.lang = "de";
    try {
      const setup = await mountGoLive(goLive(false), vi.fn(), { hotelName: "Hotel Alpenrose" });
      expect(textOf(setup.renderer.root)).toContain("Hotel Alpenrose fertig einrichten");
      expect(textOf(setup.renderer.root)).toContain("Einrichtung fortsetzen");
      setup.renderer.unmount();
      const finished = await mountGoLive(goLive(true));
      expect(textOf(finished.renderer.root)).toContain("Livegang vorbereiten");
      expect(textOf(finished.renderer.root)).toContain("Veröffentlichen");
      finished.renderer.unmount();
    } finally {
      i18n.lang = "en";
    }
  });

  it("names the property generically until its settings answer", async () => {
    const dashboard = await mountGoLive(goLive(false), vi.fn(), { hotelName: "" });
    expect(textOf(dashboard.renderer.root)).toContain("Finish setting up your property");
    dashboard.renderer.unmount();
  });

  it("shows the go-live list once setup is finished", async () => {
    const { renderer, client, navigate } = await mountGoLive(goLive(true));
    expect(textOf(renderer.root)).toContain("Get ready to go live");
    expect(client.loadGoLive).toHaveBeenCalledWith(PROPERTY);
    // Publish is locked on the placeholder; Review says Looks good, then opens the policies.
    const button = (label: string) =>
      renderer.root.find((node) => node.type === "button" && textOf(node) === label);
    expect(button("Publish").props.disabled).toBe(true);
    await act(async () => button("Review").props.onClick());
    await act(async () => undefined);
    expect(client.looksGoodGoLive).toHaveBeenCalledWith(PROPERTY, "guest_terms");
    expect(navigate).toHaveBeenCalledWith("/settings/policies");
    renderer.unmount();
  });

  it("asks the booking page card to publish once rates are real", async () => {
    const { renderer } = await mountGoLive(goLive(true, false));
    const published = vi.fn();
    window.addEventListener(PUBLISH_BOOKING_PAGE_EVENT, published);
    await act(async () =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Publish")
        .props.onClick(),
    );
    expect(published).toHaveBeenCalledOnce();
    window.removeEventListener(PUBLISH_BOOKING_PAGE_EVENT, published);
    renderer.unmount();
  });

  it("reads the list again once the booking page card says the page went online", async () => {
    const ready = goLive(true, false);
    const live = goLive(true, false, { bookingPublished: true });
    let published = false;
    const { renderer, client } = await mountGoLive(async () => (published ? live : ready));
    expect(textOf(renderer.root)).toContain("Get ready to go live");
    published = true;
    await act(async () => {
      window.dispatchEvent(new Event(BOOKING_PAGE_ONLINE_EVENT));
    });
    await act(async () => undefined);
    expect(client.loadGoLive).toHaveBeenCalledTimes(2);
    expect(textOf(renderer.root)).toContain("Your booking page is live");
    // Once unmounted (its effects cleaned up), the event reads nothing.
    await act(async () => renderer.unmount());
    window.dispatchEvent(new Event(BOOKING_PAGE_ONLINE_EVENT));
    expect(client.loadGoLive).toHaveBeenCalledTimes(2);
  });

  it("before Finish setup: continue where setup stopped", async () => {
    const { renderer, navigate } = await mountGoLive(goLive(false));
    expect(textOf(renderer.root)).toContain("Finish setting up Lumansa Hiriketiya");
    await act(async () =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Continue setup")
        .props.onClick(),
    );
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`propertyId=${PROPERTY}`));
    // The room tile opens setup at its room step, by the id setup links keep.
    await act(async () =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node).startsWith("First room"))
        .props.onClick(),
    );
    expect(navigate).toHaveBeenLastCalledWith(expect.stringContaining("&step=rooms"));
    renderer.unmount();
  });

  it("lets a live hotel dismiss the card, and leaves it out once dismissed or hidden", async () => {
    const live = goLive(true, false, { bookingRules: "acknowledged", bookingPublished: true });
    const { renderer, client } = await mountGoLive(live);
    expect(textOf(renderer.root)).toContain("Your booking page is live");
    await act(async () => renderer.root.findByProps({ "aria-label": "Dismiss" }).props.onClick());
    await act(async () => undefined);
    expect(client.setGoLiveViewer).toHaveBeenCalledWith(PROPERTY, { dismissed: true });
    expect(textOf(renderer.root)).not.toContain("Your booking page is live");
    renderer.unmount();

    const hidden = await mountGoLive(
      goLive(true, false, {
        bookingRules: "acknowledged",
        bookingPublished: true,
        viewer: { hidden: true, dismissed: false },
      }),
    );
    expect(textOf(hidden.renderer.root)).not.toContain("Your booking page is live");
    hidden.renderer.unmount();
  });
});
