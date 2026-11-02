import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { PaymentMethodBookingWindows } from "@vayada/domain-booking";

vi.mock("@/lib/i18n", async () => {
  const en = (await import("../../messages/en.json")).default as Record<string, string>;
  const t = (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      en[key] ?? key,
    );
  return { useTranslation: () => ({ t, locale: "en" }) };
});

import { PaymentMethodsStep, windowChoice } from "./PaymentMethodsStep";
import { draftOf, type PaymentWindowsState, type WindowDrafts } from "./PaymentWindowsCard";
import type { PropertySettings } from "@/services/settings";

const settings = {
  online_card_payment: true,
  pay_at_property_enabled: true,
  pay_at_hotel_methods: ["cash"],
  bank_transfer: true,
  paypal_enabled: false,
  paypal_email: "",
  paypal_payment_window_hours: 36,
  payout_account_type: "iban",
} as PropertySettings;

function windowsOf(saved: PaymentMethodBookingWindows, update = vi.fn()): PaymentWindowsState {
  const drafts: WindowDrafts = {
    card: draftOf(saved.card),
    pay_at_property: draftOf(saved.pay_at_property),
    bank_transfer: draftOf(saved.bank_transfer),
  };
  return {
    saved,
    drafts,
    deadlineHours: 48,
    loadError: false,
    reload: vi.fn(),
    update,
    apply: vi.fn(),
    discard: vi.fn(),
  };
}

function render(props: Partial<React.ComponentProps<typeof PaymentMethodsStep>> = {}) {
  let view!: ReactTestRenderer;
  act(() => {
    view = create(
      <PaymentMethodsStep
        settings={settings}
        update={vi.fn()}
        windows={windowsOf({})}
        busy={false}
        loading={false}
        ownerFinance
        bankMaskedAccount={null}
        cardHidden={false}
        {...props}
      />,
    );
  });
  return view;
}

const select = (view: ReactTestRenderer, method: string) =>
  view.root.find(
    (node) =>
      node.type === "select" && node.props["aria-label"] === `When guests can choose ${method}`,
  );
const options = (node: ReactTestInstance) =>
  node.findAllByType("option").map((option) => String(option.props.children));
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

describe("Payments Step 1: how guests can pay (VAY-2424)", () => {
  it("offers the mockup's booking times; bank transfer can't take 48 hours", () => {
    const view = render();
    expect(options(select(view, "Credit card"))).toEqual([
      "Any time",
      "48 hours+ before arrival",
      "7 days+ before arrival",
      "14 days+ before arrival",
      "30 days+ before arrival",
    ]);
    expect(options(select(view, "Bank transfer"))).toEqual([
      "Any time",
      "7 days+ before arrival",
      "14 days+ before arrival",
      "30 days+ before arrival",
    ]);
    // PayPal keeps its own payment window: no booking time to choose.
    expect(() => select(view, "PayPal")).toThrow();
    expect(text(view)).toContain("36 hours+ before arrival");
  });

  it("keeps a saved window the presets don't have as Custom", () => {
    const update = vi.fn();
    const view = render({
      windows: windowsOf(
        {
          pay_at_property: { kind: "within", amount: 48, unit: "hours" },
          card: { kind: "at_least", amount: 5, unit: "days" },
          bank_transfer: { kind: "at_least", amount: 14, unit: "days" },
        },
        update,
      ),
    });
    const hotel = select(view, "Pay at hotel");
    expect(hotel.props.value).toBe("custom");
    expect(options(hotel).at(-1)).toBe("Custom: Within 48 hours of arrival");
    expect(select(view, "Credit card").props.value).toBe("custom");
    expect(options(select(view, "Credit card")).at(-1)).toBe("Custom: 5 days+ before arrival");
    expect(select(view, "Bank transfer").props.value).toBe("14");
    expect(options(select(view, "Bank transfer"))).not.toContain("Custom: 14 days+ before arrival");

    act(() => hotel.props.onChange({ target: { value: "7" } }));
    expect(update).toHaveBeenLastCalledWith("pay_at_property", {
      kind: "at_least",
      amount: "7",
      unit: "days",
    });
    act(() => hotel.props.onChange({ target: { value: "custom" } }));
    expect(update).toHaveBeenLastCalledWith("pay_at_property", {
      kind: "within",
      amount: "48",
      unit: "hours",
    });
    act(() => hotel.props.onChange({ target: { value: "any" } }));
    expect(update).toHaveBeenLastCalledWith("pay_at_property", { kind: "any" });
  });

  it("names each preset and anything else as custom", () => {
    expect(windowChoice("card", { kind: "any", amount: "7", unit: "days" })).toBe("any");
    expect(windowChoice("card", { kind: "at_least", amount: "2", unit: "days" })).toBe("2");
    expect(windowChoice("bank_transfer", { kind: "at_least", amount: "2", unit: "days" })).toBe(
      "custom",
    );
    expect(windowChoice("card", { kind: "within", amount: "7", unit: "days" })).toBe("custom");
  });

  it("can't choose a booking time for a way to pay that is off", () => {
    const view = render({ settings: { ...settings, online_card_payment: false } });
    expect(select(view, "Credit card").props.disabled).toBe(true);
    expect(select(view, "Pay at hotel").props.disabled).toBe(false);
  });

  it("asks for Cash or Card at the hotel, and says when card is hidden from guests", () => {
    const update = vi.fn();
    const view = render({ update, cardHidden: true });
    const boxes = view.root.findAll(
      (node) => node.type === "input" && node.props.type === "checkbox",
    );
    expect(boxes.map((box) => box.props.checked)).toEqual([true, false]);
    act(() => boxes[0].props.onChange());
    expect(update).toHaveBeenLastCalledWith("pay_at_hotel_methods", []);
    act(() => boxes[1].props.onChange());
    expect(update).toHaveBeenLastCalledWith("pay_at_hotel_methods", ["cash", "card"]);
    expect(text(view)).toContain(
      "Hidden from guests until a payment account is connected in Step 2.",
    );

    const none = render({ settings: { ...settings, pay_at_hotel_methods: [] } });
    expect(text(none)).toContain("Choose Cash, Card or both for Pay at hotel.");
  });

  it("leaves bank transfer to the owner (VAY-2401)", () => {
    const view = render({ ownerFinance: false });
    const bank = view.root.find(
      (node) => node.props.role === "switch" && node.props["aria-label"] === "Offer Bank transfer",
    );
    expect(bank.props.disabled).toBe(true);
  });
});
