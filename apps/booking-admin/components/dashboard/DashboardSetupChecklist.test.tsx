import { buildHotelSetupChecklist, type HotelSetupChecklistFacts } from "@vayada/domain-hotels";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { SELECTED_HOTEL_CHANGED_EVENT } from "@/services/api/bookingHotelScope";
import {
  BOOKING_ADMIN_CHECKLIST_PAGES,
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
  }: { navigate?: (path: string) => void; resolvePropertyId?: () => Promise<string | null> } = {},
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
        <DashboardSetupChecklistCard
          setup={setup}
          hotelName="Hotel Alpenrose"
          navigate={navigate}
        />
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

  it("sends the PMS's items to the PMS and Booking Admin's to Booking Admin", () => {
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.photos).toEqual({ app: "pms", path: "/rooms" });
    expect(BOOKING_ADMIN_CHECKLIST_PAGES.calendar).toEqual({ app: "pms", path: "/settings" });
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
