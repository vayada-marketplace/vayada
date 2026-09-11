import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const calls = vi.hoisted(() => ({ marketplace: vi.fn(), booking: vi.fn() }));
vi.mock("./MarketplaceReviewCard", () => ({
  MarketplaceReviewCard: (props: unknown) => {
    calls.marketplace(props);
    return createElement("p", null, "Marketplace pending");
  },
}));
vi.mock("./BookingReviewCard", () => ({
  BookingReviewCard: (props: unknown) => {
    calls.booking(props);
    return createElement("p", null, "Booking unavailable");
  },
}));
import { ReviewStep } from "./ReviewStep";
it.each([
  [["creator_marketplace"], 1, 0],
  [["hotel_operations"], 0, 1],
  [["creator_marketplace", "hotel_operations"], 1, 1],
] as const)(
  "composes only selected products %s with independent status and edit coordinates",
  async (tracks, marketplace, booking) => {
    vi.clearAllMocks();
    const goToStep = vi.fn();
    const saveAndContinue = vi.fn().mockResolvedValue(undefined);
    const props = {
      route: { scope: { propertyId: "hotel", organizationId: "org" }, selectedTracks: tracks },
      goToStep,
      saveAndContinue,
    } as unknown as AdaptiveSetupStepComponentProps;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(createElement(ReviewStep, props));
    });
    expect(calls.marketplace).toHaveBeenCalledTimes(marketplace);
    expect(calls.booking).toHaveBeenCalledTimes(booking);
    const card = booking ? calls.booking : calls.marketplace;
    const received = card.mock.calls[0][0];
    expect(received).toMatchObject({ propertyId: "hotel", organizationId: "org" });
    received.onEdit("rooms", "room-2");
    expect(goToStep).toHaveBeenCalledWith("rooms", "room-2");
    expect(saveAndContinue).not.toHaveBeenCalled();
    await act(async () => {
      await tree.root.findByType("button").props.onClick();
    });
    expect(saveAndContinue).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  },
);
