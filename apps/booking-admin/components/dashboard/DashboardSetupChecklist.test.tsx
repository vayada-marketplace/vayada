import {
  buildHotelGoLiveChecklist,
  buildHotelSetupChecklist,
  type HotelSetupChecklistFacts,
} from "@vayada/domain-hotels";
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
  BOOKING_ADMIN_CHECKLIST_PAGES,
  PUBLISH_BOOKING_PAGE_EVENT,
  DashboardSetupChecklistCard,
  DashboardSetupChecklistChip,
  useDashboardSetupChecklist,
} from "./DashboardSetupChecklist";

// Tests run in node: the hook only listens on window for the header's hotel selection.
vi.stubGlobal("window", new EventTarget());

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

async function mount(
  load: () => Promise<unknown>,
  {
    navigate = vi.fn(),
    resolvePropertyId = async (): Promise<string | null> => PROPERTY,
    hotelName = "Hotel Alpenrose",
  }: {
    navigate?: (path: string) => void;
    resolvePropertyId?: () => Promise<string | null>;
    hotelName?: string;
  } = {},
) {
  const client = {
    load: vi.fn(load),
    looksGood: vi.fn(async () => checklist({ guestTerms: "acknowledged" })),
    setViewer: vi.fn(async (_id: string, change: { hidden?: boolean }) =>
      checklist({ viewer: { hidden: change.hidden === true, dismissed: false } }),
    ),
  };
  let ready = "";
  function Dashboard() {
    const setup = useDashboardSetupChecklist({ client: client as never, resolvePropertyId });
    ready = setup.state.kind;
    return (
      <div>
        <DashboardSetupChecklistChip setup={setup} />
        <DashboardSetupChecklistCard setup={setup} hotelName={hotelName} navigate={navigate} />
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
  return {
    renderer: renderer!,
    client,
    click,
    state: () => ready,
    text: () => textOf(renderer!.root),
  };
}

describe("Booking Admin dashboard setup checklist (VAY-2247 wave 2)", () => {
  it("shows nothing while the checklist API isn't mounted (404)", async () => {
    const dashboard = await mount(async () => Promise.reject(new NotFound("Not Found")));
    expect(dashboard.state()).toBe("unavailable");
    expect(dashboard.renderer.toJSON()).toEqual({ type: "div", props: {}, children: null });
    dashboard.renderer.unmount();
  });

  it("shows the shared checklist once the server answers (c02-0)", async () => {
    const navigate = vi.fn();
    const dashboard = await mount(async () => checklist(), { navigate });
    expect(dashboard.client.load).toHaveBeenCalledWith(PROPERTY);
    expect(dashboard.text()).toContain("Finish setting up Hotel Alpenrose");
    expect(dashboard.text()).toContain(
      "Same checklist in the PMS and Booking Admin. Progress is shared.",
    );
    expect(dashboard.text()).toContain("all rooms bookable");

    await dashboard.click("Style");
    expect(navigate).toHaveBeenLastCalledWith("/design-studio");
    await dashboard.click("Connect");
    expect(navigate).toHaveBeenLastCalledWith("/settings/payments");
    // Calendar's Looks good comes first; Guest terms' second.
    const looksGood = dashboard.renderer.root.findAll(
      (node) => node.type === "button" && textOf(node).includes("Looks good"),
    );
    await act(async () => looksGood[looksGood.length - 1]!.props.onClick());
    expect(dashboard.client.looksGood).toHaveBeenCalledWith(PROPERTY, "guest_terms");
    expect(dashboard.text()).toContain("5 of 9 done");
    dashboard.renderer.unmount();
  });

  it("continues setup in Booking Admin before the page is live (c01-0)", async () => {
    const navigate = vi.fn();
    const dashboard = await mount(
      async () =>
        checklist({
          nextSetupStep: "guest_payment",
          guestPayment: false,
          bookingPublished: false,
        }),
      { navigate },
    );
    expect(dashboard.text()).toContain("Your booking page isn't live yet");
    await dashboard.click("Continue setup");
    const [path] = navigate.mock.lastCall!;
    const url = new URL(path, "https://admin.example");
    expect(url.pathname).toBe("/setup");
    expect(url.searchParams.get("entryProduct")).toBe("booking");
    expect(url.searchParams.get("returnTo")).toBe("/dashboard");
    expect(url.searchParams.get("propertyId")).toBe(PROPERTY);
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

  it("waits for the header to pick a hotel, then loads once", async () => {
    let selected: string | null = null;
    const dashboard = await mount(async () => checklist(), {
      resolvePropertyId: async () => selected,
    });
    expect(dashboard.state()).toBe("loading");
    expect(dashboard.client.load).not.toHaveBeenCalled();
    selected = PROPERTY;
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_HOTEL_CHANGED_EVENT));
      window.dispatchEvent(new Event(SELECTED_HOTEL_CHANGED_EVENT));
    });
    await act(async () => undefined);
    expect(dashboard.state()).toBe("ready");
    expect(dashboard.client.load).toHaveBeenCalledTimes(1);
    dashboard.renderer.unmount();
  });

  it("speaks the admin's language from Booking Admin's catalogs", async () => {
    i18n.lang = "de";
    try {
      const dashboard = await mount(async () => checklist());
      expect(dashboard.text()).toContain("Hotel Alpenrose fertig einrichten");
      expect(dashboard.text()).toContain(
        "Dieselbe Checkliste im PMS und im Booking Admin. Der Fortschritt wird geteilt.",
      );
      expect(dashboard.text()).toContain("4 von 9 erledigt");
      expect(dashboard.text()).toContain("alle Zimmer buchbar");
      expect(dashboard.text()).toContain("Passt so");
      expect(dashboard.text()).toContain("öffnet Booking Admin → Designstudio");
      await dashboard.click("Vorerst ausblenden");
      expect(dashboard.text()).toContain("Einrichtung 4 von 9");
      dashboard.renderer.unmount();
    } finally {
      i18n.lang = "en";
    }
  });

  it("names the hotel generically until its settings answer", async () => {
    const dashboard = await mount(async () => checklist(), { hotelName: "" });
    expect(dashboard.text()).toContain("Finish setting up your hotel");
    dashboard.renderer.unmount();
  });

  it("sends the PMS's items to the PMS and Booking Admin's to Booking Admin", () => {
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.photos).toEqual({ app: "pms", path: "/rooms" });
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.calendar).toEqual({
      app: "pms",
      path: "/settings/calendar",
    });
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.style).toEqual({
      app: "booking_admin",
      path: "/design-studio",
    });
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.guest_terms).toEqual({
      app: "booking_admin",
      path: "/settings/policies",
    });
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.online_cards).toEqual({
      app: "booking_admin",
      path: "/settings/payments",
    });
  });
});

