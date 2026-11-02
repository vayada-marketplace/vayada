"use client";

import type { WindowedPaymentMethod } from "@vayada/domain-booking";
import { useTranslation } from "@/lib/i18n";
import type { PropertySettings } from "@/services/settings";
import {
  draftOf,
  leadText,
  type PaymentWindowsState,
  type WindowDraft,
} from "@/components/settings/paymentWindows";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Tone = "good" | "warn" | "neutral";
type Method = WindowedPaymentMethod | "paypal";
type Switched =
  | "online_card_payment"
  | "pay_at_property_enabled"
  | "bank_transfer"
  | "paypal_enabled";

/** Timo's mockup (VAY-2424): one row per way to pay, in this order. */
const ROWS: { method: Method; switched: Switched; desc: string; tags: [string, Tone][] }[] = [
  {
    method: "card",
    switched: "online_card_payment",
    desc: "settings.payments.cardDesc",
    tags: [
      ["settings.payments.tagInstantConfirmation", "good"],
      ["settings.payments.tagAutoPayout", "good"],
      ["settings.payments.tagProcessingFees", "warn"],
    ],
  },
  {
    method: "pay_at_property",
    switched: "pay_at_property_enabled",
    desc: "settings.payments.payAtHotelDesc",
    tags: [
      ["settings.payments.tagNoFees", "good"],
      ["settings.payments.tagNoShowRisk", "warn"],
    ],
  },
  {
    method: "bank_transfer",
    switched: "bank_transfer",
    desc: "settings.payments.bankTransferDesc",
    tags: [
      ["settings.payments.tagNoFees", "good"],
      ["settings.payments.tagLargeBookings", "neutral"],
      ["settings.payments.tagConfirmManually", "warn"],
    ],
  },
  {
    method: "paypal",
    switched: "paypal_enabled",
    desc: "settings.payments.paypalDesc",
    tags: [["settings.payments.tagConfirmInPms", "warn"]],
  },
];

const METHOD_NAME: Record<Method, string> = {
  card: "settings.billing.onlineCard",
  pay_at_property: "settings.billing.payAtHotel",
  bank_transfer: "settings.billing.bankTransfer",
  paypal: "settings.payments.paypal",
};

const TAG_TONE: Record<Tone, string> = {
  good: "bg-green-50 text-green-800",
  warn: "bg-amber-50 text-amber-800",
  neutral: "bg-slate-100 text-slate-700",
};

/** "At least N days before arrival". Bank transfer can't take 2 days: guests have 48 hours to pay
 * and the money must arrive before check-in (VAY-2348 D7). */
const PRESET_DAYS = [2, 7, 14, 30];
const presetDays = (method: WindowedPaymentMethod) =>
  method === "bank_transfer" ? PRESET_DAYS.filter((days) => days >= 3) : PRESET_DAYS;

/** The select's value for a row: "any", a preset's days, or "custom" for a saved window the
 * presets don't have (an older "within" window, or another number of days). */
export function windowChoice(method: WindowedPaymentMethod, draft: WindowDraft): string {
  if (draft.kind === "any") return "any";
  return draft.kind === "at_least" && presetDays(method).map(String).includes(draft.amount)
    ? draft.amount
    : "custom";
}

function windowText(draft: WindowDraft, t: Translate): string {
  const hours = Number(draft.amount) * (draft.kind === "within" && draft.unit === "hours" ? 1 : 24);
  return draft.kind === "within"
    ? t("settings.payments.windowWithin", { lead: leadText(hours, t) })
    : t("settings.payments.windowAtLeast", { lead: leadText(hours, t) });
}

const field =
  "h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-500";
const label = "flex flex-col gap-1.5 text-[13px] text-slate-600";

/**
 * VAY-2424, Step 1 of Booking Admin › Payments: every way guests can pay, each with a switch and
 * when guests can choose it (the booking windows of VAY-2348), plus what that way needs (Cash or
 * Card at the hotel, the bank details, the PayPal email). The page's one Save stores it all.
 */
