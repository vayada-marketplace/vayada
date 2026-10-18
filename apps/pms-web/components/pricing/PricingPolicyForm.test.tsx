import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { PricingPolicyForm } from "./PricingPolicyForm";
const terms: ReplacementOfferTerms = { roomTypeId: "61000000-0000-4000-8000-000000000001", offerId: "flex", revision: "61000000-0000-4000-8000-000000000002",
  cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount",
    flexibleCancellationType: "partial_refund", partialRefundCancelWindowDays: 3, partialRefundAmountPercent: 50,
    partialRefundTiers: [{ minDaysBeforeCheckIn: 7, refundPercent: 80 }, { minDaysBeforeCheckIn: 2, refundPercent: 20 }], text: "Exact text\nSecond line" } },
  payment: { kind: "deposit", basisPoints: 3025, balanceDaysBeforeArrival: 2, acceptedMethods: ["pay_at_property"] } };
const onApply = vi.fn(), onCancel = vi.fn(); let view: ReactTestRenderer;
const click = async (text: string) => { await act(async () => view.root.findAllByType("button").find((n) => n.children.join("") === text)!.props.onClick()); };
const change = async (label: string, value: string) => { await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })); };
const toggle = async (label: string, checked: boolean) => { await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { checked } })); };
beforeEach(async () => { vi.resetAllMocks(); vi.stubGlobal("React", React); await act(async () => { view = create(<PricingPolicyForm terms={terms} disabled={false} onApply={onApply} onCancel={onCancel} />); }); });
afterEach(() => { act(() => view.unmount()); vi.unstubAllGlobals(); });
it("preserves every optional flexible field, tier, text and exact decimal deposit", async () => {
  // The stored deposit (rest 2 days before arrival, pay at property) predates VAY-2205: applying writes it card-only.
  const cardDeposit = { kind: "deposit", basisPoints: 3025, balanceDaysBeforeArrival: 0, acceptedMethods: ["card"] } as const;
  await click("Apply policy changes"); expect(onApply).toHaveBeenCalledWith({ ...terms, payment: cardDeposit });
  // A deposit the rules take is kept untouched, also when the rate becomes non-refundable.
  act(() => view.unmount());
  await act(async () => { view = create(<PricingPolicyForm terms={{ ...terms, payment: cardDeposit }} disabled={false} onApply={onApply} onCancel={onCancel} />); });
  await change("Cancellation policy", "non_refundable"); await click("Apply policy changes");
  expect(onApply).toHaveBeenLastCalledWith({ ...terms, cancellation: { kind: "non_refundable" }, payment: cardDeposit });
  await change("Deposit (% of final total)", "100"); onApply.mockClear(); await click("Apply policy changes");
  expect(onApply).not.toHaveBeenCalled(); expect(JSON.stringify(view.toJSON())).toContain("A deposit must be less than 100%");
  // A changed deposit is paid by card when booking and the rest at the property (VAY-2205).
  await change("Deposit (% of final total)", "33.33");
  await click("Apply policy changes"); expect(onApply).toHaveBeenLastCalledWith({ ...terms, cancellation: { kind: "non_refundable" }, payment: { ...cardDeposit, basisPoints: 3333 } });
  expect(JSON.stringify(view.toJSON())).toContain("The deposit is paid by card when booking");
});
it("rejects duplicate tiers, missing partial-refund tiers and fractional deposit precision", async () => {
  await change("Tier 2 days", "7"); await click("Apply policy changes"); expect(onApply).not.toHaveBeenCalled();
  await click("Remove tier 2"); await click("Remove tier 1"); await click("Apply policy changes"); expect(onApply).not.toHaveBeenCalled();
  await change("Cancellation policy", "non_refundable"); await change("Deposit (% of final total)", "30.251");
  await click("Apply policy changes"); expect(onApply).not.toHaveBeenCalled(); expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(1);
});
it("switches explicitly to non-refundable/full and cancels without applying", async () => {
  await change("Cancellation policy", "non_refundable"); await change("Requested payment schedule", "full");
  await click("Cancel policy changes"); expect(onCancel).toHaveBeenCalledOnce(); expect(onApply).not.toHaveBeenCalled();
  // Non-refundable stays are paid in advance (VAY-2280): with only pay at property there is nothing to send.
  await click("Apply policy changes"); expect(onApply).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain("Non-refundable stays are paid in advance.");
  // With card ticked, pay at property is left out.
  await toggle("Card online", true);
  await click("Apply policy changes"); expect(onApply).toHaveBeenCalledWith({ ...terms, cancellation: { kind: "non_refundable" }, payment: { kind: "full", acceptedMethods: ["card"] } });
});
it("requires an explicit method and preserves canonical order when both are selected", async () => {
  // Ways to pay are chosen for full payment; a deposit is paid by card (VAY-2205).
  expect(view.root.findAllByProps({ "aria-label": "Card online" })).toHaveLength(0);
  await change("Requested payment schedule", "full");
  await toggle("Card online", true);
  await click("Apply policy changes");
  expect(onApply).toHaveBeenLastCalledWith({ ...terms, payment: { kind: "full", acceptedMethods: ["card", "pay_at_property"] } });
  await toggle("Card online", false); await toggle("Pay at property", false);
  onApply.mockClear(); await click("Apply policy changes");
  expect(onApply).not.toHaveBeenCalled();
  expect(JSON.stringify(view.toJSON())).toContain("Choose at least one accepted payment method");
});
