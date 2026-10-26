import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
const calls = vi.hoisted(() => ({ booking: vi.fn() }));
vi.mock("./BookingReviewCard", () => ({
  BookingReviewCard: (props: unknown) => {
    calls.booking(props);
    return createElement("p", null, "Booking unavailable");
  },
}));
import { ReviewStep } from "./ReviewStep";
it.each([[["hotel_operations"], 1]] as const)(
  "composes the booking card for %s with independent status and edit coordinates",
  async (tracks, booking) => {
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
    expect(calls.booking).toHaveBeenCalledTimes(booking);
    const received = calls.booking.mock.calls[0][0];
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

// Without a selected track there is no product card, only the finish controls.
it("renders only the finish controls when no booking track is selected", async () => {
  vi.clearAllMocks();
  const props = {
    route: { scope: { propertyId: "hotel", organizationId: "org" }, selectedTracks: [] },
    goToStep: vi.fn(),
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdaptiveSetupStepComponentProps;
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(createElement(ReviewStep, props));
  });
  expect(calls.booking).not.toHaveBeenCalled();
  expect(tree.root.findAllByType("button")).toHaveLength(1);
  await act(async () => tree.unmount());
});
