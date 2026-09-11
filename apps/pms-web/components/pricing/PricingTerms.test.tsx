import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PricingTerms } from "./PricingTerms";
import { ApiErrorResponse } from "@/services/api/client";
import type { createReplacementPricingClient } from "@/services/api/replacementPricingClient";
const readTerms = vi.fn(), client = { readTerms } as unknown as ReturnType<typeof createReplacementPricingClient>;
const props = { propertyId: "property", client, roomTypeId: "room", offerId: "offer", revision: "revision" };
const full = { ...props, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } };
let view: ReactTestRenderer;
const text = () => JSON.stringify(view.toJSON());
const click = async () => { await act(async () => view.root.findByType("button").props.onClick()); };
beforeEach(async () => { vi.resetAllMocks(); vi.stubGlobal("React", React); await act(async () => { view = create(<PricingTerms {...props} />); }); });
afterEach(() => { act(() => view.unmount()); vi.unstubAllGlobals(); });
it("loads only on request and shows the saved cancellation and deposit settings", async () => {
  expect(readTerms).not.toHaveBeenCalled(); readTerms.mockResolvedValue({ ...full, cancellation: { kind: "flexible", terms: {
    freeCancellationDeadlineDays: 7, flexibleCancellationType: "partial_refund", partialRefundCancelWindowDays: 3, partialRefundAmountPercent: 50,
    partialRefundTiers: [{ minDaysBeforeCheckIn: 7, refundPercent: 80 }, { minDaysBeforeCheckIn: 2, refundPercent: 20 }], text: "<b>Saved text</b>" } },
    payment: { kind: "deposit", basisPoints: 3025, balanceDaysBeforeArrival: 2 } });
  await click(); expect(readTerms).toHaveBeenCalledWith("room", "offer", "revision");
  for (const value of ["Partial-refund", "80", "20", "50", "30.25", "Balance due", "not enabled", "<b>Saved text</b>"]) expect(text()).toContain(value);
  expect(view.root.findAllByType("b")).toHaveLength(0);
});
it("shows missing, denied, stale and unverified responses and permits read retries", async () => {
  readTerms.mockResolvedValueOnce(null); await click(); expect(text()).toContain("No saved terms");
  for (const [status, expected] of [[403, "do not have access"], [409, "terms changed"], [503, "could not be verified"]] as const) {
    readTerms.mockRejectedValueOnce(new ApiErrorResponse(status, {})); await click(); expect(text()).toContain(expected);
  }
  readTerms.mockResolvedValueOnce(full); await click(); expect(text()).toContain("Non-refundable"); expect(text()).toContain("Payment in full");
});
it("ignores a late response after switching the room, offer or revision", async () => {
  let finish!: (value: unknown) => void; readTerms.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await click(); expect(text()).toContain("Loading saved terms");
  await act(async () => view.update(<PricingTerms {...props} revision="new-revision" />));
  await act(async () => finish(full)); expect(text()).not.toContain("Non-refundable"); expect(text()).toContain("Show cancellation");
  readTerms.mockResolvedValue(full); await click(); expect(readTerms).toHaveBeenLastCalledWith("room", "offer", "new-revision");
  await act(async () => view.update(<PricingTerms {...props} roomTypeId="other-room" offerId="other-offer" />));
  expect(text()).not.toContain("Payment in full");
  await act(async () => view.update(<PricingTerms {...props} propertyId="other-property" />));
  expect(text()).toContain("Show cancellation");
});
