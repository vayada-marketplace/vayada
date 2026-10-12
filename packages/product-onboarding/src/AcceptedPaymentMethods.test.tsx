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
        />,
      );
    });
    const box = (label: string) => view!.root.findByProps({ "aria-label": label });
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
});
