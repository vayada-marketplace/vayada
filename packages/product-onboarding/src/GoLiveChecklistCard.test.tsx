import { buildHotelGoLiveChecklist, type HotelGoLiveChecklistFacts } from "@vayada/domain-hotels";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  GoLiveChecklistCard,
  GoLiveLaterCard,
  GoLiveSetupCard,
  SetupFinishedToast,
} from "./GoLiveChecklistCard";

const FACTS: HotelGoLiveChecklistFacts = {
  propertyId: "3f2c4d5e-6a7b-4c8d-9e0f-112233445566",
  propertyDetails: true,
  setupFinished: true,
  roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 3, priced: true }],
  placeholderPrices: true,
  bookingRules: "default",
  propertyPhotos: false,
  bookingPublished: false,
  onlineCardReady: false,
  onlineCardsOffered: false,
  viewer: { hidden: false, dismissed: false },
};
const checklist = (facts: Partial<HotelGoLiveChecklistFacts> = {}) =>
  buildHotelGoLiveChecklist({ ...FACTS, ...facts });

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttons = (root: ReactTestInstance) =>
  root.findAll((node) => node.type === "button").map((node) => textOf(node));

describe("GoLiveSetupCard (VAY-2451 dashboard state A)", () => {
  it("shows the steps done, the next one with its time, and later steps locked", () => {
    const onContinue = vi.fn();
    const onOpenStep = vi.fn();
    const renderer = create(
      <GoLiveSetupCard
        checklist={checklist({ setupFinished: false, roomTypes: [] })}
        hotelName="Lumansa Hiriketiya"
        onContinue={onContinue}
        onOpenStep={onOpenStep}
      />,
    );
    const text = textOf(renderer.root);
    expect(text).toContain("2/4");
    expect(text).toContain("Finish setting up Lumansa Hiriketiya");
    expect(text).toContain("Next: First room, about 5 minutes. Everything so far is saved.");
    const tiles = renderer.root.findAll(
      (node) => node.type === "button" && textOf(node) !== "Continue setup",
    );
    expect(tiles.map((tile) => textOf(tile))).toEqual([
      "Your propertyDone",
      "Location & contactDone",
      "3First roomNext · 5 min",
      "4Guest payments1 min",
    ]);
    expect(tiles.map((tile) => tile.props.disabled)).toEqual([false, false, false, true]);
    act(() => tiles[0]!.props.onClick());
    expect(onOpenStep).toHaveBeenCalledWith("property");
    act(() => tiles[2]!.props.onClick());
    expect(onContinue).toHaveBeenCalledOnce();
    renderer.unmount();
  });
});

