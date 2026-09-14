import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getRoomSetupState: vi.fn(),
  getPropertyLaunchSettings: vi.fn(),
  saveRoomSetup: vi.fn(),
  addRoomSetup: vi.fn(),
}));
vi.mock("@/services/api/hotelOperationsSetupClient", () => ({
  hotelOperationsSetupApi: mocks,
  hotelOperationsErrorMessage: (_: unknown, fallback: string) => fallback,
  hotelOperationsWriteMayHaveCommitted: () => false,
  isPropertyCurrencyConflict: () => false,
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRoomSetupState.mockResolvedValue({ status: "empty" });
  mocks.getPropertyLaunchSettings.mockResolvedValue({ defaultCurrency: "EUR" });
});
function render(revision: number, propertyId = "hotel-a") {
  return createElement(
    RoomImportRevisionContext.Provider,
    { value: revision },
    createElement(RoomsRatesAvailabilityForm, {
      propertyId,
      taskComplete: false,
      onBack: null,
      onBeforeSave: vi.fn(),
      onCompleted: vi.fn(),
    }),
  );
}
it("refreshes imports and retains an unfinished entry without saving or duplicating it", async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(render(0));
  });
  await act(async () => {
    view.root
      .findByProps({ maxLength: 120 })
      .props.onChange({ target: { value: "My unsaved room" } });
  });
  mocks.getRoomSetupState.mockResolvedValue(recovery);
  await act(async () => view.update(render(1)));
  const output = JSON.stringify(view.toJSON());
  expect(output).toContain("Imported Suite");
  expect(output).toContain("My unsaved room");
  expect(output).toContain("Your unsaved entry");
  expect(output).toContain("Add at least one active physical room.");
  expect(output).not.toContain("Rooms and rates are already set up.");
  expect(mocks.saveRoomSetup).not.toHaveBeenCalled();
  expect(mocks.addRoomSetup).not.toHaveBeenCalled();
  expect(mocks.getPropertyLaunchSettings).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});
it("keeps failed-refresh input editable, blocks save, and recovers on the next import refresh", async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(render(0));
  });
  await act(async () =>
    view.root.findByProps({ maxLength: 120 }).props.onChange({ target: { value: "Keep this" } }),
  );
  mocks.getRoomSetupState.mockRejectedValueOnce(new Error("offline"));
  await act(async () => view.update(render(1)));
  expect(view.root.findByProps({ maxLength: 120 }).props.value).toBe("Keep this");
  expect(view.root.findByProps({ type: "submit" }).props.disabled).toBe(true);
  await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.saveRoomSetup).not.toHaveBeenCalled();
  mocks.getRoomSetupState.mockResolvedValue(recovery);
  await act(async () => view.update(render(2)));
  expect(JSON.stringify(view.toJSON())).toContain("Keep this");
  expect(view.root.findByProps({ type: "submit" }).props.disabled).toBe(false);
  await act(async () => view.unmount());
});
it("ignores an old property's refresh after switching property", async () => {
  let view!: ReactTestRenderer;
  let finish!: (value: unknown) => void;
  await act(async () => {
    view = create(render(0));
  });
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
  expect(view.root.findByProps({ type: "submit" }).props.disabled).toBe(false);
  await act(async () => view.unmount());
});
