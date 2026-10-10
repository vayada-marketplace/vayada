import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddOnListPicker } from "@/components/bookings/AddOnListPicker";
// prettier-ignore
import { PmsManualBookingServiceError, type PmsManualBookingPreviewInput, type PmsManualBookingPreviewResult } from "@/services/api/pmsManualBookingClient";
import { calendarService } from "@/services/calendar";
import TargetManualBookingModal from "./TargetManualBookingModal";

// prettier-ignore
const roomTypes = [{ id: "type-1", name: "Double", category: "", totalRooms: 1, baseRate: 100, maxOccupancy: 2, currency: "EUR", seasons: [], ratePlans: [{ id: "plan-1", name: "Flexible", rateType: "flexible" as const, baseRate: 100 }] }, { id: "type-2", name: "Villa", category: "", totalRooms: 1, baseRate: 200, maxOccupancy: 5, currency: "EUR", seasons: [], ratePlans: [{ id: "plan-2", name: "Villa flexible", rateType: "flexible" as const, baseRate: 200 }] }], rooms = [{ id: "room-1", roomTypeId: "type-1", roomTypeName: "Double", roomNumber: "101", floor: "1", status: "available", baseRate: 100, currency: "EUR", maxOccupancy: 2, size: 20 }, { id: "room-2", roomTypeId: "type-2", roomTypeName: "Villa", roomNumber: "V1", floor: "1", status: "available", baseRate: 200, currency: "EUR", maxOccupancy: 5, size: 80 }], preview: PmsManualBookingPreviewResult = { contractVersion: "pms-manual-booking.v1", currency: "EUR", stays: [{ position: 1, roomId: "room-1", ratePlanId: "plan-1", nightly: [{ serviceDate: "2026-09-10", standard: { amountDecimal: "100.00", currency: "EUR" }, applied: { amountDecimal: "100.00", currency: "EUR" } }], standardTotal: { amountDecimal: "100.00", currency: "EUR" }, appliedTotal: { amountDecimal: "100.00", currency: "EUR" } }], addOns: [], grandTotal: { amountDecimal: "100.00", currency: "EUR" } };

// prettier-ignore
function previewFor(input: PmsManualBookingPreviewInput): PmsManualBookingPreviewResult { const stays = input.stays.map((stay) => ({ ...preview.stays[0]!, position: stay.position, roomId: stay.roomId, ratePlanId: stay.ratePlanId })), addOns = input.addOns.map((addon) => ({ ...addon, pricingModel: "per_guest_night" as const, unitPrice: { amountDecimal: "10.00", currency: "EUR" }, total: { amountDecimal: "20.00", currency: "EUR" } })); return { ...preview, stays, addOns, grandTotal: { amountDecimal: String(stays.length * 100 + addOns.length * 20), currency: "EUR" } }; }

// prettier-ignore
function render(canRecordPaidPayment = false) { return renderToStaticMarkup(createElement(TargetManualBookingModal, { roomTypes, rooms, canRecordPaidPayment, onSubmit: vi.fn(), onClose: vi.fn() })); }

