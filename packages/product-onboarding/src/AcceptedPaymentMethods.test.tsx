import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { AcceptedPaymentMethods } from "./AcceptedPaymentMethods";

describe("accepted payment methods", () => {
  it("offers bank transfer and PayPal next to card and pay at property (VAY-2139)", async () => {
    const onChange = vi.fn();
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <AcceptedPaymentMethods
          methods={["card", "bank_transfer"]}
          disabled={false}
          onChange={onChange}
          t={(key) => key}
          manualMethods={["paypal"]}
        />,
      );
    });
    const box = (label: string) => view!.root.findByProps({ "aria-label": label });
    // The list is controlled and stays card + bank transfer: each toggle starts from it.
    await act(async () =>
      box("pricing.paymentMethods.payAtProperty").props.onChange({ target: { checked: true } }),
    );
    expect(onChange).toHaveBeenLastCalledWith(["card", "pay_at_property", "bank_transfer"]);
    await act(async () =>
      box("pricing.paymentMethods.card").props.onChange({ target: { checked: false } }),
    );
    expect(onChange).toHaveBeenLastCalledWith(["bank_transfer"]);
    await act(async () =>
      box("pricing.paymentMethods.paypal").props.onChange({ target: { checked: true } }),
    );
    expect(onChange).toHaveBeenLastCalledWith(["card", "bank_transfer", "paypal"]);
  });
  it("shows bank transfer and PayPal only when the hotel can use them or a rate takes them (VAY-2139)", async () => {
    let view: ReactTestRenderer;
    const render = async (
      methods: ("card" | "bank_transfer")[],
      manualMethods?: ("paypal" | "bank_transfer")[],
    ) =>
      act(async () => {
        view = create(
          <AcceptedPaymentMethods
            methods={methods}
            disabled={false}
            onChange={vi.fn()}
            t={(key) => key}
            manualMethods={manualMethods}
          />,
        );
      });
    const labels = () =>
      view!.root.findAllByType("input").map((input) => input.props["aria-label"]);
    await render(["card"]);
    expect(labels()).toEqual([
      "pricing.paymentMethods.card",
      "pricing.paymentMethods.payAtProperty",
    ]);
    // A rate that already takes bank transfer keeps it visible, so it can be removed.
    await render(["card", "bank_transfer"]);
    expect(labels()).toContain("pricing.paymentMethods.bankTransfer");
    expect(labels()).not.toContain("pricing.paymentMethods.paypal");
    await render(["card"], ["paypal"]);
    expect(labels()).toEqual([
      "pricing.paymentMethods.card",
      "pricing.paymentMethods.payAtProperty",
      "pricing.paymentMethods.paypal",
    ]);
  });
});
