import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      en[key] ?? key,
    );
  return { useTranslation: () => ({ t, locale: "en" }) };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/settings/SettingsSubPage", () => ({
  SettingsSubPage: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));
vi.mock("@/services/api/bookingHotelScope", () => ({
  getSelectedBookingHotelId: () => "booking_hotel_alpenrose",
  SELECTED_HOTEL_CHANGED_EVENT: "vayada:selected-hotel-changed",
}));
vi.mock("@/services/api/bookingPropertyLinkClient", () => ({
  getBookingHotelPropertyLink: async () => ({ propertyId: PROPERTY }),
}));
vi.mock("@/services/settings", () => ({ settingsService: { getPropertySettings: vi.fn() } }));

import { ApiErrorResponse } from "@/services/api/client";
import type { PayoutStatement } from "@/services/api/financePayoutStatementClient";
import { PayoutStatementPage } from "./PayoutStatementPage";

const PROPERTY = "25840000-0000-4000-8000-000000000001";
// Tests run in node: the page only listens on window for the header's hotel selection.
vi.stubGlobal("window", new EventTarget());
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

const statement: PayoutStatement = {
  totals: [
    {
      currency: "IDR",
      nextPayout: {
        on: "2026-11-30",
        cutoff: "2026-11-29",
        amountMinor: "1845000000",
        balanceMinor: "1845000000",
      },
      upcomingMinor: "720000000",
      paidOutMinor: "3410000000",
      firstPaidOn: "2026-11-02",
    },
  ],
  account: { accountLast4: "6789", countryCode: "ID" },
  payouts: [
    {
      id: "p23",
      currency: "IDR",
      amountMinor: "912000000",
      accountLast4: "6789",
      startedOn: "2026-11-23",
      paidOn: "2026-11-23",
      returnedOn: null,
      status: "sent",
    },
    {
      id: "p9",
      currency: "IDR",
      amountMinor: "800000000",
      accountLast4: "1102",
      startedOn: "2026-11-09",
      paidOn: "2026-11-09",
      returnedOn: "2026-11-12",
      status: "returned",
    },
  ],
  lines: [
    {
      id: "charge",
      kind: "charge",
      currency: "IDR",
      grossMinor: "320000000",
      feeMinor: "44800000",
      netMinor: "275200000",
      bookingReference: "VAY-7KQ2C",
      checkOut: "2026-11-28",
      occurredAt: "2026-11-24T08:00:00Z",
      fees: { planMinor: "25600000", vayadaMinor: "19200000", vayadaPercent: 6 },
      payoutId: null,
    },
    {
      id: "payout",
      kind: "payout",
      currency: "IDR",
      grossMinor: "-912000000",
      feeMinor: "0",
      netMinor: "-912000000",
      bookingReference: null,
      checkOut: null,
      occurredAt: "2026-11-23T09:00:00Z",
      fees: null,
      payoutId: "p23",
    },
    {
      id: "refund",
      kind: "refund",
      currency: "IDR",
      grossMinor: "-150000000",
      feeMinor: "-12000000",
      netMinor: "-138000000",
      bookingReference: "VAY-5MX9P",
      checkOut: "2026-11-25",
      occurredAt: "2026-11-22T09:00:00Z",
      fees: null,
      payoutId: null,
    },
    {
      id: "dispute",
      kind: "dispute",
      currency: "IDR",
      grossMinor: "-240000000",
      feeMinor: "40500000",
      netMinor: "-280500000",
      bookingReference: "VAY-3HD4K",
      checkOut: "2026-11-19",
      occurredAt: "2026-11-21T09:00:00Z",
      fees: null,
      payoutId: null,
    },
    {
      id: "fee",
      kind: "dispute_fee",
      currency: "IDR",
      grossMinor: "0",
      feeMinor: "40500000",
      netMinor: "-40500000",
      bookingReference: "VAY-1QZ8M",
      checkOut: "2026-11-09",
      occurredAt: "2026-11-20T09:00:00Z",
      fees: null,
      payoutId: null,
    },
    {
      id: "returned",
      kind: "payout_returned",
      currency: "IDR",
      grossMinor: "800000000",
      feeMinor: "0",
      netMinor: "800000000",
      bookingReference: null,
      checkOut: null,
      occurredAt: "2026-11-12T09:00:00Z",
      fees: null,
      payoutId: "p9",
    },
  ],
};

async function render(load: (propertyId: string) => Promise<PayoutStatement>) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<PayoutStatementPage load={load} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}
const byTestId = (view: ReactTestRenderer, id: string) =>
  view.root.findAll((node) => node.props["data-testid"] === id && typeof node.type === "string");

