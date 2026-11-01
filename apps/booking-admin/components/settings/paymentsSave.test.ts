import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import {
  bankDetailsEdited,
  bankDetailsOf,
  paymentsFormFields,
  paymentsFormOf,
  paymentsSaveFailureText,
  samePaymentsForm,
  type PaymentsForm,
} from "./paymentsSave";

const t = (key: string, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );

const saved: PaymentsForm = {
  payAtProperty: true,
  payAtHotelMethods: ["cash", "card"],
  onlineCard: false,
  bankTransfer: false,
  paypal: false,
  paypalEmail: "",
  paypalHours: 24,
  provider: "stripe",
};

describe("Payments one save (VAY-2424)", () => {
  it("knows when the payment choices differ from what was saved", () => {
    expect(samePaymentsForm(saved, { ...saved, payAtHotelMethods: ["card", "cash"] })).toBe(true);
    expect(samePaymentsForm(saved, { ...saved, payAtHotelMethods: ["cash"] })).toBe(false);
    expect(samePaymentsForm(saved, { ...saved, bankTransfer: true })).toBe(false);
    // A provider or PayPal detail only counts while that way to pay is on.
    expect(samePaymentsForm(saved, { ...saved, provider: "vayada" })).toBe(true);
    expect(
      samePaymentsForm(
        { ...saved, onlineCard: true },
        { ...saved, onlineCard: true, provider: "xendit" },
      ),
    ).toBe(false);
    expect(samePaymentsForm(saved, { ...saved, paypalEmail: "x@y.z" })).toBe(true);
    const paypal = { ...saved, paypal: true, paypalEmail: "pay@hotel.test" };
    expect(samePaymentsForm(paypal, { ...paypal, paypalEmail: " pay@hotel.test " })).toBe(true);
    expect(samePaymentsForm(paypal, { ...paypal, paypalHours: 48 })).toBe(false);
    // The save sends 0 as 24 and caps at a week.
    expect(samePaymentsForm(paypal, { ...paypal, paypalHours: 0 })).toBe(true);
    expect(samePaymentsForm({ ...paypal, paypalHours: 168 }, { ...paypal, paypalHours: 500 })).toBe(
      true,
    );
    expect(
      samePaymentsForm(
        { ...saved, payAtProperty: false },
        { ...saved, payAtProperty: false, payAtHotelMethods: ["cash"] },
      ),
    ).toBe(true);
  });

  it("turns the page's settings into the form and back, with the bank inputs empty", () => {
    const fields = paymentsFormFields({ ...saved, paypal: true, paypalEmail: "pay@hotel.test" });
    expect(fields).toMatchObject({
      pay_at_property_enabled: true,
      paypal_enabled: true,
      paypal_email: "pay@hotel.test",
      payout_iban: "",
      payout_account_holder: "",
    });
    expect(paymentsFormOf(fields, "stripe")).toEqual({
      ...saved,
      paypal: true,
      paypalEmail: "pay@hotel.test",
    });
  });

  it("reads typed bank details, the format alone not counting as an edit", () => {
    expect(bankDetailsEdited({ payout_account_type: "iban" })).toBe(false);
    expect(bankDetailsEdited({ payout_swift: " DEUT " })).toBe(true);
    // An IBAN typed, then the account number format chosen: nothing would be sent.
    expect(
      bankDetailsEdited({ payout_account_type: "account_number", payout_iban: "DE89 3704" }),
    ).toBe(false);
    expect(
      bankDetailsOf({
        payout_account_type: "account_number",
        payout_account_number: "12345678",
        payout_iban: "DE00",
        payout_account_holder: "Alpenrose",
        payout_bank_name: "Bank",
      }),
    ).toEqual({
      accountHolder: "Alpenrose",
      accountType: "account_number",
      accountNumber: "12345678",
      bankName: "Bank",
      bicSwift: "",
      instructions: "",
    });
  });

  it("says what saved and what didn't", () => {
    expect(
      paymentsSaveFailureText(
        {
          kind: "failed",
          saved: ["bank"],
          failed: "methods",
          message: "settings.paymentsSave.failed",
          retry: true,
        },
        t,
      ),
    ).toBe("Saved: Bank details. Not saved: Payment methods.");
    expect(
      paymentsSaveFailureText(
        {
          kind: "failed",
          saved: ["bank", "methods"],
          failed: "windows",
          message: "settings.paymentWindows.bankAtLeast",
          params: { hours: 48 },
          retry: false,
        },
        t,
      ),
    ).toBe(
      `Saved: Bank details. Saved: Payment methods. Not saved: Booking windows. ${t("settings.paymentWindows.bankAtLeast", { hours: 48 })}`,
    );
  });
});