describe("GoLiveChecklistCard (VAY-2451 dashboard state B)", () => {
  it("lists the six rows: rates wait on the placeholder, Publish stays locked", () => {
    const onOpenItem = vi.fn();
    const onPublish = vi.fn();
    const renderer = create(
      <GoLiveChecklistCard checklist={checklist()} onOpenItem={onOpenItem} onPublish={onPublish} />,
    );
    const text = textOf(renderer.root);
    expect(text).toContain("Get ready to go live");
    expect(text).toContain("2 of 6 done");
    expect(text).toContain("Pool Villa · 2 rooms · up to 4 guests · 3 photos");
    expect(text).toContain(
      "Your room shows a placeholder price. Set real prices before you go live.",
    );
    expect(text).toContain("Available once your room types and rates are in");
    expect(buttons(renderer.root)).toEqual([
      "Edit",
      "Edit",
      "Add rates",
      "Review",
      "Upload",
      "Publish",
    ]);
    // The first open row gets the filled button.
    const addRates = renderer.root.find(
      (node) => node.type === "button" && textOf(node) === "Add rates",
    );
    expect(String(addRates.props.className)).toContain("bg-primary-600");
    act(() => addRates.props.onClick());
    expect(onOpenItem).toHaveBeenCalledWith("rates");
    expect(
      renderer.root.find((node) => node.type === "button" && textOf(node) === "Publish").props
        .disabled,
    ).toBe(true);
    renderer.unmount();
  });

  it("offers Publish once rates are real, and says Live once published", () => {
    const onPublish = vi.fn();
    const ready = create(
      <GoLiveChecklistCard
        checklist={checklist({ placeholderPrices: false })}
        onOpenItem={vi.fn()}
        onPublish={onPublish}
      />,
    );
    const publish = ready.root.find((node) => node.type === "button" && textOf(node) === "Publish");
    expect(publish.props.disabled).toBe(false);
    act(() => publish.props.onClick());
    expect(onPublish).toHaveBeenCalledOnce();
    expect(textOf(ready.root)).toContain("All set. Guests can book as soon as you publish.");
    ready.unmount();

    const onDismiss = vi.fn();
    const live = create(
      <GoLiveChecklistCard
        checklist={checklist({ placeholderPrices: false, bookingPublished: true })}
        onOpenItem={vi.fn()}
        onPublish={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const text = textOf(live.root);
    expect(text).toContain("Your booking page is live");
    expect(text).toContain("Guests can book on your booking page.");
    expect(buttons(live.root)).not.toContain("Publish");
    act(() => live.root.findByProps({ "aria-label": "Dismiss" }).props.onClick());
    expect(onDismiss).toHaveBeenCalledOnce();
    live.unmount();
  });
});

describe("GoLiveChecklistCard room photos (VAY-2451)", () => {
  it("counts room types without a photo as done, and suggests one instead of requiring it", () => {
    const card = create(
      <GoLiveChecklistCard
        checklist={checklist({
          placeholderPrices: false,
          bookingPublished: true,
          roomTypes: [{ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 0, priced: true }],
        })}
        onOpenItem={vi.fn()}
        onPublish={vi.fn()}
      />,
    );
    const row = card.root.find((node) => node.type === "li" && textOf(node).includes("Room types"));
    expect(textOf(row)).toContain("Done:");
    expect(textOf(row)).toContain("Recommended");
    expect(textOf(row)).toContain("Add a photo to each room type. Guests book rooms they can see.");
    expect(textOf(row)).not.toContain("Required");
    expect(textOf(card.root)).toContain("4 of 6 done");
    card.unmount();

    // With its photos, the row names the room and says nothing more.
    const photographed = create(
      <GoLiveChecklistCard checklist={checklist()} onOpenItem={vi.fn()} onPublish={vi.fn()} />,
    );
    const done = photographed.root.find(
      (node) => node.type === "li" && textOf(node).includes("Room types"),
    );
    expect(textOf(done)).toContain("Pool Villa · 2 rooms · up to 4 guests · 3 photos");
    expect(textOf(done)).not.toContain("Recommended");
    photographed.unmount();
  });
});

describe("GoLiveChecklistCard booking rules (VAY-2451)", () => {
  it("names the defaults only while they are the defaults", () => {
    for (const [rules, shown, hidden] of [
      ["default", "Defaults set:", "Cancellation, check-in times and guest rules"],
      ["changed", "Cancellation, check-in times and guest rules", "Defaults set:"],
      ["acknowledged", "Cancellation, check-in times and guest rules", "Defaults set:"],
    ] as const) {
      const card = create(
        <GoLiveChecklistCard
          checklist={checklist({ bookingRules: rules })}
          onOpenItem={vi.fn()}
          onPublish={vi.fn()}
        />,
      );
      expect(textOf(card.root)).toContain(shown);
      expect(textOf(card.root)).not.toContain(hidden);
      card.unmount();
    }
  });
});

describe("GoLiveLaterCard and the toast (VAY-2451)", () => {
  it("offers card payments and says the channel manager comes soon; the toast can be dismissed", () => {
    const onConnectCards = vi.fn();
    const later = create(
      <GoLiveLaterCard checklist={checklist()} onConnectCards={onConnectCards} />,
    );
    expect(textOf(later.root)).toContain("Online card payments");
    expect(textOf(later.root)).toContain("Soon");
    act(() =>
      later.root
        .find((node) => node.type === "button" && textOf(node) === "Connect")
        .props.onClick(),
    );
    expect(onConnectCards).toHaveBeenCalledOnce();
    later.unmount();

    const onDismiss = vi.fn();
    const toast = create(<SetupFinishedToast onDismiss={onDismiss} />);
    expect(textOf(toast.root)).toContain("Setup complete. A few steps left before you go live.");
    act(() => toast.root.findByProps({ "aria-label": "Dismiss" }).props.onClick());
    expect(onDismiss).toHaveBeenCalledOnce();
    toast.unmount();
  });
});
