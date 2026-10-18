import type { FinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import { describe, expect, it, vi } from "vitest";

import { createPricingCardReadinessReader } from "./pricingCardReadiness.js";

const organizationId = "11111111-1111-4111-8111-111111111111",
  propertyId = "22222222-2222-4222-8222-222222222222";
const card = (readiness: "ready" | "unready", blockers: string[] = [], selected = true) => ({
  method: "card",
  selected,
  availability: "available",
  readiness,
  consequence: readiness === "ready" ? "ready" : "blocking",
  blockers,
  nextActions: [],
});
const snapshot = (method: ReturnType<typeof card> | null, paymentsEnabled = true) =>
  ({
    paymentsEnabled,
    methods: method ? [method] : [],
  }) as unknown as FinancePaymentReadinessSnapshot;

function reader(
  finance: FinancePaymentReadinessSnapshot | null,
  local: { mode?: string | null; linked?: boolean } = {},
  cardAcceptanceEnabled = true,
) {
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ mode: local.mode ?? null, linked: local.linked ?? true }] });
  const getPaymentReadiness = vi.fn().mockResolvedValue(finance);
  const read = createPricingCardReadinessReader({
    pool: { query },
    finance: { getPaymentReadiness },
    cardAcceptanceEnabled,
  }).read({ organizationId, propertyId });
  return { read, query, getPaymentReadiness };
}

describe("pricing card readiness", () => {
  it("is ready only when Finance's card readiness is ready and card acceptance is on", async () => {
    const r = reader(snapshot(card("ready")));
    expect(await r.read).toEqual({
      card: { ready: true, reason: null, charge: "at_booking" },
      deposits: { ready: false },
    });
    expect(r.getPaymentReadiness).toHaveBeenCalledWith({ organizationId, propertyId });
    expect(r.query.mock.calls[0]![1]).toEqual([propertyId]);
    expect((await reader(snapshot(card("ready")), {}, false).read).card).toEqual({
      ready: false,
      reason: "switch_off",
      charge: "at_booking",
    });
  });

  it("names the first thing missing", async () => {
    const reason = async (...args: Parameters<typeof reader>) =>
      (await reader(...args).read).card.reason;
    expect(await reason(null)).toBe("not_connected");
    expect(await reason(snapshot(card("ready"), false))).toBe("not_connected");
    expect(await reason(snapshot(null))).toBe("not_connected");
    expect(await reason(snapshot(card("unready", [], false)))).toBe("not_connected");
    // Finance says "execution unavailable" both without a Stripe account and without Vayada's approval.
    expect(
      await reason(snapshot(card("unready", ["online_card_execution_unavailable"])), {
        linked: false,
      }),
    ).toBe("not_connected");
    expect(await reason(snapshot(card("unready", ["online_card_execution_unavailable"])))).toBe(
      "not_approved",
    );
    expect(await reason(snapshot(card("unready", ["provider_capability_lost"])))).toBe(
      "not_connected",
    );
    expect(await reason(snapshot(card("unready", ["provider_restricted"])))).toBe("not_connected");
    expect(await reason(snapshot(card("unready", ["online_card_currency_unsupported"])))).toBe(
      "currency",
    );
    expect(await reason(snapshot(card("unready", ["pricing_currency_mismatch"])))).toBe("currency");
    expect(
      await reason(snapshot(card("unready", ["online_card_execution_unavailable"])), {}, false),
    ).toBe("not_approved");
  });

  it("trusts Finance's ready answer over the linked-account check", async () => {
    expect((await reader(snapshot(card("ready")), { linked: false }).read).card).toEqual({
      ready: true,
      reason: null,
      charge: "at_booking",
    });
  });

  it("charges request-mode hotels when they accept", async () => {
    expect((await reader(snapshot(card("ready")), { mode: "request" }).read).card.charge).toBe(
      "on_accept",
    );
    expect((await reader(snapshot(card("ready")), { mode: "instant" }).read).card.charge).toBe(
      "at_booking",
    );
    expect((await reader(null, { mode: "request" }).read).card).toEqual({
      ready: false,
      reason: "not_connected",
      charge: "on_accept",
    });
  });
});
