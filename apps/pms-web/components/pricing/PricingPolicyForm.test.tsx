import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { PricingPolicyForm } from "./PricingPolicyForm";
const terms: ReplacementOfferTerms = { roomTypeId: "61000000-0000-4000-8000-000000000001", offerId: "flex", revision: "61000000-0000-4000-8000-000000000002",
  cancellation: { kind: "flexible", terms: { type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount",
    flexibleCancellationType: "partial_refund", partialRefundCancelWindowDays: 3, partialRefundAmountPercent: 50,
    partialRefundTiers: [{ minDaysBeforeCheckIn: 7, refundPercent: 80 }, { minDaysBeforeCheckIn: 2, refundPercent: 20 }], text: "Exact text\nSecond line" } },
  payment: { kind: "deposit", basisPoints: 3025, balanceDaysBeforeArrival: 2 } };
const onApply = vi.fn(), onCancel = vi.fn(); let view: ReactTestRenderer;
const click = async (text: string) => { await act(async () => view.root.findAllByType("button").find((n) => n.children.join("") === text)!.props.onClick()); };
const change = async (label: string, value: string) => { await act(async () => view.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } })); };
beforeEach(async () => { vi.resetAllMocks(); vi.stubGlobal("React", React); await act(async () => { view = create(<PricingPolicyForm terms={terms} disabled={false} onApply={onApply} onCancel={onCancel} />); }); });
afterEach(() => { act(() => view.unmount()); vi.unstubAllGlobals(); });
it("preserves every optional flexible field, tier, text and exact decimal deposit", async () => {
  await click("Apply policy changes"); expect(onApply).toHaveBeenCalledWith(terms);
  await change("Deposit (% of final total)", "33.33"); await change("Balance due (days before arrival)", "0");
  await click("Apply policy changes"); expect(onApply).toHaveBeenLastCalledWith({ ...terms, payment: { kind: "deposit", basisPoints: 3333, balanceDaysBeforeArrival: 0 } });
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
  await click("Apply policy changes"); expect(onApply).toHaveBeenCalledWith({ ...terms, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } });
});
