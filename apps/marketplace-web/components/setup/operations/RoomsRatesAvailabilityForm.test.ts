import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getRoomSetupState: vi.fn(),
}));
vi.mock("@/services/api/hotelOperationsSetupClient", () => ({
  hotelOperationsSetupApi: mocks,
  hotelOperationsErrorMessage: (_: unknown, fallback: string) => fallback,
}));
import { RoomImportRevisionContext } from "../RoomImportRevisionContext";
import { RoomsRatesAvailabilityForm } from "./RoomsRatesAvailabilityForm";
const recovery = {
  status: "needs_recovery",
  room: {
    roomTypeId: "imported",
    active: true,
    name: "Imported Suite",
    totalRooms: 0,
    maxOccupancy: 2,
    nightlyRate: "0.00",
    currency: "EUR",
    minimumStay: null,
  },
  reasonCodes: ["missing_non_retired_room", "missing_active_rate_plan", "missing_future_inventory"],
};
const handlers = {
  onCompleted: vi.fn(),
  onOpenRoomsAndRates: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRoomSetupState.mockResolvedValue({ status: "empty" });
});
function render(revision: number, propertyId = "hotel-a") {
  return createElement(
    RoomImportRevisionContext.Provider,
    { value: revision },
    createElement(RoomsRatesAvailabilityForm, {
      propertyId,
      taskComplete: false,
      onBack: null,
      ...handlers,
    }),
  );
}
async function mount(revision = 0) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(render(revision));
  });
  return view;
}
const submitButton = (view: ReactTestRenderer) => view.root.findByProps({ type: "submit" });
const submit = (view: ReactTestRenderer) =>
  act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
it("hands a hotel with no rooms to PMS Rooms & Rates instead of offering a room form", async () => {
  const view = await mount();
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain("Add your room types in Rooms & Rates.");
  expect(output).toContain("Prices tab");
  expect(view.root.findAllByType("input")).toHaveLength(0);
  expect(submitButton(view).props.children).toBe("Open Rooms & Rates");
  await submit(view);
  expect(handlers.onOpenRoomsAndRates).toHaveBeenCalledTimes(1);
  expect(handlers.onCompleted).not.toHaveBeenCalled();
  expect(submitButton(view).props.disabled).toBe(true);
  await act(async () => view.unmount());
});
it("offers Rooms & Rates for an incomplete setup", async () => {
  mocks.getRoomSetupState.mockResolvedValue(recovery);
  const view = await mount();
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain("Imported Suite");
  expect(output).toContain("Add at least one active physical room.");
  await act(async () => view.root.findByProps({ children: "Open Rooms & Rates" }).props.onClick());
  expect(handlers.onOpenRoomsAndRates).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});
it("checks an incomplete setup again and continues once it is complete", async () => {
  mocks.getRoomSetupState.mockResolvedValue(recovery);
  const view = await mount();
  expect(submitButton(view).props.children).toBe("Check setup again");
  mocks.getRoomSetupState.mockResolvedValue({ status: "complete", room: null });
  await submit(view);
  expect(mocks.getRoomSetupState).toHaveBeenLastCalledWith("hotel-a");
  expect(handlers.onCompleted).toHaveBeenCalledTimes(1);
  expect(handlers.onOpenRoomsAndRates).not.toHaveBeenCalled();
  await act(async () => view.unmount());
});
it("continues an already complete setup without opening Rooms & Rates", async () => {
  mocks.getRoomSetupState.mockResolvedValue({ status: "complete", room: recovery.room });
  const view = await mount();
  expect(JSON.stringify(view.toJSON())).toContain("Rooms and rates are already set up.");
  await submit(view);
  expect(handlers.onCompleted).toHaveBeenCalledTimes(1);
  expect(handlers.onOpenRoomsAndRates).not.toHaveBeenCalled();
  await act(async () => view.unmount());
});
it("keeps the step open when setup progress cannot be refreshed", async () => {
  mocks.getRoomSetupState.mockResolvedValue({ status: "complete", room: null });
  handlers.onCompleted.mockRejectedValueOnce(new Error("offline"));
  const view = await mount();
  await submit(view);
  expect(JSON.stringify(view.toJSON())).toContain(
    "Setup progress could not be refreshed. Try again.",
  );
  expect(submitButton(view).props.disabled).toBe(false);
  await act(async () => view.unmount());
});
it("reloads room readiness after a prepared import saves rooms", async () => {
  const view = await mount(0);
  mocks.getRoomSetupState.mockResolvedValue(recovery);
  await act(async () => view.update(render(1)));
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain("Imported Suite");
  expect(output).not.toContain("Add your room types in Rooms & Rates.");
  expect(mocks.getRoomSetupState).toHaveBeenCalledTimes(2);
  await act(async () => view.unmount());
});
it("ignores an old property's readiness after switching property", async () => {
  const view = await mount(0);
  let finish!: (value: unknown) => void;
  mocks.getRoomSetupState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => view.update(render(1)));
  await act(async () => view.update(render(1, "hotel-b")));
  await act(async () => finish(recovery));
  expect(JSON.stringify(view.toJSON())).not.toContain("Imported Suite");
  expect(submitButton(view).props.disabled).toBe(false);
  await act(async () => view.unmount());
});