export function PaymentMethodsStep({
  settings,
  update,
  windows,
  busy,
  loading,
  ownerFinance,
  bankMaskedAccount,
  cardHidden,
}: {
  settings: PropertySettings;
  update: <K extends keyof PropertySettings>(key: K, value: PropertySettings[K]) => void;
  windows: PaymentWindowsState;
  /** Clicks would be lost: the saved choices are still loading, Stripe is being checked, or
   * Save runs (VAY-2185, VAY-2424). */
  busy: boolean;
  loading: boolean;
  /** Bank transfer and the account guests pay into are the owner's (VAY-2401). */
  ownerFinance: boolean | null;
  bankMaskedAccount: string | null;
  /** Credit card is on, but no payment account can take it yet. */
  cardHidden: boolean;
}) {
  const { t } = useTranslation();
  const paypalHours = Math.max(1, Math.min(168, settings.paypal_payment_window_hours || 24));
  const accountType = settings.payout_account_type || "iban";

  const windowSelect = (method: WindowedPaymentMethod, name: string, on: boolean) => {
    // Until the windows load (or when they can't), no choice is claimed.
    if (!windows.drafts)
      return (
        <select
          aria-label={t("settings.payments.windowFor", { method: name })}
          value=""
          disabled
          className={field}
        >
          <option value="">—</option>
        </select>
      );
    const draft = windows.drafts[method];
    const saved = windows.saved?.[method];
    const choice = windowChoice(method, draft);
    const custom = choice === "custom" ? draft : saved && draftOf(saved);
    return (
      <select
        aria-label={t("settings.payments.windowFor", { method: name })}
        value={choice}
        disabled={!on}
        onChange={(event) => {
          const value = event.target.value;
          windows.update(
            method,
            value === "any"
              ? { kind: "any" }
              : value === "custom"
                ? draftOf(saved)
                : { kind: "at_least", amount: value, unit: "days" },
          );
        }}
        className={field}
      >
        <option value="any">{t("settings.paymentWindows.anyTime")}</option>
        {presetDays(method).map((days) => (
          <option key={days} value={String(days)}>
            {t("settings.payments.windowAtLeast", { lead: leadText(days * 24, t) })}
          </option>
        ))}
        {custom && windowChoice(method, custom) === "custom" && (
          <option value="custom">
            {t("settings.payments.windowCustom", { window: windowText(custom, t) })}
          </option>
        )}
      </select>
    );
  };

  return (
    <section
      aria-labelledby="payment-methods-heading"
      className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1 pb-3">
        <span className="text-xs font-semibold uppercase tracking-[0.04em] text-primary-600">
          {t("settings.payments.step", { number: 1 })}
        </span>
        <h2 id="payment-methods-heading" className="text-lg font-semibold text-slate-900">
          {t("settings.payments.methodsTitle")}
        </h2>
        <p className="text-sm text-slate-600">{t("settings.payments.methodsDesc")}</p>
      </div>
      {/* pointer-events-none also stops clicks on the labels while the fieldset is disabled. */}
      <fieldset
        aria-labelledby="payment-methods-heading"
        disabled={busy}
        aria-disabled={busy}
        aria-busy={loading}
        className={`min-w-0 ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        {ROWS.map(({ method, switched, desc, tags }) => {
          const name = t(METHOD_NAME[method]);
          const on = !!settings[switched];
          return (
            <div
              key={method}
              data-testid={`payment-method-${method}`}
              className="flex flex-col gap-3.5 border-t border-slate-200 py-[18px]"
            >
              <div className="flex flex-wrap items-center gap-4">
                {/* The switch stays beside its text at every width. */}
                <div className="flex min-w-0 flex-[1_1_300px] items-center gap-4">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={t("settings.payments.offer", { method: name })}
                    disabled={method === "bank_transfer" && ownerFinance === false}
                    onClick={() => {
                      update(switched, !on);
                      // Back on with neither ticked: Cash and Card, as when first switched on.
                      if (
                        method === "pay_at_property" &&
                        !on &&
                        !settings.pay_at_hotel_methods.length
                      )
                        update("pay_at_hotel_methods", ["cash", "card"]);
                    }}
                    className={`flex h-[26px] w-11 shrink-0 rounded-full p-[3px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                      on ? "justify-end bg-primary-500" : "justify-start bg-slate-300"
                    }`}
                  >
                    <span aria-hidden="true" className="h-5 w-5 rounded-full bg-white shadow-sm" />
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="text-[15px] font-semibold text-slate-900">{name}</span>
                    <span className="text-[13px] text-slate-600">{t(desc)}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {tags.map(([tag, tone]) => (
                        <span
                          key={tag}
                          className={`rounded-full px-2 py-[3px] text-xs ${TAG_TONE[tone]}`}
                        >
                          {t(tag)}
                        </span>
                      ))}
                    </span>
                  </div>
                </div>
                <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5 text-xs text-slate-600 sm:flex-[0_1_220px]">
                  {t("settings.payments.guestsCanChoose")}
                  {method === "paypal" ? (
                    // PayPal has no booking window: it is offered while its own payment window
                    // still ends before check-in (VAY-2145).
                    <span
                      className={`flex h-11 items-center text-sm ${on ? "text-slate-900" : "text-slate-400"}`}
                    >
                      {t("settings.payments.windowAtLeast", {
                        lead: leadText(paypalHours, t),
                      })}
                    </span>
                  ) : (
                    windowSelect(method, name, on)
                  )}
                </div>
              </div>

              {method === "card" && on && cardHidden && (
                <p className="text-[13px] text-amber-800 sm:ml-[60px]">
                  {t("settings.payments.cardHidden")}
                </p>
              )}
              {method === "pay_at_property" && on && (
                <fieldset className="flex flex-wrap items-center gap-x-4 sm:ml-[60px]">
                  <legend className="pb-2 text-[13px] text-slate-600">
                    {t("settings.payments.acceptedAtCheckIn")}
                  </legend>
                  {(["cash", "card"] as const).map((choice) => {
                    const checked = settings.pay_at_hotel_methods.includes(choice);
                    return (
                      <label
                        key={choice}
                        className="flex min-h-[44px] items-center gap-2 text-sm text-slate-900"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            update(
                              "pay_at_hotel_methods",
                              checked
                                ? settings.pay_at_hotel_methods.filter((value) => value !== choice)
                                : [...settings.pay_at_hotel_methods, choice],
                            )
                          }
                          className="h-[18px] w-[18px] accent-primary-500"
                        />
                        {t(choice === "cash" ? "settings.billing.cash" : "settings.billing.card")}
                      </label>
                    );
                  })}
                  {settings.pay_at_hotel_methods.length === 0 && (
                    <p role="alert" className="basis-full text-[13px] font-medium text-red-700">
                      {t("settings.paymentsSave.payAtHotelMethods")}
                    </p>
                  )}
                </fieldset>
              )}
              {method === "bank_transfer" && on && (
                <div className="flex flex-col gap-3 sm:ml-[60px]">
                  <fieldset
                    disabled={ownerFinance === false}
                    className="grid min-w-0 max-w-xl grid-cols-1 gap-3 disabled:opacity-60 sm:grid-cols-2"
                  >
                    <legend className="pb-1.5 text-[13px] text-slate-600">
                      {t("settings.payments.bankDetails")}
                    </legend>
                    {bankMaskedAccount && (
                      <p className="text-[13px] text-slate-600 sm:col-span-2">
                        {t("admin.savedAccount")} {bankMaskedAccount}
                        {t("admin.leaveBankFieldsEmptyToKeepItOrEnterComplete")}
                      </p>
                    )}
                    <label className={`${label} sm:col-span-2`}>
                      {t("settings.billing.payoutAccountHolder")}
                      <input
                        type="text"
                        value={settings.payout_account_holder || ""}
                        onChange={(e) => update("payout_account_holder", e.target.value)}
                        placeholder={t("settings.billing.payoutAccountHolderPlaceholder")}
                        className={field}
                      />
                    </label>
                    <div className="flex flex-col gap-1.5 sm:col-span-2">
                      <span className="text-[13px] text-slate-600">
                        {t("settings.billing.accountFormatLabel")}
                      </span>
                      <div className="inline-flex w-fit rounded-lg border border-slate-300 bg-slate-50 p-0.5">
                        {(["iban", "account_number"] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            aria-pressed={accountType === type}
                            onClick={() => update("payout_account_type", type)}
                            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                              accountType === type
                                ? "bg-white text-slate-900 shadow-sm"
                                : "text-slate-500 hover:text-slate-700"
                            }`}
                          >
                            {t(
                              type === "iban"
                                ? "settings.billing.payoutIban"
                                : "settings.billing.accountNumberLabel",
                            )}
                          </button>
                        ))}
                      </div>
                      <span className="text-xs text-slate-500">
                        {t(
                          accountType === "iban"
                            ? "settings.billing.useIbanHelp"
                            : "settings.billing.usePlainNumberHelp",
                        )}
                      </span>
                    </div>
                    <label className={`${label} sm:col-span-2`}>
                      {t(
                        accountType === "iban"
                          ? "settings.billing.payoutIban"
                          : "settings.billing.accountNumberLabel",
                      )}
                      <input
                        type="text"
                        value={
                          (accountType === "iban"
                            ? settings.payout_iban
                            : settings.payout_account_number) || ""
                        }
                        onChange={(e) =>
                          update(
                            accountType === "iban" ? "payout_iban" : "payout_account_number",
                            e.target.value,
                          )
                        }
                        placeholder={t(
                          accountType === "iban"
                            ? "settings.billing.payoutIbanPlaceholder"
                            : "settings.billing.payoutAccountNumberPlaceholder",
                        )}
                        className={`${field} font-mono`}
                      />
                    </label>
                    <label className={label}>
                      {t("settings.billing.payoutBankName")}
                      <input
                        type="text"
                        value={settings.payout_bank_name || ""}
                        onChange={(e) => update("payout_bank_name", e.target.value)}
                        placeholder={t("settings.billing.payoutBankNamePlaceholder")}
                        className={field}
                      />
                    </label>
                    <label className={label}>
                      {t("settings.billing.payoutSwift")}
                      <input
                        type="text"
                        value={settings.payout_swift || ""}
                        onChange={(e) => update("payout_swift", e.target.value)}
                        placeholder={t("settings.billing.payoutSwiftPlaceholder")}
                        className={`${field} font-mono`}
                      />
                    </label>
                  </fieldset>
                  <div className="max-w-xl rounded-lg bg-slate-50 px-3 py-2.5 text-xs">
                    <p className="font-semibold text-slate-900">
                      {t("settings.paymentWindows.bankRuleTitle", {
                        hours: windows.deadlineHours,
                      })}
                    </p>
                    <p className="text-slate-600">
                      {t("settings.paymentWindows.bankRuleBody", { hours: windows.deadlineHours })}
                    </p>
                  </div>
                </div>
              )}
              {method === "paypal" && on && (
                <div className="grid max-w-xl grid-cols-1 gap-3 sm:ml-[60px] sm:grid-cols-2">
                  <label className={label}>
                    {t("settings.payments.paypalEmail")}
                    <input
                      type="email"
                      value={settings.paypal_email || ""}
                      onChange={(e) => update("paypal_email", e.target.value)}
                      placeholder="payments@yourhotel.com"
                      className={field}
                    />
                  </label>
                  <label className={label}>
                    {t("admin.paymentWindowHours")}
                    <input
                      type="number"
                      min={1}
                      max={168}
                      value={settings.paypal_payment_window_hours || 24}
                      onChange={(e) =>
                        update(
                          "paypal_payment_window_hours",
                          Math.max(1, Number(e.target.value) || 24),
                        )
                      }
                      className={field}
                    />
                  </label>
                  <p className="text-xs text-slate-500 sm:col-span-2">
                    {t("admin.guestsAreAskedToPayWithinThisWindowConfirmReceipt")}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </fieldset>
    </section>
  );
}