describe("the go-live cards on the Booking Admin dashboard (VAY-2451)", () => {
  const goLive = (setupFinished: boolean, placeholderPrices = true) =>
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
    });

  async function mountGoLive(answer: ReturnType<typeof goLive>, navigate = vi.fn()) {
    const client = {
      load: vi.fn(),
      looksGood: vi.fn(),
      setViewer: vi.fn(),
      loadGoLive: vi.fn(async () => answer),
      looksGoodGoLive: vi.fn(async () => answer),
    };
    function Dashboard() {
      const setup = useDashboardSetupChecklist({
        client: client as never,
        resolvePropertyId: async () => PROPERTY,
      });
      return (
        <div>
          <DashboardSetupChecklistChip setup={setup} />
          <DashboardSetupChecklistCard
            setup={setup}
            hotelName="Lumansa Hiriketiya"
            navigate={navigate}
            bookingPage={<p>Booking page card</p>}
          />
        </div>
      );
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Dashboard />);
    });
    await act(async () => undefined);
    return { renderer: renderer!, client, navigate };
  }

  it("shows the go-live list and today's checklist isn't read", async () => {
    const { renderer, client, navigate } = await mountGoLive(goLive(true));
    const text = textOf(renderer.root);
    expect(text).toContain("Get ready to go live");
    expect(text).toContain("Booking page card");
    expect(text).not.toContain("Setup ");
    expect(client.load).not.toHaveBeenCalled();
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

  it("before Finish setup: continue where setup stopped", async () => {
    const { renderer, navigate } = await mountGoLive(goLive(false));
    expect(textOf(renderer.root)).toContain("Finish setting up Lumansa Hiriketiya");
    await act(async () =>
      renderer.root
        .find((node) => node.type === "button" && textOf(node) === "Continue setup")
        .props.onClick(),
    );
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining(`propertyId=${PROPERTY}`));
    renderer.unmount();
  });
});
