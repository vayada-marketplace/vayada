import { buildHotelSetupChecklist, type HotelSetupChecklistFacts } from "@vayada/domain-hotels";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { HotelSetupChecklistCard, HotelSetupChecklistChip } from "./HotelSetupChecklistCard";

const LIVE: HotelSetupChecklistFacts = {
  propertyId: "3f2c4d5e-6a7b-4c8d-9e0f-112233445566",
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

function props(facts: Partial<HotelSetupChecklistFacts> = {}) {
  return {
    checklist: buildHotelSetupChecklist({ ...LIVE, ...facts }),
    hotelName: "Hotel Alpenrose",
    product: "pms" as const,
    roomCount: 8,
    onContinueSetup: vi.fn(),
    onOpen: vi.fn(),
    onLooksGood: vi.fn(async () => undefined),
    onHide: vi.fn(async () => undefined),
    onDismiss: vi.fn(async () => undefined),
  };
}

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll((node) => node.type === "button" && textOf(node).includes(label))[0]!;

describe("HotelSetupChecklistCard (VAY-2247 wave 2, Paper rev 4 c01/c02)", () => {
  it("follows the setup screens before the booking page is live (c01-0)", () => {
    const card = props({
      nextSetupStep: "first_room",
      firstRoom: false,
      guestPayment: false,
      bookingPublished: false,
    });
    const markup = renderToStaticMarkup(<HotelSetupChecklistCard {...card} />);
    expect(markup).toContain("Your booking page isn&#x27;t live yet");
    expect(markup).toContain("You&#x27;re 2 of 5 steps in. Everything you entered is saved.");
    for (const step of [
      "Welcome",
      "Your hotel",
      "First room and price",
      "How guests pay",
      "Go live",
    ])
      expect(markup).toContain(step);
    expect(markup).toContain(">Next<");
    expect(markup).toContain("Continue setup");
  });

  it("shows what setup did as chips and what's left as rows (c01-1: 4 of 9)", () => {
    const markup = renderToStaticMarkup(<HotelSetupChecklistCard {...props()} />);
    expect(markup).toContain("Finish setting up Hotel Alpenrose");
    expect(markup).toContain("none of them stop bookings");
    expect(markup).toContain("4 of 9 done");
    for (const chip of [
      "Hotel basics",
      "First room and price",
      "How guests pay",
      "Booking page published",
    ])
      expect(markup).toContain(chip);
    for (const row of [
      "Hotel and room photos",
      "Logo and booking page style",
      "Calendar",
      "Guest terms",
      "Online card payments",
    ])
      expect(markup).toContain(row);
    expect(markup).toContain("all 8 rooms bookable");
    // Each row is drawn twice: the phone layout and the desktop one.
    expect(markup.match(/>To do</g)).toHaveLength(2);
    expect(markup.match(/>Default in use</g)).toHaveLength(6);
    expect(markup.match(/>Later</g)).toHaveLength(2);
    expect(markup.match(/Looks good/g)).toHaveLength(4);
    for (const action of ["Add photos", "Style", "Connect", "Hide for now"])
      expect(markup).toContain(action);
  });

  it("says Booking Admin shares the checklist with the PMS (c02-0)", () => {
    const markup = renderToStaticMarkup(
      <HotelSetupChecklistCard {...props()} product="booking_admin" />,
    );
    expect(markup).toContain("Same checklist in the PMS and Booking Admin. Progress is shared.");
  });

  it("confirms Looks good, opens each item's page and hides for now", async () => {
    const card = props();
    const renderer = create(<HotelSetupChecklistCard {...card} />);
    await act(async () => button(renderer, "Looks good").props.onClick());
    expect(card.onLooksGood).toHaveBeenCalledWith("calendar");
    expect(textOf(renderer.root)).toContain("Calendar confirmed — your defaults stay.");
    for (const [label, item] of [
      ["Add photos", "photos"],
      ["Style", "style"],
      ["Review", "calendar"],
      ["Connect", "online_cards"],
    ] as const) {
      await act(async () => button(renderer, label).props.onClick());
      expect(card.onOpen).toHaveBeenLastCalledWith(item);
    }
    // On phones the whole row opens the item.
    await act(async () => button(renderer, "Online card payments").props.onClick());
    expect(card.onOpen).toHaveBeenLastCalledWith("online_cards");
    await act(async () => button(renderer, "Hide for now").props.onClick());
    expect(card.onHide).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("says when a change didn't save", async () => {
    const card = { ...props(), onLooksGood: vi.fn(async () => Promise.reject(new Error("down"))) };
    const renderer = create(<HotelSetupChecklistCard {...card} />);
    await act(async () => button(renderer, "Looks good").props.onClick());
    expect(textOf(renderer.root)).toContain("That didn't save. Try again in a moment.");
    renderer.unmount();
  });

  it("shows Setup complete with Dismiss once all nine are done (c01-4)", async () => {
    const card = props({
      photos: true,
      style: true,
      calendar: "acknowledged",
      guestTerms: "changed",
      onlineCardReady: true,
    });
    const renderer = create(<HotelSetupChecklistCard {...card} />);
    expect(textOf(renderer.root)).toContain("Setup complete — nice work");
    await act(async () => button(renderer, "Dismiss").props.onClick());
    expect(card.onDismiss).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it("hides for the person who hid it, leaving the header chip (c01-3)", async () => {
    const hidden = props({ viewer: { hidden: true, dismissed: false } });
    expect(renderToStaticMarkup(<HotelSetupChecklistCard {...hidden} />)).toBe("");
    const onShow = vi.fn();
    const renderer = create(
      <HotelSetupChecklistChip checklist={hidden.checklist} onShow={onShow} />,
    );
    expect(textOf(renderer.root)).toBe("Setup 4 of 9");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(onShow).toHaveBeenCalledTimes(1);
    renderer.unmount();
    // No chip while the checklist shows, nor once it is dismissed.
    expect(
      renderToStaticMarkup(
        <HotelSetupChecklistChip checklist={props().checklist} onShow={onShow} />,
      ),
    ).toBe("");
    const dismissed = props({ viewer: { hidden: false, dismissed: true } });
    expect(renderToStaticMarkup(<HotelSetupChecklistCard {...dismissed} />)).toBe("");
  });
});