async function settlePreview() {
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

describe("target manual booking fields", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([]);
    vi.spyOn(calendarService, "getPropertyCountry").mockResolvedValue("ID");
    vi.spyOn(calendarService, "getManualBookingCapabilities").mockResolvedValue({
      contractVersion: "pms-manual-booking.v1",
      canRecordPaidPayment: false,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("offers only canonical direct sources and fixes the booking channel", () => {
    const markup = render();
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="New booking"/);
    expect(markup).toMatch(/<input disabled=""[^>]*value="Direct"/);
    for (const source of ["Call", "Email", "WhatsApp", "Walk-in", "Social media", "Other"])
      expect(markup).toContain(` ${source} </option>`);
    for (const forbidden of ["Airbnb", "Booking.com", "Expedia", "Booking Engine"])
      expect(markup).not.toContain(forbidden);
  });

  it("separates notes, validates E.164, and fails Paid closed", () => {
    const markup = render();
    expect(markup).toContain('name="specialRequests"');
    expect(markup).toContain('name="privateNote"');
    expect(markup).toContain('aria-label="Phone country code"');
    expect(markup).toContain('name="phone" type="tel"');
    expect(markup).toMatch(/disabled=""[^>]*value="paid"/);
    // prettier-ignore
    expect(markup).toMatch(/aria-describedby="paid-help"[^>]*>[\s\S]*Paid requires Finance write access/);
    expect(render(true)).not.toMatch(/disabled="" value="paid"/);
  });

  // prettier-ignore
  it("enables Paid from the selected property's protected capability", async () => { const capability = vi.spyOn(calendarService, "getManualBookingCapabilities").mockResolvedValue({ contractVersion: "pms-manual-booking.v1", canRecordPaidPayment: true }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose: vi.fn() })); }); expect(view.root.findByProps({ value: "paid" }).props.disabled).toBe(false); capability.mockRestore(); });

  // prettier-ignore
  it("contains dialog focus and closes on Escape", async () => { const onClose = vi.fn(), first = { focus: vi.fn() }, last = { focus: vi.fn() }, panel = { focus: vi.fn(), querySelectorAll: () => [first, last] }, documentMock = { activeElement: last as unknown }; vi.stubGlobal("document", documentMock); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose }), { createNodeMock: (element) => element.props.role === "dialog" ? panel : null }); }); expect(panel.focus).toHaveBeenCalled(); const preventDefault = vi.fn(), dialog = view.root.findByProps({ role: "dialog" }); documentMock.activeElement = panel; act(() => dialog.props.onKeyDown({ key: "Tab", shiftKey: true, preventDefault })); expect(last.focus).toHaveBeenCalled(); documentMock.activeElement = last; act(() => dialog.props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault })); expect(first.focus).toHaveBeenCalled(); act(() => dialog.props.onKeyDown({ key: "Escape" })); expect(onClose).toHaveBeenCalled(); act(() => view.unmount()); expect(last.focus).toHaveBeenCalled(); vi.unstubAllGlobals(); });

  it("explains invalid combined occupancy", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() })); });
    const numberInputs = () =>
      view.root.findAllByType("input").filter((input) => input.props.type === "number");
    act(() => numberInputs()[0]!.props.onChange({ target: { value: "2" } }));
    act(() => numberInputs()[1]!.props.onChange({ target: { value: "1" } }));
    expect(view.root.findByProps({ id: "stay-occupancy-1" }).children.join("")).toContain(
      "at most 2 guests",
    );
    // prettier-ignore
    expect(numberInputs().slice(0, 2).every((input) => input.props["aria-invalid"])).toBe(true);
  });

  // prettier-ignore
  it("submits independently priced heterogeneous stays in stable order", async () => { vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000001", name: "Breakfast", description: "", price: 10, currency: "EUR", category: "meal", perPerson: true, perNight: true }]); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => previewFor(input)); const onSubmit = vi.fn().mockResolvedValue({}); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); }); const button = (label: string) => view.root.findAllByType("button").find((item) => item.children.join("") === label)!, input = (label: string) => view.root.findByProps({ "aria-label": label }); await act(async () => button("+ Add another room").props.onClick()); await act(async () => input("Room 2 check-in").props.onChange({ target: { value: "2026-09-12" } })); await act(async () => input("Room 2 check-out").props.onChange({ target: { value: "2026-09-15" } })); await act(async () => input("Room 2 adults").props.onChange({ target: { value: "3" } })); await act(async () => view.root.findAllByType("input").find((item) => item.props.type === "checkbox")!.props.onChange({ target: { checked: true } })); await settlePreview(); await act(async () => { await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); }); expect(onSubmit.mock.calls[0]![0].stays).toMatchObject([{ position: 1, roomId: "room-1", checkIn: "2026-09-10", adults: 1, ratePlanId: "plan-1" }, { position: 2, roomId: "room-2", checkIn: "2026-09-12", checkOut: "2026-09-15", adults: 3, ratePlanId: "plan-2", pricing: { kind: "rate_plan", manualOverride: null } }]); expect(view.root.findAllByProps({ "aria-label": "Room 2 nightly rate" })).toHaveLength(0); expect(onSubmit.mock.calls[0]![0].addOns).toEqual([{ addonId: "00000000-0000-4000-8000-000000000001", packageCount: 1, serviceUnits: [{ serviceDate: "2026-09-10", guestCount: 1 }, { serviceDate: "2026-09-12", guestCount: 3 }, { serviceDate: "2026-09-13", guestCount: 3 }, { serviceDate: "2026-09-14", guestCount: 3 }] }]); expect(JSON.stringify(view.toJSON())).toContain("€20"); });

  it("blocks overlapping reuse, then removes and renumbers stays", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) =>
      previewFor(input),
    );
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-12", onSubmit: vi.fn(), onClose: vi.fn() })); });
    const add = () =>
      view.root
        .findAllByType("button")
        .find((item) => item.children.join("") === "+ Add another room")!;
    expect(
      view.root
        .findAllByType("button")
        .some((item) => item.props["aria-label"]?.startsWith("Remove room")),
    ).toBe(false);
    await act(async () => add().props.onClick());
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 2 room" })
        .props.onChange({ target: { value: "room-1" } }),
    );
    expect(
      view.root
        .findAllByProps({ role: "alert" })
        .some((item) => item.children.join("").includes("overlaps another stay")),
    ).toBe(true);
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(2);
    act(() => view.root.findByProps({ "aria-label": "Remove room 1" }).props.onClick());
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(1);
    expect(view.root.findByProps({ "aria-label": "Room 1 room" }).props.value).toBe("room-1");
    for (let count = 1; count < 20; count += 1) act(() => add().props.onClick());
    expect(view.root.findAllByProps({ "data-stay": true })).toHaveLength(20);
    expect(add().props.disabled).toBe(true);
  });

  // prettier-ignore
  it("places and focuses a server stay error inside its room card", async () => { const focus = vi.fn(), error = new PmsManualBookingServiceError("conflict", "room_unavailable", 409, "Room is no longer available.", "roomId", 2); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (input.stays.length > 1) throw error; return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() }), { createNodeMock: (element) => element.props["aria-label"]?.endsWith(" room") ? { focus } : element.props.role === "dialog" ? { focus: vi.fn(), querySelectorAll: () => [] } : null }); }); await act(async () => view.root.findAllByType("button").find((item) => item.children.join("") === "+ Add another room")!.props.onClick()); await settlePreview(); expect(view.root.findByProps({ "aria-label": "Room 2 room" }).props["aria-invalid"]).toBe(true); expect(view.root.findAllByProps({ "data-stay": true })[1]!.findByProps({ role: "alert" }).children.join("")).toContain("no longer available"); expect(focus).toHaveBeenCalledTimes(2); });

  // prettier-ignore
  it("places and focuses a positioned server date error on check-in", async () => { const focus = vi.fn(), error = new PmsManualBookingServiceError("validation", "invalid_dates", 422, "Stay dates are invalid.", "stays", 2); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (input.stays.length > 1) throw error; return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() }), { createNodeMock: (element) => element.props["aria-label"]?.endsWith(" check-in") ? { focus } : element.props.role === "dialog" ? { focus: vi.fn(), querySelectorAll: () => [] } : null }); }); await act(async () => view.root.findAllByType("button").find((item) => item.children.join("") === "+ Add another room")!.props.onClick()); await settlePreview(); const checkIn = view.root.findByProps({ "aria-label": "Room 2 check-in" }); expect(checkIn.props["aria-invalid"]).toBe(true); expect(checkIn.props["aria-describedby"]).toBe("stay-server-2"); expect(focus).toHaveBeenCalledOnce(); });

  it("coalesces rapid room, date, rate, and add-on edits into one preview", async () => {
    vi.spyOn(calendarService, "listAvailableAddons").mockResolvedValue([
      {
        id: "addon-1",
        name: "Breakfast",
        description: "",
        price: 10,
        currency: "EUR",
        category: "meal",
        perPerson: true,
        perNight: true,
      },
    ]);
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => previewFor(input));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          canRecordPaidPayment: false,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    const input = (label: string) => view.root.findByProps({ "aria-label": label });
    act(() => input("Room 1 room").props.onChange({ target: { value: "room-2" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 check-in").props.onChange({ target: { value: "2026-09-12" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 check-out").props.onChange({ target: { value: "2026-09-15" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => input("Room 1 adults").props.onChange({ target: { value: "2" } }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() =>
      view.root
        .findAllByType("input")
        .find((item) => item.props.type === "checkbox")!
        .props.onChange({ target: { checked: true } }),
    );

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      stays: [
        expect.objectContaining({
          roomId: "room-2",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          adults: 2,
          ratePlanId: "plan-2",
          // Offers take the published price; only a custom rate sets the nightly amount.
          pricing: { kind: "rate_plan", manualOverride: null },
        }),
      ],
      addOns: [expect.objectContaining({ addonId: "addon-1", packageCount: 1 })],
    });
  });

  it("keeps the latest evidence when an older preview resolves last", async () => {
    const pending: Array<{
      input: PmsManualBookingPreviewInput;
      resolve: (result: PmsManualBookingPreviewResult) => void;
    }> = [];
    vi.spyOn(calendarService, "previewManualBooking").mockImplementation(
      (input) => new Promise((resolve) => pending.push({ input, resolve })),
    );
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          canRecordPaidPayment: false,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 1 adults" })
        .props.onChange({ target: { value: "2" } }),
    );
    await settlePreview();
    expect(pending).toHaveLength(2);

    await act(async () =>
      pending[1]!.resolve({
        ...previewFor(pending[1]!.input),
        grandTotal: { amountDecimal: "150.00", currency: "EUR" },
      }),
    );
    expect(JSON.stringify(view.toJSON())).toContain("Total €150");
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(false);

    await act(async () => pending[0]!.resolve(previewFor(pending[0]!.input)));
    expect(JSON.stringify(view.toJSON())).toContain("Total €150");
    expect(JSON.stringify(view.toJSON())).not.toContain("Total €100");
  });

  it("shows a spinner only when pricing takes longer than one second", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockReturnValue(new Promise(() => undefined));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(view.root.findAllByProps({ "data-pricing-spinner": true })).toHaveLength(0);
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.root.findAllByProps({ "data-pricing-spinner": true })).toHaveLength(1);
    expect(JSON.stringify(view.toJSON())).toContain("Calculating total");
    act(() => view.unmount());
  });

  it("offers retry with the pricing failure guidance", async () => {
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockRejectedValue(new Error("Preview is unavailable."));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(JSON.stringify(view.toJSON())).toContain(
      "Couldn't calculate pricing. Check that this room type has rates set up for the selected dates, then try again.",
    );
    const retry = view.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Retry pricing")!;
    await act(async () => retry.props.onClick());
    await settlePreview();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("explains a missing rate for the selected dates and keeps creation blocked", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockRejectedValue(
      new PmsManualBookingServiceError(
        "not_found",
        "rate_plan_not_found",
        404,
        "rate plan not found.",
        "ratePlanId",
        1,
      ),
    );
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes,
          rooms,
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(JSON.stringify(view.toJSON())).toContain(
      "No rate found for 2026-09-10 – 2026-09-11. Set the price in Pricing first.",
    );
    expect(
      view.root
        .findAllByType("button")
        .some((button) => button.children.join("") === "Retry pricing"),
    ).toBe(false);
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
  });

  it("falls back to Custom rate when the room type has no rate plan", async () => {
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => previewFor(input));
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes: [{ ...roomTypes[0]!, ratePlans: [] }],
          rooms: [rooms[0]!],
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settlePreview();

    expect(request).not.toHaveBeenCalled();
    const ratePlan = view.root.findByProps({ "aria-label": "Room 1 rate plan" });
    expect(ratePlan.props.value).toBe("custom");
    expect(ratePlan.props["aria-describedby"]).toBe("stay-no-plan-1");
    const markup = JSON.stringify(view.toJSON());
    expect(markup).toContain("No rate plan is published for this room type.");
    expect(markup).toContain("Enter a custom nightly rate to calculate the total");
    expect(markup).not.toContain("No rate available");
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);

    await act(async () =>
      view.root
        .findByProps({ "aria-label": "Room 1 nightly rate" })
        .props.onChange({ target: { value: "150" } }),
    );
    await settlePreview();
    expect(request.mock.calls[0]![0].stays[0]).toMatchObject({
      ratePlanId: null,
      pricing: { kind: "custom", nightlyAmount: { amountDecimal: "150.00", currency: "EUR" } },
    });
    const summary = JSON.stringify(view.toJSON());
    expect(summary).toContain("Custom:");
    expect(summary).not.toContain("Standard:");
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(false);
  });

  // VAY-2065: a setup-created room type has no currency until prices are published; the custom
  // rate is sent without one and the server answers in the property currency.
  it("sends a custom rate without a currency when the room type has none", async () => {
    const chf = (amountDecimal: string) => ({ amountDecimal, currency: "CHF" });
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => ({
        ...previewFor(input),
        currency: "CHF",
        pricingRevision: null,
        stays: [
          {
            ...preview.stays[0]!,
            ratePlanId: null,
            nightly: [{ serviceDate: "2026-09-10", standard: null, applied: chf("150.00") }],
            standardTotal: null,
            appliedTotal: chf("150.00"),
          },
        ],
        grandTotal: chf("150.00"),
      }));
    const onSubmit = vi.fn().mockResolvedValue({});
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes: [{ ...roomTypes[0]!, ratePlans: [], currency: null }],
          rooms: [rooms[0]!],
          initialCheckIn: "2026-09-10",
          initialCheckOut: "2026-09-11",
          onSubmit,
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () =>
      view.root
        .findByProps({ "aria-label": "Room 1 nightly rate" })
        .props.onChange({ target: { value: "150" } }),
    );
    await settlePreview();

    expect(request.mock.calls[0]![0].stays[0]!.pricing).toEqual({
      kind: "custom",
      nightlyAmount: { amountDecimal: "150.00" },
    });
    expect(JSON.stringify(view.toJSON())).toContain("Total CHF150");
    await act(async () => {
      await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onSubmit.mock.calls[0]![0].stays[0].pricing.nightlyAmount).toEqual({
      amountDecimal: "150.00",
    });
  });

  it("shows cents from the server amount instead of rounding a custom rate", async () => {
    const cents = { amountDecimal: "150.50", currency: "EUR" };
    // prettier-ignore
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue({ ...preview, stays: [{ ...preview.stays[0]!, ratePlanId: null, nightly: [{ serviceDate: "2026-09-10", standard: null, applied: cents }], standardTotal: null, appliedTotal: cents }], grandTotal: cents });
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes: [{ ...roomTypes[0]!, ratePlans: [] }], rooms: [rooms[0]!], initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() })); });
    // prettier-ignore
    await act(async () => view.root.findByProps({ "aria-label": "Room 1 nightly rate" }).props.onChange({ target: { value: "150.50" } }));
    await settlePreview();
    const markup = JSON.stringify(view.toJSON());
    expect(markup).toContain("Total €150.50");
    expect(markup).toContain("€150.50");
    expect(markup).not.toContain("€151");
  });

  it("defaults to Flexible before Non-refundable regardless of server order", async () => {
    // prettier-ignore
    const plans = [{ id: "plan-nr", name: "Non-refundable", rateType: "non_refundable" as const, baseRate: 90 }, { id: "plan-flex", name: "Flexible", rateType: "flexible" as const, baseRate: 100 }];
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes: [
            { ...roomTypes[0]!, ratePlans: plans },
            { ...roomTypes[1]!, ratePlans: [plans[0]!] },
          ],
          rooms,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    const ratePlan = () => view.root.findByProps({ "aria-label": "Room 1 rate plan" });
    expect(ratePlan().props.value).toBe("plan-flex");
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 1 room" })
        .props.onChange({ target: { value: "room-2" } }),
    );
    expect(ratePlan().props.value).toBe("plan-nr");
  });

  it("prefers any configured plan over Custom when only a package plan exists", async () => {
    // prettier-ignore
    const packagePlan = { id: "plan-pkg", name: "Half board", rateType: "package" as const, baseRate: 150 };
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        createElement(TargetManualBookingModal, {
          roomTypes: [{ ...roomTypes[0]!, ratePlans: [packagePlan] }],
          rooms: [rooms[0]!],
          onSubmit: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    const ratePlan = view.root.findByProps({ "aria-label": "Room 1 rate plan" });
    expect(ratePlan.props.value).toBe("plan-pkg");
    expect(ratePlan.props["aria-describedby"]).toBeUndefined();
  });

  it("keeps the host's dial code if the property country arrives later, and tolerates a failed lookup", async () => {
    let resolveCountry!: (code: string) => void;
    vi.spyOn(calendarService, "getPropertyCountry").mockReturnValueOnce(
      new Promise((resolve) => (resolveCountry = resolve)),
    );
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose: vi.fn() })); });
    const dialCode = () => view.root.findByProps({ "aria-label": "Phone country code" });
    act(() => dialCode().props.onChange({ target: { value: "GB" } }));
    await act(async () => resolveCountry("ID"));
    expect(dialCode().props.value).toBe("GB");
    act(() => view.unmount());

    vi.spyOn(calendarService, "getPropertyCountry").mockRejectedValueOnce(new Error("forbidden"));
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, onSubmit: vi.fn(), onClose: vi.fn() })); });
    expect(dialCode().props.value).toBe("");
  });

  it("adds booking-level guests, warns over capacity, and submits them in order", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    const onSubmit = vi.fn().mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    const button = (label: string) =>
      view.root.findAllByType("button").find((item) => item.children.join("") === label)!;
    const field = (label: string) => view.root.findByProps({ "aria-label": label });
    const type = (label: string, value: string) =>
      act(() => field(label).props.onChange({ target: { value } }));
    const submit = () =>
      act(async () => {
        await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      });

    act(() => button("+ Add guest").props.onClick());
    act(() => button("+ Add guest").props.onClick());
    expect(view.root.findAllByProps({ "data-additional-guest": true })).toHaveLength(2);
    // Booker plus two guests is more than the Double room's two places: warn, don't block.
    const markup = JSON.stringify(view.toJSON());
    expect(markup).toContain("3 guests is more than the 2");
    // The stays still say one guest, so pricing and Booking Detail would disagree: hint, don't block.
    expect(markup).toContain("3 people are listed, but the stays have 1 guests");

    type("Guest 1 first name", "Grace");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("Check guest 1");
    expect(view.root.findAllByProps({ "data-additional-guest": true })[0]!.props.open).toBe(true);

    type("Guest 1 last name", "Hopper");
    type("Guest 2 first name", "Alan");
    type("Guest 2 last name", "Turing");
    type("Guest 2 email", "alan@example.com");
    const guestPhone = view.root
      .findAllByProps({ "data-additional-guest": true })[1]!
      .findByProps({ name: "phone" });
    act(() => guestPhone.props.onChange({ target: { value: "+44 7911 123456" } }));
    await submit();
    expect(onSubmit.mock.calls[0]![0].additionalGuests).toEqual([
      { firstName: "Grace", lastName: "Hopper", email: null, phoneE164: null, countryCode: null },
      {
        firstName: "Alan",
        lastName: "Turing",
        email: "alan@example.com",
        phoneE164: "+447911123456",
        countryCode: null,
      },
    ]);
  });

  it("omits additional guests from the request when none are added, and removes cards", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    const onSubmit = vi.fn().mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    const button = (label: string) =>
      view.root.findAllByType("button").find((item) => item.children.join("") === label)!;
    act(() => button("+ Add guest").props.onClick());
    act(() => button("Remove guest 1").props.onClick());
    expect(view.root.findAllByProps({ "data-additional-guest": true })).toHaveLength(0);
    await act(async () => {
      await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("additionalGuests");
  });

  it("uses the tightest night for capacity and focuses the guest that needs fixing", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) =>
      previewFor(input),
    );
    const focus = vi.fn();
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() }), { createNodeMock: (element) => element.props["aria-label"] === "Guest 1 first name" ? { focus } : element.props.role === "dialog" ? { focus: vi.fn(), querySelectorAll: () => [] } : null }); });
    const button = (label: string) =>
      view.root.findAllByType("button").find((item) => item.children.join("") === label)!;
    // Room 1 (2 places) for one night, then the Villa (5 places) the next night: capacity is 2, not 7.
    await act(async () => button("+ Add another room").props.onClick());
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 2 check-in" })
        .props.onChange({ target: { value: "2026-09-11" } }),
    );
    act(() =>
      view.root
        .findByProps({ "aria-label": "Room 2 check-out" })
        .props.onChange({ target: { value: "2026-09-12" } }),
    );
    act(() => button("+ Add guest").props.onClick());
    act(() => button("+ Add guest").props.onClick());
    await settlePreview();
    expect(JSON.stringify(view.toJSON())).toContain("3 guests is more than the 2");
    await act(async () => {
      await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(focus).toHaveBeenCalled();
  });

  it("defaults the dial code to the property country and submits E.164", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview);
    const onSubmit = vi.fn().mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    const dialCode = view.root.findByProps({ "aria-label": "Phone country code" });
    expect(dialCode.props.value).toBe("ID");
    const phone = () => view.root.findByProps({ name: "phone" });
    const submit = () =>
      act(async () => {
        await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      });

    act(() => phone().props.onChange({ target: { value: "12" } }));
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Enter a valid phone number",
    );

    act(() => phone().props.onChange({ target: { value: "0812 3456 7890" } }));
    await submit();
    expect(onSubmit.mock.calls[0]![0].guest.phoneE164).toBe("+6281234567890");
  });

  // prettier-ignore
  it("submits the searchable nationality as an ISO code", async () => { vi.spyOn(calendarService, "previewManualBooking").mockResolvedValue(preview); const onSubmit = vi.fn().mockResolvedValue({}); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); }); await settlePreview(); const nationality = view.root.findAllByType("input").find((input) => input.props.list)!; expect(nationality.props.placeholder).toBe("Search country"); expect(view.root.findByType("datalist").findAllByType("option").some((option) => option.props.value === "Germany" && option.props.label === "🇩🇪 DE")).toBe(true); expect(view.root.findAllByType("input").some((input) => input.props.name === "countryCode")).toBe(false); act(() => nationality.props.onChange({ target: { value: "Germany" } })); await act(async () => { await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); }); expect(onSubmit.mock.calls[0]![0].guest.countryCode).toBe("DE"); });

  // prettier-ignore
  it("cannot create from stale evidence after the current preview fails", async () => { let fail = false; const onSubmit = vi.fn(); vi.spyOn(calendarService, "previewManualBooking").mockImplementation(async (input) => { if (fail) throw new Error("Preview failed."); return previewFor(input); }); let view!: ReactTestRenderer; await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); }); await settlePreview(); const adults = view.root.findByProps({ "aria-label": "Room 1 adults" }); fail = true; act(() => adults.props.onChange({ target: { value: "3" } })); await act(async () => view.root.findByProps({ "aria-label": "Room 1 adults" }).props.onChange({ target: { value: "1" } })); await settlePreview(); expect(JSON.stringify(view.toJSON())).toContain("Couldn't calculate pricing."); expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true); await act(async () => view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() })); expect(onSubmit).not.toHaveBeenCalled(); });

  it("locks an ambiguous create and retries the identical request", async () => {
    let resolveAddons!: (addons: []) => void;
    vi.spyOn(calendarService, "listAvailableAddons").mockReturnValue(
      new Promise((resolve) => (resolveAddons = resolve)),
    );
    vi.spyOn(calendarService, "previewManualBooking")
      .mockResolvedValueOnce(preview)
      .mockRejectedValue(new Error("Room changed."));
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => (reject = fail));
    const onSubmit = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({});
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    let submission!: Promise<void>;
    // prettier-ignore
    act(() => { submission = view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(view.root.findByType("fieldset").props.disabled).toBe(true);
    // prettier-ignore
    await act(async () => resolveAddons([]));
    await act(async () => {
      reject(new Error("Network lost."));
      await submission;
    });
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain("safely resend");
    // prettier-ignore
    await act(async () => { await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]![0]).toEqual(onSubmit.mock.calls[0]![0]);
  });

  it("uses the primary action token for the add-on Done button", () => {
    const markup = renderToStaticMarkup(
      createElement(AddOnListPicker, {
        // prettier-ignore
        addons: [{ id: "addon", name: "Breakfast", description: "", price: 10, currency: "EUR", category: "meal" }],
        selectedIds: [],
        quantities: {},
        currency: "EUR",
        nights: 1,
        adults: 1,
        onChange: vi.fn(),
        onDone: vi.fn(),
      }),
    );
    expect(markup).toMatch(/<button[^>]*bg-primary-600[^>]*>Done<\/button>/);
  });
  it("asks for child ages before pricing an offer and sends them with the stay", async () => {
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => previewFor(input));
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() })); });
    await settlePreview();
    request.mockClear();
    const input = (label: string) => view.root.findByProps({ "aria-label": label });
    await act(async () => input("Room 1 children").props.onChange({ target: { value: "1" } }));
    await settlePreview();
    expect(request).not.toHaveBeenCalled();
    await act(async () => input("Room 1 child 1 age").props.onChange({ target: { value: "18" } }));
    await settlePreview();
    expect(request).not.toHaveBeenCalled();
    expect(input("Room 1 child 1 age").props["aria-invalid"]).toBe(true);
    await act(async () => input("Room 1 child 1 age").props.onChange({ target: { value: "5" } }));
    await settlePreview();
    expect(request.mock.calls[0]![0].stays[0]).toMatchObject({
      children: 1,
      childAgesAtCheckIn: [5],
      ratePlanId: "plan-1",
      pricing: { kind: "rate_plan", manualOverride: null },
    });
  });

  it("points to Pricing when the property has not published prices", async () => {
    vi.spyOn(calendarService, "previewManualBooking").mockRejectedValue(
      new PmsManualBookingServiceError(
        "conflict",
        "pricing_not_published",
        409,
        "pricing not published.",
      ),
    );
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit: vi.fn(), onClose: vi.fn() })); });
    await settlePreview();
    expect(JSON.stringify(view.toJSON())).toContain(
      "Prices are not published yet. Publish them in Pricing, or choose a custom rate.",
    );
    expect(view.root.findByProps({ form: "target-manual-booking" }).props.disabled).toBe(true);
  });
  it("sends the preview's price version and re-prices when prices changed before saving", async () => {
    const request = vi
      .spyOn(calendarService, "previewManualBooking")
      .mockImplementation(async (input) => ({ ...previewFor(input), pricingRevision: 4 }));
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new PmsManualBookingServiceError("conflict", "pricing_changed", 409, "pricing changed."),
      );
    let view!: ReactTestRenderer;
    // prettier-ignore
    await act(async () => { view = create(createElement(TargetManualBookingModal, { roomTypes, rooms, initialCheckIn: "2026-09-10", initialCheckOut: "2026-09-11", onSubmit, onClose: vi.fn() })); });
    await settlePreview();
    const previews = request.mock.calls.length;
    await act(async () => {
      await view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ expectedPricingRevision: 4 });
    expect(JSON.stringify(view.toJSON())).toContain(
      "Prices changed since this total was calculated.",
    );
    await settlePreview();
    expect(request.mock.calls.length).toBeGreaterThan(previews);
    // The notice outlives the successful re-price, so staff know why the total changed.
    expect(JSON.stringify(view.toJSON())).toContain(
      "Prices changed since this total was calculated.",
    );
  });
});