describe("Settings › Payouts (VAY-2584)", () => {
  it("shows the owner what is owed, each payout and every line with its reason", async () => {
    const load = vi.fn(async () => statement);
    const view = await render(load);
    expect(load).toHaveBeenCalledWith(PROPERTY);
    const page = textOf(view.root);
    expect(page).toContain("Payouts");
    // Totals.
    expect(page).toContain("Next payout · Mon 30 Nov");
    expect(page).toContain("IDR 18,450,000");
    expect(page).toContain("For stays checking out by Sun 29 Nov, to •••• 6789.");
    expect(page).toContain("IDR 7,200,000");
    expect(page).toContain("Since Mon 2 Nov. A payout the bank sent back isn't counted.");
    // Payouts with their status.
    const payouts = byTestId(view, "payout-row").map(textOf);
    expect(payouts).toHaveLength(2);
    expect(payouts[0]).toContain("Mon 23 Nov");
    expect(payouts[0]).toContain("IDR 9,120,000");
    expect(payouts[0]).toContain("Sent");
    expect(payouts[1]).toContain("•••• 1102");
    expect(payouts[1]).toContain("Returned by the bank");
    expect(payouts[1]).toContain("The bank sent this payout back.");
    // Every line, named and explained.
    const lines = byTestId(view, "statement-line");
    expect(lines.map((node) => node.props["data-kind"])).toEqual([
      "charge",
      "payout",
      "refund",
      "dispute",
      "dispute_fee",
      "payout_returned",
    ]);
    const [charge, payout, refund, dispute, fee, returned] = lines.map(textOf);
    expect(charge).toContain("Card payment");
    expect(charge).toContain("VAY-7KQ2C");
    expect(charge).toContain("3,200,000");
    expect(charge).toContain("−448,000");
    expect(charge).toContain("2,752,000");
    expect(charge).toContain(
      "Fees: your plan's booking fee (IDR 256,000) and vayada Payment's 6% (IDR 192,000).",
    );
    expect(payout).toContain("−9,120,000");
    expect(refund).toContain("+120,000");
    expect(refund).toContain("−1,380,000");
    expect(dispute).toContain("−2,805,000");
    expect(dispute).toContain("Stripe's dispute fee come off your payouts");
    expect(fee).toContain("Answered dispute lost");
    expect(fee).toContain("−405,000");
    expect(returned).toContain("Payout returned");
    expect(returned).toContain("+8,000,000");
    expect(returned).toContain("The Mon 9 Nov payout came back from the bank.");

    // Filters: card payments, then deductions.
    const chip = (name: string) =>
      view.root.find((node) => node.type === "button" && textOf(node) === name);
    await act(async () => chip("Card payments").props.onClick());
    expect(byTestId(view, "statement-line").map((node) => node.props["data-kind"])).toEqual([
      "charge",
    ]);
    await act(async () => chip("Deductions").props.onClick());
    expect(byTestId(view, "statement-line").map((node) => node.props["data-kind"])).toEqual([
      "refund",
      "dispute",
      "dispute_fee",
    ]);
    expect(chip("Deductions").props["aria-pressed"]).toBe(true);
  });

  it("says when refunds and disputes took more than was owed", async () => {
    const view = await render(async () => ({
      ...statement,
      totals: [
        {
          ...statement.totals[0]!,
          nextPayout: {
            ...statement.totals[0]!.nextPayout,
            amountMinor: "0",
            balanceMinor: "-6380000000",
          },
        },
      ],
    }));
    const page = textOf(view.root);
    expect(page).toContain("IDR 0");
    expect(page).toContain(
      "Refunds and disputes took IDR 63,800,000 more than you were owed. It comes off your next payouts.",
    );
  });

  it("shows a clear empty state before the first payment, or without vayada Payment", async () => {
    for (const load of [
      async () => ({ totals: [], account: null, payouts: [], lines: [] }),
      async () => {
        throw new ApiErrorResponse(404, { code: "vayada_payment_unavailable" } as never);
      },
    ]) {
      const view = await render(load);
      const [empty] = byTestId(view, "payout-statement-empty");
      expect(textOf(empty!)).toContain("No payouts yet");
      expect(textOf(empty!)).toContain("Vayada pays you every Monday");
      expect(empty!.findByType("a").props.href).toBe("/settings/payments");
      expect(byTestId(view, "statement-line")).toHaveLength(0);
    }
  });

  it("tells staff who aren't the owner that payouts are the owner's, and offers a retry on failure", async () => {
    const ownerOnly = await render(async () => {
      throw new ApiErrorResponse(403, { code: "missing_permission" } as never);
    });
    expect(textOf(byTestId(ownerOnly, "payout-statement-owner-only")[0]!)).toContain(
      "Only the account owner can see payouts",
    );
    expect(byTestId(ownerOnly, "payout-totals")).toHaveLength(0);
    // Refused for another reason (not this hotel's, no active plan): not "you aren't the owner".
    const noAccess = await render(async () => {
      throw new ApiErrorResponse(403, { code: "missing_entitlement" } as never);
    });
    expect(textOf(byTestId(noAccess, "payout-statement-no-access")[0]!)).toContain(
      "Payouts aren't available for this hotel account.",
    );
    expect(byTestId(noAccess, "payout-statement-owner-only")).toHaveLength(0);

    const load = vi
      .fn<(propertyId: string) => Promise<PayoutStatement>>()
      .mockRejectedValueOnce(new ApiErrorResponse(503, { code: "unavailable" } as never))
      .mockResolvedValueOnce(statement);
    const failed = await render(load);
    expect(textOf(failed.root)).toContain("Payouts couldn't be loaded.");
    const retry = failed.root.find(
      (node) => node.type === "button" && textOf(node) === "Try again",
    );
    await act(async () => {
      retry.props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(byTestId(failed, "statement-line")).toHaveLength(6);
  });
});
