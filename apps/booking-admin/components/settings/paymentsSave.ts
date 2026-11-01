import type { DirectTransferDetails } from "@vayada/product-onboarding/bankTransferDestination";

import type { PropertySettings } from "@/services/settings";

/**
 * VAY-2424: one save for Booking Admin › Settings › Payments. The page keeps the payment form as
 * last saved, so it knows what changed, Discard can put it back, and Save only sends the parts
 * that changed: bank details, then the payment settings, then the booking windows.
 */
export type PaymentProviderChoice = "stripe" | "xendit" | "vayada";

export type PaymentsForm = {
  payAtProperty: boolean;
  payAtHotelMethods: string[];
  onlineCard: boolean;
  bankTransfer: boolean;
  paypal: boolean;
  paypalEmail: string;
  paypalHours: number;
  provider: PaymentProviderChoice;
};

type PaymentFields = Pick<
  PropertySettings,
  | "pay_at_property_enabled"
  | "pay_at_hotel_methods"
  | "online_card_payment"
  | "bank_transfer"
  | "paypal_enabled"
  | "paypal_email"
  | "paypal_payment_window_hours"
>;

type BankFields = Pick<
  PropertySettings,
  | "payout_account_holder"
  | "payout_account_type"
  | "payout_iban"
  | "payout_account_number"
  | "payout_bank_name"
  | "payout_swift"
>;

export function paymentsFormOf(
  settings: PaymentFields,
  provider: PaymentProviderChoice,
): PaymentsForm {
  return {
    payAtProperty: settings.pay_at_property_enabled,
    payAtHotelMethods: settings.pay_at_hotel_methods,
    onlineCard: settings.online_card_payment ?? false,
    bankTransfer: settings.bank_transfer ?? false,
    paypal: settings.paypal_enabled ?? false,
    paypalEmail: settings.paypal_email ?? "",
    paypalHours: settings.paypal_payment_window_hours ?? 24,
    provider,
  };
}

/** The page's settings fields for a form, with the bank detail inputs empty again. */
export function paymentsFormFields(form: PaymentsForm): PaymentFields & BankFields {
  return {
    pay_at_property_enabled: form.payAtProperty,
    pay_at_hotel_methods: form.payAtHotelMethods,
    online_card_payment: form.onlineCard,
    bank_transfer: form.bankTransfer,
    paypal_enabled: form.paypal,
    paypal_email: form.paypalEmail,
    paypal_payment_window_hours: form.paypalHours,
    ...EMPTY_BANK_FIELDS,
  };
}

export const EMPTY_BANK_FIELDS: BankFields = {
  payout_account_holder: "",
  payout_account_type: "account_number",
  payout_iban: "",
  payout_account_number: "",
  payout_bank_name: "",
  payout_swift: "",
};

/** Same choices for guests. A choice that is switched off doesn't count (its hidden inputs keep
 * what was typed), and PayPal's window counts as the save sends it. */
export function samePaymentsForm(a: PaymentsForm, b: PaymentsForm): boolean {
  const methods = (form: PaymentsForm) =>
    form.payAtProperty ? [...form.payAtHotelMethods].sort().join() : "";
  const hours = (form: PaymentsForm) => Math.max(1, Math.min(168, form.paypalHours || 24));
  return (
    a.payAtProperty === b.payAtProperty &&
    methods(a) === methods(b) &&
    a.onlineCard === b.onlineCard &&
    (!a.onlineCard || a.provider === b.provider) &&
    a.bankTransfer === b.bankTransfer &&
    a.paypal === b.paypal &&
    (!a.paypal || (a.paypalEmail.trim() === b.paypalEmail.trim() && hours(a) === hours(b)))
  );
}

export function bankDetailsOf(settings: BankFields): DirectTransferDetails {
  return {
    accountHolder: settings.payout_account_holder ?? "",
    accountType: settings.payout_account_type ?? "iban",
    accountNumber:
      (settings.payout_account_type === "account_number"
        ? settings.payout_account_number
        : settings.payout_iban) ?? "",
    bankName: settings.payout_bank_name ?? "",
    bicSwift: settings.payout_swift ?? "",
    instructions: "",
  };
}

/** Something typed into the bank detail inputs (the account format alone isn't an edit). */
export function bankDetailsEdited(settings: BankFields): boolean {
  return [
    settings.payout_account_holder,
    settings.payout_iban,
    settings.payout_account_number,
    settings.payout_bank_name,
    settings.payout_swift,
  ].some((value) => !!value?.trim());
}

/** The parts of the page saved one after another, each by its own endpoint. */
export type PaymentsPart = "bank" | "methods" | "windows";

export const PAYMENTS_PART_LABEL: Record<PaymentsPart, string> = {
  bank: "settings.paymentsSave.partBank",
  methods: "settings.paymentsSave.partMethods",
  windows: "settings.paymentsSave.partWindows",
};

export type PaymentsSaveStatus =
  | { kind: "saved" }
  /** Nothing was sent: a check before saving failed. */
  | { kind: "invalid"; message: string; params?: Record<string, string | number> }
  /** `saved` went through before `failed` didn't; the rest wasn't tried. `retry`: saving the
   * same again may work, so the page offers Try again. */
  | {
      kind: "failed";
      saved: PaymentsPart[];
      failed: PaymentsPart;
      message: string;
      params?: Record<string, string | number>;
      retry: boolean;
    };

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The plain "couldn't save" reason adds nothing to "Not saved: …" next to Try again. */
const GENERIC_FAILURE = "settings.paymentsSave.failed";

/** "Saved: Bank details. Not saved: Payment methods. <why, when there's more to say>" */
export function paymentsSaveFailureText(
  status: Extract<PaymentsSaveStatus, { kind: "failed" }>,
  t: Translate,
): string {
  return [
    ...status.saved.map((part) =>
      t("settings.paymentsSave.savedPart", { part: t(PAYMENTS_PART_LABEL[part]) }),
    ),
    t("settings.paymentsSave.notSavedPart", { part: t(PAYMENTS_PART_LABEL[status.failed]) }),
    ...(status.message === GENERIC_FAILURE ? [] : [t(status.message, status.params)]),
  ].join(" ");
}
