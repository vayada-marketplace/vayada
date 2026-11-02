"use client";

import {
  bankTransferDetailsIncomplete,
  saveBankTransferDestination,
  type SavedBankTransferDestination,
  type BankTransferSaveAttempt,
} from "@vayada/product-onboarding/bankTransferDestination";
import { ApiErrorResponse, apiClient, omitHotelContext } from "@/services/api/client";
import { useEffect, useState, useCallback, useRef } from "react";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { canManageOwnerFinance, getStaffSelfAccess } from "@/services/api/staffSelfAccessClient";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import {
  buildFinancePaymentSettingsBody,
  createFinanceStripeDashboardLink,
  createFinanceStripeProviderAccount,
  FinancePaymentSettingsClientError,
  getFinancePaymentSettings,
  isPlainPayAtHotel,
  issueFinanceStripeOnboardingLink,
  needsExplicitPayAtHotelChoice,
  reconcileFinanceStripeProviderAccount,
  savePaymentMethodWindows,
  updateFinancePaymentSettings,
  payAtHotelMethodsFromFinance,
  type FinancePaymentSettingsResponse,
} from "@/services/api/financePaymentSettingsClient";
import { paymentSaveError } from "@/components/settings/paymentSaveError";
import { VayadaPayoutAccountPanel } from "@/components/settings/VayadaPayoutAccountPanel";
import { PaymentMethodsStep } from "@/components/settings/PaymentMethodsStep";
import {
  CardNotReadyBanner,
  type CardNotReadyReason,
} from "@/components/settings/CardNotReadyBanner";
import { createReplacementPricingClient } from "@vayada/product-onboarding/replacementPricingClient";
import {
  paymentWindowsPlan,
  paymentWindowsSaveError,
  usePaymentWindows,
} from "@/components/settings/paymentWindows";
import {
  PaymentsGuestPreview,
  type PreviewMethods,
} from "@/components/settings/PaymentsGuestPreview";
import {
  bankDetailsEdited,
  bankDetailsOf,
  paymentsFormFields,
  paymentsFormOf,
  paymentsSaveFailureText,
  samePaymentsForm,
  type PaymentsForm,
  type PaymentsPart,
  type PaymentsSaveStatus,
} from "@/components/settings/paymentsSave";
import {
  createFixedPlanCheckout,
  getFinancePlanStatus,
  openFinanceCustomerPortal,
  switchToCommissionPlan,
  type FinancePlanStatus,
} from "@/services/api/financeSubscriptionsClient";
import {
  GlobeAltIcon,
  PhoneIcon,
  ChatBubbleLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
  ArrowTopRightOnSquareIcon,
} from "@heroicons/react/24/outline";
import {
  settingsService,
  type BookingAcceptanceMode,
  type PropertySettings,
  type PropertySettingsUpdate,
  type SameDayBookingSettings,
} from "@/services/settings";
import { ToggleSwitch, FeedbackAlert, SaveButton } from "@/components/ui";
import LocalizationTab from "@/components/booking-flow/LocalizationTab";
import {
  localizationWriteSettled,
  useLocalizationSettingsTab,
} from "@/components/booking-flow/useBookingFlowSettingsTabs";
import { getBookingLocalizationSettings } from "@/services/api/bookingLocalizationSettingsClient";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { SettingsSection, SettingsCard } from "@vayada/settings-ui";
import { SameDayBookingCard } from "@/components/settings/SameDayBookingCard";
import { useTranslation } from "@/lib/i18n";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import type { SettingsPageId } from "@/lib/utils/settingsSectionUrl";
import { continueStripeAfterSavingSettings } from "@/lib/utils/stripeOnboarding";
import { fixedPlanUnitPrices, formatBillingAmount } from "@/lib/utils/fixedPlanPricing";
import {
  normalizePropertyDescription,
  PROPERTY_DESCRIPTION_MAX_LENGTH,
  propertyDescriptionLength,
  savePropertyDescription,
} from "@/lib/utils/propertyDescription";
import {
  coordinateStripeRefresh,
  refreshStripeAfterOnboarding,
  tryMarkStripeOnboardingStarted,
  watchStripeOnboardingRefresh,
} from "@/lib/utils/stripeOnboardingRefresh";

// Billing = what the hotel pays Vayada; payments = how the hotel collects from guests (VAY-400).
type Section = SettingsPageId;

const PAGE_TITLES: Record<Section, string> = {
  general: "settings.cards.general.title",
  "booking-rules": "settings.cards.bookingRules.title",
  policies: "settings.cards.policies.title",
  payments: "admin.payments",
  billing: "settings.tabs.billing",
};

const STRIPE_DASHBOARD_ERROR = "admin.couldnTOpenYourStripeDashboardRightNowPleaseTry";

// VAY-2424 Step 2, as in Timo's mockup.
const PAYMENT_PROVIDERS = [
  {
    id: "vayada",
    name: "settings.billing.providerVayada",
    desc: "settings.billing.providerVayadaDesc",
  },
  {
    id: "stripe",
    name: "settings.billing.providerStripe",
    desc: "settings.billing.providerStripeDesc",
  },
  {
    id: "xendit",
    name: "settings.billing.providerXendit",
    desc: "settings.billing.providerXenditDesc",
  },
] as const;
type ProviderStatus = "connected" | "pending" | "not_connected";
const PROVIDER_STATUS_TEXT: Record<ProviderStatus, string> = {
  connected: "settings.billing.connected",
  pending: "settings.payments.setupNotFinished",
  not_connected: "settings.payments.notConnected",
};
const PRIMARY_BUTTON =
  "inline-flex h-11 items-center gap-2 rounded-lg bg-primary-600 px-[18px] text-sm font-semibold text-white transition-colors hover:bg-primary-700 disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50";
const STRIPE_NOT_CONNECTED = "admin.yourStripeAccountIsnTConnectedConnectStripeInYour";

function readBookingHotelId(settings: PropertySettings): string {
  if (settings.id?.trim()) return settings.id.trim();
  if (typeof window === "undefined") return "";
  return localStorage.getItem("selectedHotelId")?.trim() ?? "";
}

function isFinanceStripeReady(response: FinancePaymentSettingsResponse): boolean {
  const account = response.paymentSettings.providerAccount;
  return (
    account.provider === "stripe" &&
    account.status === "active" &&
    account.onboardingStatus === "completed" &&
    account.chargesEnabled &&
    account.payoutsEnabled &&
    account.capabilities.includes("card_payments")
  );
}

/** "$30 for the first active unit + $5 per additional unit · 6 active units", on two lines at most. */
function FixedPlanUnitPricing({
  planStatus,
  locale,
  t,
}: {
  planStatus: FinancePlanStatus;
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const prices = fixedPlanUnitPrices(planStatus.currency);
  const count = t(
    planStatus.activeRoomCount === 1 ? "admin.activeUnitCountOne" : "admin.activeUnitCount",
    { count: planStatus.activeRoomCount },
  );
  // Each part wraps as a whole, so a narrow card puts the count on the second line.
  return (
    <p className="text-[10px] text-gray-400 mt-0.5" data-testid="fixed-plan-unit-pricing">
      {prices && (
        <>
          <span className="inline-block">
            {t("admin.fixedPlanUnitPricing", {
              base: formatBillingAmount(prices.baseAmountMinor, planStatus.currency, locale, {
                whole: true,
              }),
              extra: formatBillingAmount(prices.extraUnitAmountMinor, planStatus.currency, locale, {
                whole: true,
              }),
            })}
          </span>{" "}
        </>
      )}
      <span className="inline-block">
        {prices && "· "}
        {count}
      </span>
    </p>
  );
}

function formatBillingDate(value: string | null, locale: string): string {
  return value
    ? new Date(value).toLocaleDateString(locale, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";
}

function toSettingsPaymentProvider(
  provider: string | null | undefined,
): "stripe" | "xendit" | "vayada" {
  if (provider === "xendit" || provider === "vayada") return provider;
  return "stripe";
}

function paymentPolicyText(policy: unknown, key: string): string {
  const value =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : "";
}

function paymentPolicyNumber(policy: unknown, key: string, fallback: number): number {
  const value =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const DEFAULT_SETTINGS: PropertySettings = {
  slug: "",
  property_name: "",
  reservation_email: "",
  phone_number: "",
  whatsapp_number: "",
  address: "",
  default_currency: "EUR",
  default_language: "en",
  supported_currencies: [],
  supported_languages: [],
  check_in_time: "15:00",
  check_out_time: "11:00",
  pay_at_property_enabled: false,
  pay_at_hotel_methods: ["cash", "card"],
  online_card_payment: false,
  bank_transfer: false,
  paypal_enabled: false,
  paypal_email: "",
  paypal_payment_window_hours: 24,
  free_cancellation_days: 7,
  email_notifications: true,
  new_booking_alerts: true,
  payment_alerts: true,
  ota_booking_alerts: false,
  billing_active_plan: "commission",
  billing_commission_rate: 5,
  billing_fixed_fee: 49,
  billing_pending_switch: null,
  billing_switch_effective_date: null,
  payout_account_holder: "",
  payout_account_type: "iban",
  payout_iban: "",
  payout_account_number: "",
  payout_bank_name: "",
  payout_swift: "",
  terms_text: "",
  cancellation_policy_text: "",
};

type TargetSettingsUpdate =
  | { ok: true; data: PropertySettingsUpdate }
  | { ok: false; message: string };

function buildTargetSettingsUpdate(
  section: Section,
  settings: PropertySettings,
): TargetSettingsUpdate {
  if (section === "general") {
    return {
      ok: true,
      // Name and address belong to the shared property profile, saved separately.
      data: {
        reservation_email: settings.reservation_email,
        phone_number: settings.phone_number,
        whatsapp_number: settings.whatsapp_number,
        instagram: settings.instagram,
        facebook: settings.facebook,
        tiktok: settings.tiktok,
        youtube: settings.youtube,
      },
    };
  }

  if (section === "policies") {
    return {
      ok: true,
      data: {
        terms_text: settings.terms_text,
        cancellation_policy_text: settings.cancellation_policy_text,
      },
    };
  }

  return { ok: false, message: "admin.thisSettingsSectionIsNotSavedByPropertySettings" };
}

export default function SettingsSectionPage({ section: activeSection }: { section: Section }) {
  const { t, locale } = useTranslation();
  const [settings, setSettings] = useState<PropertySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acceptanceMode, setAcceptanceMode] = useState<BookingAcceptanceMode | null>(null);
  const [acceptanceLoading, setAcceptanceLoading] = useState(true);
  const [acceptanceSaving, setAcceptanceSaving] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState("");
  const [sameDaySettings, setSameDaySettings] = useState<SameDayBookingSettings | null>(null);
  const [sameDayLoading, setSameDayLoading] = useState(true);
  const [sameDaySaving, setSameDaySaving] = useState(false);
  const [sameDayError, setSameDayError] = useState("");
  // Billing, payout accounts and the guests' bank account are the owner's (VAY-2401). Null until
  // known, and when it can't be read: the API refuses staff either way.
  const [ownerFinance, setOwnerFinance] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
    retry?: boolean;
  } | null>(null);
  const [localizationLoading, setLocalizationLoading] = useState(true);
  const [localizationLoadError, setLocalizationLoadError] = useState("");
  const localizationLoadVersion = useRef(0);
  const getBookingHotelIdForLocalization = useCallback(() => {
    const hotelId = readBookingHotelId(settings);
    if (!hotelId) throw new Error(t("admin.bookingHotelIdIsRequired"));
    return hotelId;
  }, [settings, t]);
  const {
    defaultCurrency,
    setDefaultCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    propertyCurrency,
    savingCurrencyLang,
    applyLocalizationSettings,
    handleSaveCurrencyLang,
  } = useLocalizationSettingsTab({
    getBookingHotelIdForSave: getBookingHotelIdForLocalization,
    showFeedback: (type, message) => setFeedback({ type, message }),
  });
  // Stripe Connect / Payments
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [stripeOnboarded, setStripeOnboarded] = useState(false);
  const [openingStripeDashboard, setOpeningStripeDashboard] = useState(false);
  const [stripeDashboardToast, setStripeDashboardToast] = useState("");
  const [connectEmail] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("userEmail") || "" : "",
  );
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [issuingStripeOnboardingLink, setIssuingStripeOnboardingLink] = useState(false);
  const stripeOnboardingLinkPending = useRef(false);
  const [refreshingStripe, setRefreshingStripe] = useState(false);
  const stripeRefreshAbort = useRef<AbortController | null>(null);
  const paymentSettingsLoadVersion = useRef(0);
  const [stripeAccountCreationBlocked, setStripeAccountCreationBlocked] = useState(false);
  const [paymentProvider, setPaymentProvider] = useState<"stripe" | "xendit" | "vayada">("stripe");
  const [paymentError, setPaymentError] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const bankSaveAttempt = useRef<BankTransferSaveAttempt>({});
  const [bankDestination, setBankDestination] = useState<SavedBankTransferDestination | null>(null);
  // VAY-2442: vayada Payment can be chosen only while the server says so.
  const [vayadaPayment, setVayadaPayment] = useState<{
    available: boolean;
    feePercent?: number;
  } | null>(null);
  // VAY-2442: whether the hotel saved a payout account (the panel tells).
  const [vayadaPayoutSaved, setVayadaPayoutSaved] = useState<boolean | null>(null);
  // VAY-2442: card readiness said yes for vayada Payment as saved (unknown counts as no).
  const [vayadaCardReady, setVayadaCardReady] = useState(false);
  const [paymentSettingsLoaded, setPaymentSettingsLoaded] = useState(false);
  // Finance's currency, the PMS pricing currency guests pay in; not Localization's (VAY-2390).
  const [paymentCurrency, setPaymentCurrency] = useState<string | null>(null);
  // The saved row has setup's plain Pay at Hotel, without a Cash/Card choice (VAY-2185).
  const [plainPayAtHotel, setPlainPayAtHotel] = useState(false);
  const [billingPropertyId, setBillingPropertyId] = useState<string | null>(null);
  // VAY-2424: the payment choices as saved, so one Save sends only what changed and Discard
  // puts the form back; the booking windows' state lives here for the same Save.
  const [paymentBaseline, setPaymentBaseline] = useState<PaymentsForm | null>(null);
  const [paymentsSaveStatus, setPaymentsSaveStatus] = useState<PaymentsSaveStatus | null>(null);
  const paymentsSaveRunning = useRef(false);
  const paymentWindows = usePaymentWindows(activeSection === "payments" ? billingPropertyId : null);
  // VAY-2424: why guests can't use Credit card yet once Stripe is connected (null: ready, or
  // unknown because the read failed).
  const [cardNotReady, setCardNotReady] = useState<CardNotReadyReason | null>(null);
  const [savedPropertyName, setSavedPropertyName] = useState("");
  // Null until the public profile loads, so a failed read can never save over the text.
  const [savedDescription, setSavedDescription] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [descriptionLoadError, setDescriptionLoadError] = useState("");
  const [financePlanStatus, setFinancePlanStatus] = useState<FinancePlanStatus | null>(null);
  const [billingPlanLoading, setBillingPlanLoading] = useState(true);
  const [billingPlanAction, setBillingPlanAction] = useState<
    "checkout" | "portal" | "commission" | null
  >(null);
  const [billingPlanModal, setBillingPlanModal] = useState<"fixed" | "commission" | null>(null);
  const [billingPlanError, setBillingPlanError] = useState("");
  const [billingPlanConfirmation, setBillingPlanConfirmation] = useState("");

  const fetchSettings = useCallback(async (): Promise<PropertySettings | null> => {
    try {
      setLoading(true);
      const data = await settingsService.getPropertySettings();
      setSettings(data);
      setSavedPropertyName(data.property_name);
      return data;
    } catch {
      setFeedback({ type: "error", message: "settings.feedback.loadError" });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBookingAcceptance = useCallback(async (hotelId: string) => {
    setAcceptanceLoading(true);
    setAcceptanceMode(null);
    setAcceptanceError("");
    try {
      const result = await settingsService.getBookingAcceptance(hotelId);
      setAcceptanceMode(result.acceptanceMode);
    } catch {
      setAcceptanceError("admin.bookingAcceptanceSettingsFailedToLoad");
    } finally {
      setAcceptanceLoading(false);
    }
  }, []);

  const loadSameDayBooking = useCallback(async (hotelId: string) => {
    setSameDayLoading(true);
    setSameDaySettings(null);
    setSameDayError("");
    try {
      setSameDaySettings(await settingsService.getSameDayBooking(hotelId));
    } catch {
      setSameDayError("admin.sameDayBookingSettingsFailedToLoad");
    } finally {
      setSameDayLoading(false);
    }
  }, []);

  const loadLocalizationSettings = useCallback(
    async (hotelId: string) => {
      if (hotelId !== getSelectedBookingHotelId()) return;
      const loadVersion = ++localizationLoadVersion.current;
      const isCurrentLoad = () =>
        loadVersion === localizationLoadVersion.current && hotelId === getSelectedBookingHotelId();
      setLocalizationLoading(true);
      setLocalizationLoadError("");
      try {
        await localizationWriteSettled();
        if (!isCurrentLoad()) return;
        const localization = await getBookingLocalizationSettings({ hotelId });
        if (!isCurrentLoad()) return;
        applyLocalizationSettings(localization);
      } catch {
        if (!isCurrentLoad()) return;
        setLocalizationLoadError("admin.localizationSettingsFailedToLoad");
      } finally {
        if (isCurrentLoad()) setLocalizationLoading(false);
      }
    },
    [applyLocalizationSettings],
  );

  const applyFinancePaymentSettings = useCallback((res: FinancePaymentSettingsResponse) => {
    const ps = res.paymentSettings;
    const providerAccount = ps.providerAccount;
    const stripeAccountId =
      providerAccount.provider === "stripe" &&
      !providerAccount.providerAccountId?.startsWith("settings-choice:")
        ? providerAccount.providerAccountId
        : null;
    setStripeAccountId(stripeAccountId);
    setStripeOnboarded(isFinanceStripeReady(res));
    const saved: PaymentsForm = {
      payAtProperty: ps.acceptedMethods.includes("pay_at_property"),
      payAtHotelMethods: payAtHotelMethodsFromFinance(ps.acceptedMethods),
      onlineCard: ps.acceptedMethods.includes("card") || ps.acceptedMethods.includes("xendit"),
      bankTransfer: ps.acceptedMethods.includes("bank_transfer"),
      paypal: ps.acceptedMethods.includes("paypal"),
      paypalEmail: paymentPolicyText(ps.depositPolicy, "paypalEmail"),
      paypalHours: paymentPolicyNumber(ps.depositPolicy, "paypalPaymentWindowHours", 24),
      provider: toSettingsPaymentProvider(ps.paymentProvider),
    };
    setPaymentBaseline(saved);
    setPaymentProvider(saved.provider);
    setSettings((prev) => ({ ...prev, ...paymentsFormFields(saved) }));
    setBankDestination(res.bankDestination ?? null);
    setVayadaPayment(res.vayadaPayment ?? null);
    setPaymentCurrency(ps.defaultCurrency);
    setPlainPayAtHotel(isPlainPayAtHotel(ps.acceptedMethods));
    setPaymentSettingsLoaded(true);
  }, []);

  useEffect(() => {
    const paymentSettingsVersion = ++paymentSettingsLoadVersion.current;
    const selectedHotelId = getSelectedBookingHotelId();
    const stripeReturn = new URLSearchParams(window.location.search).get("stripe");
    if (stripeReturn === "return" || stripeReturn === "refresh") {
      setStripeAccountCreationBlocked(true);
    }
    setPaymentSettingsLoaded(false);
    setPaymentCurrency(null);
    setPaymentBaseline(null);
    setPaymentsSaveStatus(null);
    setBillingPlanLoading(true);
    setAcceptanceLoading(true);
    setAcceptanceMode(null);
    setAcceptanceError("");
    setSameDayLoading(true);
    setSameDaySettings(null);
    setSameDayError("");
    if (selectedHotelId) void loadLocalizationSettings(selectedHotelId);
    const propertyPromise = fetchSettings();
    propertyPromise
      .then(async (property) => {
        if (!property) {
          setBillingPlanLoading(false);
          setAcceptanceLoading(false);
          setAcceptanceError("admin.selectAHotelBeforeLoadingBookingAcceptanceSettings");
          setSameDayLoading(false);
          setSameDayError("admin.selectAHotelBeforeLoadingSameDayBookingSettings");
          if (!selectedHotelId) {
            setLocalizationLoading(false);
            setLocalizationLoadError("admin.selectAHotelBeforeLoadingLocalizationSettings");
          }
          return null;
        }
        const hotelId = readBookingHotelId(property);
        if (!hotelId) {
          setBillingPlanLoading(false);
          setAcceptanceLoading(false);
          setAcceptanceError("admin.selectAHotelBeforeLoadingBookingAcceptanceSettings");
          setSameDayLoading(false);
          setSameDayError("admin.selectAHotelBeforeLoadingSameDayBookingSettings");
          if (!selectedHotelId) {
            setLocalizationLoading(false);
            setLocalizationLoadError("admin.selectAHotelBeforeLoadingLocalizationSettings");
          }
          return null;
        }
        void loadBookingAcceptance(hotelId);
        void loadSameDayBooking(hotelId);
        if (hotelId !== selectedHotelId) void loadLocalizationSettings(hotelId);
        const propertyLink = await getBookingHotelPropertyLink({ hotelId });
        // A slower lookup for the hotel shown before must not win.
        if (paymentSettingsVersion !== paymentSettingsLoadVersion.current) return null;
        setBillingPropertyId(propertyLink.propertyId);
        const billingReturn =
          typeof window === "undefined"
            ? null
            : new URLSearchParams(window.location.search).get("billing");
        const paymentSettingsPromise = getFinancePaymentSettings({
          propertyId: propertyLink.propertyId,
        });
        const planStatusPromise = (async () => {
          try {
            let plan = await getFinancePlanStatus(propertyLink.propertyId);
            if (billingReturn === "success") {
              for (
                let attempt = 0;
                attempt < 10 && plan.planStatus.plan !== "fixed";
                attempt += 1
              ) {
                await new Promise((resolve) => window.setTimeout(resolve, 1_000));
                plan = await getFinancePlanStatus(propertyLink.propertyId);
              }
              setBillingPlanConfirmation(
                plan.planStatus.plan === "fixed"
                  ? "admin.fixedPlanIsActive"
                  : "admin.paymentReceivedYourFixedPlanIsStillBeingConfirmed",
              );
            } else if (billingReturn === "canceled") {
              setBillingPlanError("admin.paymentFailedPleaseTryAgainOrUseADifferentCard");
            }
            setFinancePlanStatus(plan.planStatus);
          } catch {
            setBillingPlanError("admin.billingPlanFailedToLoad");
          } finally {
            setBillingPlanLoading(false);
          }
        })();
        const [, paymentSettings] = await Promise.all([planStatusPromise, paymentSettingsPromise]);
        return paymentSettings;
      })
      .then((paymentSettings) => {
        if (paymentSettingsVersion !== paymentSettingsLoadVersion.current) return;
        if (!paymentSettings) {
          setPaymentSettingsLoaded(true);
          return;
        }
        applyFinancePaymentSettings(paymentSettings);
      })
      .catch(() => {
        if (paymentSettingsVersion !== paymentSettingsLoadVersion.current) return;
        setPaymentSettingsLoaded(false);
        setBillingPlanLoading(false);
        setPaymentError("admin.paymentSettingsFailedToLoad");
      });
  }, [
    applyFinancePaymentSettings,
    fetchSettings,
    loadBookingAcceptance,
    loadLocalizationSettings,
    loadSameDayBooking,
  ]);

  const refreshStripeOnboarding = useCallback(
    async (
      flowId?: string,
      mode: "reconcile" | "reload" = "reconcile",
    ): Promise<"settled" | "aborted"> => {
      if (!billingPropertyId || stripeRefreshAbort.current) return "aborted";
      const controller = new AbortController();
      stripeRefreshAbort.current = controller;
      const paymentSettingsVersion = ++paymentSettingsLoadVersion.current;
      setStripeAccountCreationBlocked(true);
      setRefreshingStripe(true);
      // An earlier error stays until this check settles, so Step 2 keeps its "couldn't be
      // confirmed" view (and the button just clicked) while it runs (VAY-2424).
      setPaymentSuccess("");
      try {
        const paymentSettings =
          mode === "reload"
            ? await getFinancePaymentSettings({ propertyId: billingPropertyId })
            : await coordinateStripeRefresh(
                {
                  propertyId: billingPropertyId,
                  flowId,
                  signal: controller.signal,
                  locks: navigator.locks,
                },
                {
                  run: async (claimedFlowId) => {
                    const result = await refreshStripeAfterOnboarding(
                      { propertyId: billingPropertyId, signal: controller.signal },
                      {
                        reconcile: (propertyId, attempt) =>
                          reconcileFinanceStripeProviderAccount({
                            propertyId,
                            commandId: `${claimedFlowId}:attempt:${attempt + 1}`,
                          }),
                        loadPaymentSettings: (propertyId) =>
                          getFinancePaymentSettings({ propertyId }),
                      },
                    );
                    return result.paymentSettings;
                  },
                  reload: () => getFinancePaymentSettings({ propertyId: billingPropertyId }),
                },
              );
        if (controller.signal.aborted) return "aborted";
        if (paymentSettingsVersion === paymentSettingsLoadVersion.current) {
          applyFinancePaymentSettings(paymentSettings);
        }
        if (isFinanceStripeReady(paymentSettings)) {
          setStripeAccountCreationBlocked(false);
          setPaymentError("");
          setPaymentSuccess("admin.stripeIsConnected");
        } else {
          setPaymentError("admin.stripeSetupIsStillPendingCompleteOnboardingOrCheckAgain");
        }
        return "settled";
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          return "aborted";
        }
        setPaymentError("admin.couldnTRefreshStripeStatusCheckAgainInAMoment");
        return "settled";
      } finally {
        if (stripeRefreshAbort.current === controller) {
          stripeRefreshAbort.current = null;
          setRefreshingStripe(false);
        }
      }
    },
    [applyFinancePaymentSettings, billingPropertyId],
  );

  useEffect(() => {
    if (!billingPropertyId) return;
    const search = new URLSearchParams(window.location.search);
    const stripeReturn = search.get("stripe");
    const isStripeReturn = stripeReturn === "return" || stripeReturn === "refresh";
    if (isStripeReturn) {
      search.delete("stripe");
      const query = search.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }
    const stopWatching = watchStripeOnboardingRefresh({
      propertyId: billingPropertyId,
      isStripeReturn,
      target: window,
      store: window.localStorage,
      onRefresh: (flowId, mode) => refreshStripeOnboarding(flowId, mode),
    });
    return () => {
      stopWatching();
      stripeRefreshAbort.current?.abort();
      stripeRefreshAbort.current = null;
    };
  }, [billingPropertyId, refreshStripeOnboarding]);

  // VAY-2424: Credit card as saved (the payments form's saved state).
  const cardSaved = paymentBaseline?.onlineCard ?? false;
  // VAY-2442: card through vayada Payment as saved: no Stripe account, Finance's readiness tells.
  const vayadaSaved = cardSaved && paymentBaseline?.provider === "vayada";
  // VAY-2424: with Stripe connected, what else still stops guests paying by card (the PMS rate
  // screens' card readiness). Read again after every save; a failed read shows no banner.
  useEffect(() => {
    setCardNotReady(null);
    setVayadaCardReady(false);
    if (
      activeSection !== "payments" ||
      !billingPropertyId ||
      !cardSaved ||
      (!stripeOnboarded && !vayadaSaved)
    )
      return;
    let current = true;
    // The PMS rate screens' read, on this page's API client like its other payment calls.
    Promise.resolve()
      .then(() =>
        createReplacementPricingClient(billingPropertyId, {
          http: apiClient,
          requestOptions: omitHotelContext,
          // No read (or no access) is unknown here, not "switched off": no banner.
          isNotFound: () => false,
          conflict: (detail) => new ApiErrorResponse(409, { code: "stale", detail }),
        }).cardReadiness(),
      )
      .then(
        ({ card }) => {
          // The page already shows this Stripe account as connected: something on the account
          // itself still stops it (e.g. Stripe's card capability), not a missing account.
          if (!current) return;
          // vayada Payment: with its payout account saved (checked below), what's left is Vayada's
          // approval, which Finance also reports as no account.
          if (vayadaSaved) setVayadaCardReady(card.ready);
          setCardNotReady(
            card.ready
              ? null
              : card.reason === "not_connected"
                ? vayadaSaved
                  ? "not_approved"
                  : "account_not_ready"
                : card.reason,
          );
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [activeSection, billingPropertyId, cardSaved, stripeOnboarded, vayadaSaved, paymentBaseline]);
  // A missing or unfinished account is the page's own knowledge: Finance's readiness can't tell a
  // missing account from a pending approval. Nothing is said while a Stripe check runs.
  // Stripe may hold an account this page couldn't confirm (back from Stripe, or a failed read):
  // Step 2 offers a check instead of a new account, and after a failed read, only the check.
  const stripeUnconfirmed =
    paymentProvider === "stripe" &&
    !stripeAccountId &&
    (stripeAccountCreationBlocked || !paymentSettingsLoaded);
  const stripeStatusUnknown = stripeUnconfirmed && !!paymentError;
  const cardNotReadyReason: CardNotReadyReason | null =
    !cardSaved || refreshingStripe
      ? null
      : vayadaSaved
        ? vayadaPayoutSaved === false
          ? "payout_account_missing"
          : vayadaPayoutSaved === null
            ? null
            : cardNotReady
        : stripeOnboarded
          ? cardNotReady
          : stripeAccountId
            ? "setup_incomplete"
            : // Not "connect one" while an account may exist: Step 2 offers the check.
              stripeUnconfirmed
              ? null
              : "not_connected";

  const handleAcceptanceToggle = async () => {
    const hotelId = readBookingHotelId(settings);
    if (!hotelId || !acceptanceMode) {
      setAcceptanceError("admin.loadTheCurrentBookingAcceptanceSettingBeforeChangingIt");
      return;
    }

    setAcceptanceSaving(true);
    setAcceptanceError("");
    try {
      const saved = await settingsService.updateBookingAcceptance(
        acceptanceMode === "instant" ? "request" : "instant",
        hotelId,
      );
      setAcceptanceMode(saved.acceptanceMode);
      setFeedback({ type: "success", message: "admin.bookingAcceptanceSettingsSaved" });
    } catch {
      setAcceptanceError("admin.bookingAcceptanceSettingsCouldNotBeSaved");
    } finally {
      setAcceptanceSaving(false);
    }
  };

  const retryBookingAcceptance = () => {
    const hotelId = readBookingHotelId(settings);
    if (hotelId) void loadBookingAcceptance(hotelId);
  };

  const saveSameDayBooking = async (enabled: boolean, cutoffLocalTime: string | null) => {
    const hotelId = readBookingHotelId(settings);
    if (!hotelId || !sameDaySettings) {
      setSameDayError("admin.loadTheCurrentSameDayBookingSettingBeforeChangingIt");
      return;
    }
    setSameDaySaving(true);
    setSameDayError("");
    setFeedback(null);
    try {
      setSameDaySettings(
        await settingsService.updateSameDayBooking(enabled, cutoffLocalTime, hotelId),
      );
      setFeedback({ type: "success", message: "admin.sameDayBookingSettingsSaved" });
    } catch {
      setSameDayError("admin.sameDayBookingSettingsCouldNotBeSaved");
    } finally {
      setSameDaySaving(false);
    }
  };

  const retrySameDayBooking = () => {
    const hotelId = readBookingHotelId(settings);
    if (hotelId) void loadSameDayBooking(hotelId);
  };

  const handleCreateStripeAccount = async () => {
    if (!connectEmail) return;
    const stripeTab = window.open("about:blank", "vayada-stripe-connect");
    if (!stripeTab) {
      setPaymentError("admin.allowPopUpsToContinueToStripeSetup");
      return;
    }
    stripeTab.opener = null;
    setCreatingAccount(true);
    setPaymentError("");
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId) {
        stripeTab.close();
        setPaymentError("admin.selectAHotelBeforeCreatingAStripeAccount");
        return;
      }
      let onboardingPropertyId = "";
      const result = await continueStripeAfterSavingSettings({
        saveSettings: () => savePayments(),
        continueStripe: (propertyId) => {
          onboardingPropertyId = propertyId;
          return createFinanceStripeProviderAccount({
            propertyId,
            email: connectEmail,
            commandPrefix: `settings-stripe-account-${hotelId}`,
          });
        },
      });
      if (!result) {
        stripeTab.close();
        return;
      }
      setStripeAccountId(result.providerAccountId);
      const trackingFlowId = tryMarkStripeOnboardingStarted(
        onboardingPropertyId,
        window.localStorage,
      );
      stripeTab.location.assign(result.onboardingUrl);
      if (!trackingFlowId) {
        setStripeAccountCreationBlocked(true);
        setPaymentError("admin.stripeSetupOpenedButAutomaticStatusTrackingIsUnavailableCheck");
      }
    } catch (err: unknown) {
      stripeTab.close();
      // The account opens in the hotel's address country (VAY-2424): say when it has none or
      // Stripe doesn't take it.
      const code = err instanceof FinancePaymentSettingsClientError ? err.code : "";
      const msg =
        err instanceof TypeError
          ? "settings.billing.errorPaymentServerUnreachable"
          : code === "property_country_missing"
            ? "settings.billing.errorStripeCountryMissing"
            : code === "provider_country_unsupported"
              ? "settings.billing.errorStripeCountryUnsupported"
              : "settings.billing.errorAccountCreate";
      setPaymentError(msg);
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleOnboarding = async () => {
    if (stripeOnboardingLinkPending.current) return;
    stripeOnboardingLinkPending.current = true;
    setIssuingStripeOnboardingLink(true);
    const stripeTab = window.open("about:blank", "vayada-stripe-connect");
    if (!stripeTab) {
      stripeOnboardingLinkPending.current = false;
      setIssuingStripeOnboardingLink(false);
      setPaymentError("admin.allowPopUpsToContinueToStripeSetup");
      return;
    }
    stripeTab.opener = null;
    try {
      const hotelId = readBookingHotelId(settings);
      if (!hotelId || !stripeAccountId) {
        stripeTab.close();
        setPaymentError("admin.selectAHotelAndCreateAStripeAccountBeforeOnboarding");
        return;
      }
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      const link = await issueFinanceStripeOnboardingLink({
        propertyId: propertyLink.propertyId,
        providerAccountId: stripeAccountId,
        commandPrefix: `settings-stripe-onboarding-${hotelId}`,
      });
      const trackingFlowId = tryMarkStripeOnboardingStarted(
        propertyLink.propertyId,
        window.localStorage,
      );
      stripeTab.location.assign(link.onboardingUrl);
      if (!trackingFlowId) {
        setStripeAccountCreationBlocked(true);
        setPaymentError("admin.stripeSetupOpenedButAutomaticStatusTrackingIsUnavailableCheck");
      }
    } catch {
      stripeTab.close();
      setPaymentError("settings.billing.errorOnboardingLink");
    } finally {
      stripeOnboardingLinkPending.current = false;
      setIssuingStripeOnboardingLink(false);
    }
  };

  const handleStripeDashboard = async () => {
    setStripeDashboardToast("");
    if (!billingPropertyId || !stripeAccountId) {
      setStripeDashboardToast(STRIPE_NOT_CONNECTED);
      return;
    }

    const stripeTab = window.open("about:blank", "_blank");
    if (!stripeTab) {
      setStripeDashboardToast(STRIPE_DASHBOARD_ERROR);
      return;
    }
    stripeTab.opener = null;
    setOpeningStripeDashboard(true);
    try {
      const { url } = await createFinanceStripeDashboardLink({
        propertyId: billingPropertyId,
      });
      stripeTab.location.assign(url);
    } catch (error) {
      stripeTab.close();
      setStripeDashboardToast(
        error instanceof FinancePaymentSettingsClientError &&
          error.code === "provider_account_not_found"
          ? STRIPE_NOT_CONNECTED
          : STRIPE_DASHBOARD_ERROR,
      );
    } finally {
      setOpeningStripeDashboard(false);
    }
  };

  // VAY-2424: Credit card has a payment account with the provider chosen in Step 2; without one,
  // guests don't see it.
  const cardConnected =
    paymentProvider === "stripe"
      ? stripeOnboarded
      : paymentProvider === "vayada" && vayadaPayoutSaved === true;
  // Said only once known: not while the settings load or Stripe is checked, nor before the vayada
  // Payment panel has read the payout account.
  const cardHidden =
    paymentSettingsLoaded &&
    !refreshingStripe &&
    !cardConnected &&
    !(
      paymentProvider === "vayada" &&
      vayadaPayment?.available === true &&
      vayadaPayoutSaved === null
    );
  const providerStatus: ProviderStatus | null =
    paymentProvider === "stripe"
      ? stripeOnboarded
        ? "connected"
        : stripeAccountId
          ? "pending"
          : stripeUnconfirmed
            ? null
            : "not_connected"
      : paymentProvider === "vayada" && vayadaPayment?.available
        ? vayadaPayoutSaved === null
          ? null
          : vayadaPayoutSaved
            ? "connected"
            : "not_connected"
        : "not_connected";
  // VAY-2424 "What guests will see": Step 1 as it stands; Credit card counts once a payment
  // account can take it.
  // The readiness read is about the saved provider: it counts only while that is still chosen.
  const savedCardProvider = cardSaved && paymentBaseline?.provider === paymentProvider;
  const previewMethods: PreviewMethods = {
    card: settings.online_card_payment ?? false,
    pay_at_property: settings.pay_at_property_enabled,
    bank_transfer: settings.bank_transfer ?? false,
    paypal: settings.paypal_enabled ?? false,
    paypalHours: Math.max(1, Math.min(168, settings.paypal_payment_window_hours || 24)),
    cardReady:
      paymentProvider === "stripe"
        ? stripeOnboarded && (!savedCardProvider || cardNotReady === null)
        : paymentProvider === "vayada" &&
          savedCardProvider &&
          vayadaPayoutSaved === true &&
          vayadaCardReady,
    // Guests get the bank details after booking: an active account, or complete new details.
    bankReady:
      (!!bankDestination?.enabled && !bankDestination.deleted) ||
      (bankDetailsEdited(settings) &&
        !bankTransferDetailsIncomplete({
          enabled: true,
          details: bankDetailsOf(settings),
          saved: bankDestination,
        })),
  };
  // VAY-2424: what changed on Payments, against what was saved.
  const paymentsForm = paymentsFormOf(settings, paymentProvider);
  const paymentMethodsChanged =
    paymentBaseline !== null && !samePaymentsForm(paymentsForm, paymentBaseline);
  const bankDetailsChanged = (settings.bank_transfer ?? false) && bankDetailsEdited(settings);
  // The windows of the ways switched on in Step 1 are saved, offered to guests yet or not.
  const windowsPlan =
    paymentWindows.saved && paymentWindows.drafts
      ? paymentWindowsPlan(
          {
            card: settings.online_card_payment ?? false,
            pay_at_property: settings.pay_at_property_enabled,
            bank_transfer: settings.bank_transfer ?? false,
            paypalHours: null,
          },
          paymentWindows.saved,
          paymentWindows.drafts,
        )
      : null;
  const paymentsChanged =
    paymentMethodsChanged || bankDetailsChanged || (windowsPlan?.changed ?? false);
  // Saving before the stored settings and windows load would write the form's defaults.
  const paymentsReady =
    paymentSettingsLoaded &&
    paymentBaseline !== null &&
    (!!windowsPlan || paymentWindows.loadError) &&
    !refreshingStripe;

  /**
   * VAY-2424: one Save for the page, on today's three endpoints. Everything is checked before
   * anything is sent; then bank details, payment settings and booking windows are saved in that
   * order, each only when it changed. The first failure stops the rest: what saved becomes the
   * new saved state, and the page says what saved and what didn't. Returns the property id when
   * everything is saved (Stripe Connect continues from there).
   */
  const savePayments = async (): Promise<string | null> => {
    // One save at a time (Save and Connect Stripe both run it).
    if (paymentsSaveRunning.current) return null;
    setPaymentsSaveStatus(null);
    setPaymentError("");
    setPaymentSuccess("");
    const refuse = (message: string, params?: Record<string, string | number>) => {
      setPaymentsSaveStatus({ kind: "invalid", message, params });
      return null;
    };
    if (!paymentsReady || !paymentCurrency || !paymentBaseline) {
      return refuse("admin.paymentSettingsDidNotLoadRefreshBeforeSavingPayments");
    }
    // Only a change to the methods sends the provider; windows and bank details still save.
    if (
      paymentMethodsChanged &&
      settings.online_card_payment &&
      (paymentProvider === "xendit" ||
        (paymentProvider === "vayada" && vayadaPayment?.available !== true))
    ) {
      return refuse("settings.billing.comingSoon");
    }
    const hotelId = readBookingHotelId(settings);
    if (!hotelId) return refuse("admin.selectAHotelBeforeSavingPaymentSettings");
    // Plain still means what the page shows (Cash and Card), so it goes back unchanged.
    const keepPlain =
      plainPayAtHotel &&
      settings.pay_at_property_enabled &&
      settings.pay_at_hotel_methods.includes("cash") &&
      settings.pay_at_hotel_methods.includes("card");
    const settingsBody = (keepPlainPayAtHotel: boolean) =>
      buildFinancePaymentSettingsBody({
        payAtPropertyEnabled: settings.pay_at_property_enabled,
        payAtHotelMethods: settings.pay_at_hotel_methods,
        keepPlainPayAtHotel,
        onlineCardPayment: settings.online_card_payment ?? false,
        bankTransfer: settings.bank_transfer ?? false,
        paypalEnabled: settings.paypal_enabled ?? false,
        paypalEmail: settings.paypal_email,
        paypalPaymentWindowHours: settings.paypal_payment_window_hours,
        paymentProvider,
        defaultCurrency: paymentCurrency,
        commandPrefix: `settings-payment-settings-${hotelId}`,
      });
    const bankDetails = bankDetailsOf(settings);
    // The owner-only bank account is touched only when bank transfer or its details changed.
    const bankChanged =
      (settings.bank_transfer ?? false) !== paymentBaseline.bankTransfer || bankDetailsChanged;
    const windowsToSave = windowsPlan?.changed ? windowsPlan.next : null;
    // 1. Check everything first.
    if (windowsPlan?.invalid) return refuse("settings.paymentsSave.fixWindows");
    if (
      bankChanged &&
      bankTransferDetailsIncomplete({
        enabled: settings.bank_transfer ?? false,
        details: bankDetails,
        saved: bankDestination,
      })
    ) {
      return refuse("admin.enterTheCompleteBankDetailsOrLeaveAllFieldsEmpty");
    }
    if (paymentMethodsChanged) {
      try {
        settingsBody(keepPlain);
      } catch (error) {
        return refuse(paymentSaveError(error).message);
      }
    }

    // 2. Save what changed, in order. A reload meanwhile (another hotel, a Stripe check) brings
    // the server's state; what this save learned is then not applied over it.
    paymentsSaveRunning.current = true;
    setSavingPayment(true);
    const loadVersion = paymentSettingsLoadVersion.current;
    const current = () => loadVersion === paymentSettingsLoadVersion.current;
    const saved: PaymentsPart[] = [];
    let part: PaymentsPart = "bank";
    try {
      const propertyLink = await getBookingHotelPropertyLink({ hotelId });
      const destination = bankChanged
        ? await saveBankTransferDestination(
            {
              get: (path) => apiClient.get(path, omitHotelContext),
              put: (path, body) => apiClient.put(path, body, omitHotelContext),
            },
            {
              propertyId: propertyLink.propertyId,
              enabled: settings.bank_transfer ?? false,
              saved: bankDestination,
              attempt: bankSaveAttempt.current,
              details: bankDetails,
            },
          )
        : bankDestination;
      if (destination !== bankDestination && current()) {
        saved.push("bank");
        setBankDestination(destination ?? null);
        setSettings((previous) => ({
          ...previous,
          payout_account_holder: "",
          payout_account_number: "",
          payout_iban: "",
          payout_bank_name: "",
          payout_swift: "",
        }));
      }

      part = "methods";
      if (paymentMethodsChanged) {
        const save = (keepPlainPayAtHotel: boolean) =>
          updateFinancePaymentSettings({
            propertyId: propertyLink.propertyId,
            body: settingsBody(keepPlainPayAtHotel),
          });
        let keptPlain = keepPlain;
        try {
          await save(keptPlain);
        } catch (error) {
          // An old row setup never saved needs the choice spelled out: send the Cash + Card shown.
          if (!keptPlain || !needsExplicitPayAtHotelChoice(error)) throw error;
          keptPlain = false;
          await save(false);
        }
        saved.push("methods");
        if (!current()) return null;
        setPaymentBaseline(paymentsForm);
        setPlainPayAtHotel(keptPlain);
      }

      part = "windows";
      if (windowsToSave) {
        const response = await savePaymentMethodWindows({
          propertyId: propertyLink.propertyId,
          windows: windowsToSave,
        });
        saved.push("windows");
        if (!current()) return null;
        paymentWindows.apply(response.windows);
      } else {
        // A way switched off keeps its saved window: drop what was picked for it meanwhile.
        paymentWindows.discard();
      }
      if (!current()) return null;
      // "Saved" only when something was sent (Connect Stripe saves first, often nothing).
      setPaymentsSaveStatus(saved.length ? { kind: "saved" } : null);
      return propertyLink.propertyId;
    } catch (error) {
      const windowsMessage =
        part === "windows" && windowsToSave ? paymentWindowsSaveError(error, windowsToSave) : null;
      const { message, retry } = paymentSaveError(error);
      setPaymentsSaveStatus({
        kind: "failed",
        saved,
        failed: part,
        message: windowsMessage ?? message,
        params: windowsMessage ? { hours: paymentWindows.deadlineHours } : undefined,
        retry: !windowsMessage && retry,
      });
      return null;
    } finally {
      paymentsSaveRunning.current = false;
      setSavingPayment(false);
    }
  };

  const saveBarMessage = paymentsChanged
    ? t("settings.paymentsSave.unsaved")
    : paymentsSaveStatus?.kind === "saved"
      ? t("settings.billing.paymentSettingsSaved")
      : "";
  // As in the mockup the save bar goes once saved: "saved" shows for a few seconds first.
  useEffect(() => {
    if (paymentsSaveStatus?.kind !== "saved") return;
    const timer = window.setTimeout(
      () => setPaymentsSaveStatus((status) => (status?.kind === "saved" ? null : status)),
      4000,
    );
    return () => window.clearTimeout(timer);
  }, [paymentsSaveStatus]);

  const discardPayments = () => {
    if (!paymentBaseline) return;
    setSettings((previous) => ({ ...previous, ...paymentsFormFields(paymentBaseline) }));
    setPaymentProvider(paymentBaseline.provider);
    paymentWindows.discard();
    setPaymentsSaveStatus(null);
  };

  useEffect(() => {
    if (activeSection !== "billing" && activeSection !== "payments") return;
    let cancelled = false;
    getStaffSelfAccess().then(
      (access) => {
        if (!cancelled) setOwnerFinance(canManageOwnerFinance(access));
      },
      (error) => console.error("Could not read this member's access", error),
    );
    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  // The footer description is setup's hotel summary in the public profile (VAY-2142).
  useEffect(() => {
    if (activeSection !== "general" || !billingPropertyId) return;
    let cancelled = false;
    setDescriptionLoadError("");
    sharedHotelSetupApi.getPublicPropertyProfile(billingPropertyId).then(
      (profile) => {
        if (cancelled) return;
        const text = profile.publicProfile.shortDescription ?? "";
        setSavedDescription(text);
        setDescription(text);
      },
      (error: unknown) => {
        if (cancelled) return;
        const forbidden = (error as { status?: unknown } | null)?.status === 403;
        setDescriptionLoadError(
          forbidden
            ? "settings.property.descriptionNoAccess"
            : "settings.property.descriptionLoadError",
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeSection, billingPropertyId]);

  // The property name lives in the shared property profile (hotel setup, PMS). Only the
  // owner can rename, and the profile must be complete, so it is saved last and on its own.
  const savePropertyName = async (name: string): Promise<string> => {
    if (!billingPropertyId) throw new Error("The property link is unavailable.");
    const current = await sharedHotelSetupApi.getPropertyProfile(billingPropertyId);
    if (current.profile.displayName === name) return name;
    const saved = await sharedHotelSetupApi.updatePropertyProfile(billingPropertyId, {
      expectedProfileRevision: current.profileRevision,
      patch: { displayName: name },
    });
    return saved.profile.displayName;
  };

  const handleSave = async () => {
    if (activeSection === "payments") {
      setFeedback(null);
      await savePayments();
      return;
    }

    const paypalEmail = (settings.paypal_email || "").trim();
    const normalizedSettings =
      paypalEmail === (settings.paypal_email || "")
        ? settings
        : { ...settings, paypal_email: paypalEmail };
    const targetSettingsUpdate = buildTargetSettingsUpdate(activeSection, normalizedSettings);
    if (!targetSettingsUpdate.ok) {
      setFeedback({ type: "error", message: targetSettingsUpdate.message });
      return;
    }
    const descriptionChanged =
      activeSection === "general" &&
      savedDescription !== null &&
      description.trim() !== savedDescription.trim();
    const nextDescription = descriptionChanged ? normalizePropertyDescription(description) : null;
    if (descriptionChanged && !nextDescription) {
      setFeedback({ type: "error", message: "settings.property.descriptionLengthError" });
      return;
    }

    try {
      setSaving(true);
      setFeedback(null);
      // Saved before the settings: their save refreshes a live booking page with this text.
      if (nextDescription && billingPropertyId) {
        try {
          const savedText = await savePropertyDescription(
            sharedHotelSetupApi,
            billingPropertyId,
            nextDescription,
          );
          setSavedDescription(savedText);
          setDescription(savedText);
        } catch {
          setFeedback({ type: "error", message: "settings.feedback.propertyDescriptionNotSaved" });
          return;
        }
      }
      const data = await settingsService.updatePropertySettings(targetSettingsUpdate.data);
      // Apply only what was saved: this response carries placeholder payment settings.
      const saved = Object.keys(targetSettingsUpdate.data);
      if (activeSection === "general") saved.push("address");
      setSettings((previous) => ({
        ...previous,
        ...Object.fromEntries(saved.map((key) => [key, data[key as keyof PropertySettings]])),
      }));
      const name = normalizedSettings.property_name.trim();
      if (activeSection === "general" && name !== savedPropertyName.trim()) {
        try {
          const savedName = await savePropertyName(name);
          setSavedPropertyName(savedName);
          setSettings((previous) => ({ ...previous, property_name: savedName }));
        } catch {
          setFeedback({ type: "error", message: "settings.feedback.propertyNameNotSaved" });
          return;
        }
      }
      setFeedback({ type: "success", message: "settings.feedback.saveSuccess" });
    } catch {
      setFeedback({ type: "error", message: "settings.feedback.saveError" });
    } finally {
      setSaving(false);
    }
  };

  const startFixedPlanCheckout = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("checkout");
      setBillingPlanError("");
      const result = await createFixedPlanCheckout({
        propertyId: billingPropertyId,
      });
      window.location.assign(result.checkout.checkoutUrl);
    } catch {
      setBillingPlanModal(null);
      setBillingPlanError("admin.paymentFailedPleaseTryAgainOrUseADifferentCard");
    } finally {
      setBillingPlanAction(null);
    }
  };

  const manageFixedPlanBilling = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("portal");
      setBillingPlanError("");
      const result = await openFinanceCustomerPortal({ propertyId: billingPropertyId });
      window.location.assign(result.customerPortal.portalUrl);
    } catch {
      setBillingPlanError("admin.stripeBillingCouldNotBeOpened");
    } finally {
      setBillingPlanAction(null);
    }
  };

  const scheduleCommissionPlan = async () => {
    if (!billingPropertyId) return;
    try {
      setBillingPlanAction("commission");
      setBillingPlanError("");
      const result = await switchToCommissionPlan({ propertyId: billingPropertyId });
      setFinancePlanStatus(result.planStatus);
      setBillingPlanModal(null);
      setBillingPlanConfirmation(
        t("admin.yourFixedPlanRemainsActiveThroughDate", {
          date: formatBillingDate(result.planStatus.currentPeriodEnd, locale),
        }),
      );
    } catch {
      setBillingPlanModal(null);
      setBillingPlanError("admin.thePlanChangeCouldNotBeScheduled");
    } finally {
      setBillingPlanAction(null);
    }
  };

  useEffect(() => {
    // Deep links such as /settings/general#localization arrive before the section renders.
    if (window.location.hash.length > 1)
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, []);

  const updateSetting = <K extends keyof PropertySettings>(key: K, value: PropertySettings[K]) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
    // A success banner next to unsaved edits reads as if they were saved.
    setFeedback((current) => (current?.type === "success" ? null : current));
  };

  // Payments saves the canonical currency, so it needs the same retry when localization fails.
  const localizationRetryCard = (
    <SettingsCard>
      <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
        <p className="text-sm text-red-700">{t(localizationLoadError)}</p>
        <button
          type="button"
          onClick={() => {
            const hotelId = readBookingHotelId(settings);
            if (hotelId) void loadLocalizationSettings(hotelId);
          }}
          disabled={!readBookingHotelId(settings)}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400 disabled:opacity-50"
        >
          {t("auth.chooseProperty.retry")}
        </button>
      </div>
    </SettingsCard>
  );

  return (
    <SettingsSubPage
      title={t(PAGE_TITLES[activeSection])}
      subtitle={activeSection === "payments" ? t("settings.payments.subtitle") : undefined}
    >
      {stripeDashboardToast && (
        <div className="fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-2rem))]" role="alert">
          <FeedbackAlert type="error" message={t(stripeDashboardToast)} />
        </div>
      )}

      {/* Feedback banner */}
      {feedback && (
        <div role={feedback.type === "error" ? "alert" : "status"} aria-live="polite">
          <FeedbackAlert
            type={feedback.type}
            message={t(feedback.message)}
            className="mt-4"
            action={
              feedback.retry && !saving && !savingPayment
                ? { label: t("settings.paymentsSave.tryAgain"), onClick: () => void handleSave() }
                : undefined
            }
          />
        </div>
      )}

      {activeSection === "general" && (
        <div className="mt-5 space-y-4">
          <a
            href="/settings/location"
            className="block rounded-lg border border-gray-200 bg-white p-4 text-sm font-medium text-blue-700"
          >
            Location &amp; surroundings{" "}
            <span className="ml-2 font-normal text-gray-500">
              Address, nearby places and guest preview
            </span>
          </a>
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Property Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <h2 className="text-sm font-semibold text-gray-900">
                  {t("settings.property.propertyInfo")}
                </h2>
                <p className="text-[13px] text-gray-500 mt-0.5 mb-3">
                  {t("settings.property.propertyInfoDesc")}
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.nameLabel")}
                    </label>
                    <input
                      type="text"
                      value={settings.property_name}
                      onChange={(e) => updateSetting("property_name", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.namePlaceholder")}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="property-description"
                      className="block text-[13px] font-medium text-gray-700 mb-0.5"
                    >
                      {t("settings.property.descriptionLabel")}
                    </label>
                    <textarea
                      id="property-description"
                      rows={2}
                      value={description}
                      disabled={savedDescription === null}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        // A success banner next to unsaved edits reads as if they were saved.
                        setFeedback((current) => (current?.type === "success" ? null : current));
                      }}
                      aria-describedby="property-description-hint"
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:bg-gray-50"
                    />
                    <div className="mt-0.5 flex justify-between gap-3 text-[12px] text-gray-500">
                      <span id="property-description-hint">
                        {t(descriptionLoadError || "settings.property.descriptionHint")}
                      </span>
                      <span
                        className={
                          description.trim() === (savedDescription ?? "").trim() ||
                          normalizePropertyDescription(description)
                            ? "shrink-0 tabular-nums"
                            : "shrink-0 tabular-nums text-red-600"
                        }
                      >
                        {propertyDescriptionLength(description)} / {PROPERTY_DESCRIPTION_MAX_LENGTH}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.addressLabel")}
                    </label>
                    <div className="flex items-start gap-2 text-[13px] text-gray-900">
                      <MapPinIcon className="mt-0.5 w-3.5 h-3.5 shrink-0 text-gray-400" />
                      <span data-testid="property-address">{settings.address || "—"}</span>
                    </div>
                    <a
                      href="/settings/location"
                      className="mt-1 inline-block text-[13px] font-medium text-blue-700 underline"
                    >
                      {t("settings.property.addressEditInLocation")}
                    </a>
                  </div>
                </div>
              </div>

              {/* Contact Information card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <PhoneIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("settings.property.contactTitle")}
                  </h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">
                  {t("settings.property.contactSubtitle")}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.phoneLabel")}
                    </label>
                    <div className="relative">
                      <PhoneIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.phone_number}
                        onChange={(e) => updateSetting("phone_number", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.phonePlaceholder")}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.whatsappLabel")}
                    </label>
                    <div className="relative">
                      <ChatBubbleLeftIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="tel"
                        value={settings.whatsapp_number}
                        onChange={(e) => updateSetting("whatsapp_number", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.whatsappPlaceholder")}
                      />
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.emailLabel")}
                    </label>
                    <div className="relative">
                      <EnvelopeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        type="email"
                        value={settings.reservation_email}
                        onChange={(e) => updateSetting("reservation_email", e.target.value)}
                        className="w-full pl-8 pr-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder={t("settings.property.emailPlaceholder")}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Social Media card */}
              <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <GlobeAltIcon className="w-4 h-4 text-gray-700" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("settings.property.socialTitle")}
                  </h2>
                </div>
                <p className="text-[13px] text-gray-500 mb-3">
                  {t("settings.property.socialSubtitle")}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.instagramLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.instagram || ""}
                      onChange={(e) => updateSetting("instagram", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.instagramPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.facebookLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.facebook || ""}
                      onChange={(e) => updateSetting("facebook", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.facebookPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.tiktokLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.tiktok || ""}
                      onChange={(e) => updateSetting("tiktok", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.tiktokPlaceholder")}
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                      {t("settings.property.youtubeLabel")}
                    </label>
                    <input
                      type="url"
                      value={settings.youtube || ""}
                      onChange={(e) => updateSetting("youtube", e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder={t("settings.property.youtubePlaceholder")}
                    />
                  </div>
                </div>
              </div>

              {/* General also has the languages/currency Save, so name what this one saves. */}
              <div className="flex justify-end">
                <SaveButton onClick={handleSave} saving={saving}>
                  {t("settings.general.savePropertyDetails")}
                </SaveButton>
              </div>
            </>
          )}
        </div>
      )}

      {activeSection === "booking-rules" && (
        <div className="mt-5 space-y-4">
          <div
            className="rounded-lg border border-gray-200 bg-white p-4 md:p-5"
            aria-busy={acceptanceLoading || acceptanceSaving}
          >
            {acceptanceMode ? (
              <ToggleSwitch
                enabled={acceptanceMode === "instant"}
                disabled={acceptanceSaving || Boolean(acceptanceError)}
                onChange={() => void handleAcceptanceToggle()}
                label={t("admin.acceptBookingsInstantly")}
                description={t("admin.confirmCardAndPayAtPropertyBookingsImmediatelyBankTransfers")}
              />
            ) : acceptanceLoading ? (
              <div className="py-3" role="status">
                <p className="text-[13px] font-semibold text-gray-900">
                  {t("admin.acceptBookingsInstantly")}
                </p>
                <p className="text-[13px] text-gray-500">{t("admin.loadingCurrentSetting")}</p>
              </div>
            ) : null}
            <p className="border-t border-gray-100 pt-3 text-[12px] text-gray-500">
              {t("admin.thisSettingIsSharedBetweenPMSAndBookingEngine")}
            </p>
            {acceptanceSaving && (
              <p className="mt-2 text-[12px] text-gray-500" role="status">
                {t("admin.saving")}
              </p>
            )}
            {acceptanceError && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3" role="alert">
                <p className="text-[12px] text-red-700">{t(acceptanceError)}</p>
                <button
                  type="button"
                  onClick={retryBookingAcceptance}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-700 hover:border-gray-400"
                >
                  {t("auth.chooseProperty.retry")}
                </button>
              </div>
            )}
          </div>

          <SameDayBookingCard
            settings={sameDaySettings}
            loading={sameDayLoading}
            saving={sameDaySaving}
            loadError={t(sameDayError)}
            onSave={(enabled, cutoffLocalTime) => void saveSameDayBooking(enabled, cutoffLocalTime)}
            onRetry={retrySameDayBooking}
          />
        </div>
      )}

      {activeSection === "policies" && (
        <div className="mt-5 space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("settings.booking.policiesTitle")}
            </h2>
            <p className="text-[13px] text-gray-500 mt-0.5 mb-4">
              {t("settings.booking.policiesSubtitle")}
            </p>

            <div className="mb-4">
              <label className="block text-[13px] font-medium text-gray-700 mb-1">
                {t("settings.booking.termsLabel")}
              </label>
              <textarea
                value={settings.terms_text ?? ""}
                onChange={(e) => updateSetting("terms_text", e.target.value)}
                rows={8}
                placeholder={t("settings.booking.termsPlaceholder")}
                className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-700 mb-1">
                {t("settings.booking.cancellationLabel")}
              </label>
              <textarea
                value={settings.cancellation_policy_text ?? ""}
                onChange={(e) => updateSetting("cancellation_policy_text", e.target.value)}
                rows={6}
                placeholder={t("settings.booking.cancellationPlaceholder")}
                className="w-full px-2.5 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
              />
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <SaveButton onClick={handleSave} saving={saving}>
              {t("common.save")}
            </SaveButton>
          </div>
        </div>
      )}

      {activeSection === "general" && (
        <SettingsSection
          id="localization"
          title={t("bookingFlow.tabs.localization")}
          description={t("admin.chooseTheCurrenciesAndLanguagesAvailableOnYourBookingPage")}
        >
          {localizationLoading ? (
            <SettingsCard>
              <p className="text-sm text-gray-500" role="status">
                {t("admin.loadingLocalizationSettings")}
              </p>
            </SettingsCard>
          ) : localizationLoadError ? (
            localizationRetryCard
          ) : (
            <LocalizationTab
              defaultCurrency={defaultCurrency}
              setDefaultCurrency={setDefaultCurrency}
              defaultLanguage={defaultLanguage}
              setDefaultLanguage={setDefaultLanguage}
              supportedCurrencies={supportedCurrencies}
              setSupportedCurrencies={setSupportedCurrencies}
              supportedLanguages={supportedLanguages}
              setSupportedLanguages={setSupportedLanguages}
              propertyCurrency={propertyCurrency}
              onSave={handleSaveCurrencyLang}
              saving={savingCurrencyLang}
            />
          )}
        </SettingsSection>
      )}

      {/* Billing tab */}
      {activeSection === "billing" && ownerFinance === false && (
        <OwnerOnlyNote className="mt-5">{t("settings.ownerOnly.billing")}</OwnerOnlyNote>
      )}
      {activeSection === "billing" && ownerFinance !== false && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Commission Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                financePlanStatus?.plan === "commission"
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.commission")}
                </h3>
                {financePlanStatus?.plan === "commission" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                    {t("settings.billing.current")}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-gray-500 mb-3">
                {t("settings.billing.percentagePerDirect")}
              </p>
              <div className="bg-gray-50 rounded-xl p-4 mb-4 space-y-2">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-gray-600">{t("settings.billing.directBookings")}</span>
                  <span className="flex items-center gap-2">
                    {(settings.booking_engine_fee_pct ?? 5) !== 5 && (
                      <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-100 text-amber-700 rounded-full tracking-wide">
                        {t("settings.billing.customRate")}
                      </span>
                    )}
                    <span className="font-semibold text-gray-900">
                      {settings.booking_engine_fee_pct ?? 5}%
                    </span>
                  </span>
                </div>
                <p className="text-[10px] text-gray-400 text-center pt-1">
                  {t("settings.billing.noMonthlyFee")}
                </p>
              </div>
              {financePlanStatus?.plan === "fixed" && !financePlanStatus.cancelAtPeriodEnd && (
                <button
                  onClick={() => setBillingPlanModal("commission")}
                  disabled={billingPlanLoading || billingPlanAction !== null}
                  className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  {t("admin.switchToCommissionPlan")}
                </button>
              )}
            </div>

            {/* Fixed Fee Plan */}
            <div
              className={`bg-white rounded-lg border-2 p-5 transition-all ${
                financePlanStatus?.plan === "fixed"
                  ? "border-primary-500 ring-1 ring-primary-200"
                  : "border-gray-200"
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-gray-900">
                  {t("settings.billing.fixedFee")}
                </h3>
                {financePlanStatus?.plan === "fixed" && (
                  <span className="px-2 py-0.5 text-[10px] font-bold bg-green-100 text-green-700 rounded-full">
                    {t("settings.billing.current")}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-gray-500 mb-3">
                {t("admin.fixedFeeBasedOnActiveUnits")}
              </p>
              <div className="bg-gray-50 rounded-xl p-4 text-center mb-4">
                <span className="text-3xl font-bold text-gray-900">
                  {financePlanStatus
                    ? formatBillingAmount(
                        financePlanStatus.amountMinor,
                        financePlanStatus.currency,
                        locale,
                      )
                    : "—"}
                </span>
                <p className="text-[11px] text-gray-400 mt-1">{t("admin.everyMonth")}</p>
                {financePlanStatus && (
                  <FixedPlanUnitPricing planStatus={financePlanStatus} locale={locale} t={t} />
                )}
              </div>
              {financePlanStatus?.plan !== "fixed" && (
                <button
                  onClick={() => setBillingPlanModal("fixed")}
                  disabled={
                    billingPlanLoading ||
                    billingPlanAction !== null ||
                    !billingPropertyId ||
                    !financePlanStatus
                  }
                  className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  {financePlanStatus?.checkoutPending
                    ? t("admin.resumePayment")
                    : t("admin.switchToFixedPlan")}
                </button>
              )}
              {financePlanStatus?.plan === "fixed" && (
                <div className="space-y-2">
                  <p className="text-center text-[11px] text-gray-500">
                    {t("admin.nextBillingDate")}
                    {formatBillingDate(financePlanStatus.nextBillingDate, locale)}
                  </p>
                  <button
                    onClick={manageFixedPlanBilling}
                    disabled={
                      billingPlanAction !== null || !financePlanStatus.customerPortalAvailable
                    }
                    className="w-full py-2 text-[12px] font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    {billingPlanAction === "portal"
                      ? t("admin.openingBilling")
                      : t("admin.manageBilling")}
                  </button>
                </div>
              )}
            </div>
          </div>

          {billingPlanLoading && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 text-[13px] text-gray-500">
              {t("admin.loadingYourCurrentBillingPlan")}
            </div>
          )}
          {billingPlanError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
            >
              {t(billingPlanError)}
            </div>
          )}
          {billingPlanConfirmation && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-[13px] text-green-800">
              {t(billingPlanConfirmation)}
            </div>
          )}
          {financePlanStatus?.status === "past_due" && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800"
            >
              {t("admin.yourRenewalPaymentIsPastDueStripeWillRetryIt")}
            </div>
          )}
          {financePlanStatus?.cancelAtPeriodEnd && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-[13px] text-amber-800">
                {t("admin.yourFixedPlanIsPaidThroughDateCommissionWillApply", {
                  date: formatBillingDate(financePlanStatus.currentPeriodEnd, locale),
                })}
              </p>
            </div>
          )}

          {billingPlanModal && financePlanStatus && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="billing-plan-dialog-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/40 p-4"
            >
              <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
                <h2
                  id="billing-plan-dialog-title"
                  className="text-base font-semibold text-gray-900"
                >
                  {billingPlanModal === "fixed"
                    ? t("admin.switchToFixedPlan")
                    : t("admin.switchToCommissionPlan")}
                </h2>
                <p className="mt-3 text-[13px] leading-5 text-gray-600">
                  {billingPlanModal === "fixed"
                    ? t("admin.youReSwitchingToTheFixedPlanAtAmountMonth", {
                        amount: formatBillingAmount(
                          financePlanStatus.amountMinor,
                          financePlanStatus.currency,
                          locale,
                        ),
                      })
                    : t("admin.youReSwitchingBackToTheCommissionPlanYourCurrent", {
                        date: formatBillingDate(financePlanStatus.currentPeriodEnd, locale),
                      })}
                </p>
                <div className="mt-6 flex justify-end gap-2">
                  <button
                    onClick={() => setBillingPlanModal(null)}
                    disabled={billingPlanAction !== null}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    {t("settings.totp.cancel")}
                  </button>
                  <button
                    onClick={
                      billingPlanModal === "fixed" ? startFixedPlanCheckout : scheduleCommissionPlan
                    }
                    disabled={billingPlanAction !== null}
                    className="rounded-lg bg-primary-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
                  >
                    {billingPlanModal === "fixed"
                      ? billingPlanAction === "checkout"
                        ? t("admin.openingPayment")
                        : t("admin.continueToPayment")
                      : billingPlanAction === "commission"
                        ? t("admin.scheduling")
                        : t("admin.switchToCommissionPlan")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeSection === "payments" && (
        <div className="mt-4 space-y-4">
          {ownerFinance === false && (
            <OwnerOnlyNote>{t("settings.ownerOnly.payouts")}</OwnerOnlyNote>
          )}
          {paymentSettingsLoaded && settings.online_card_payment && cardNotReadyReason && (
            <CardNotReadyBanner reason={cardNotReadyReason} providerSectionId="payment-provider" />
          )}
          {localizationLoadError && localizationRetryCard}
          <PaymentMethodsStep
            settings={settings}
            update={updateSetting}
            windows={paymentWindows}
            busy={!paymentSettingsLoaded || refreshingStripe || savingPayment}
            loading={(!paymentSettingsLoaded && !paymentError) || refreshingStripe}
            ownerFinance={ownerFinance}
            bankMaskedAccount={bankDestination?.maskedAccount ?? null}
            cardHidden={cardHidden}
          />
        </div>
      )}

      {/* VAY-2424 Step 2: where card payments go, while Credit card is on in Step 1. */}
      {activeSection === "payments" &&
        ((paymentSettingsLoaded && settings.online_card_payment) || stripeStatusUnknown) && (
          <section
            id="payment-provider"
            aria-labelledby="payment-provider-heading"
            className="mt-4 flex scroll-mt-4 flex-col gap-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-6"
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-[0.04em] text-primary-600">
                {t("settings.payments.step", { number: 2 })}
              </span>
              <h2 id="payment-provider-heading" className="text-lg font-semibold text-slate-900">
                {t("settings.payments.providerTitle")}
              </h2>
              <p className="text-sm text-slate-600">{t("settings.payments.providerDesc")}</p>
            </div>

            {/* The page-level Save already shows its result in the banner at the top. */}
            {paymentError && paymentError !== feedback?.message && (
              <FeedbackAlert type="error" message={t(paymentError)} />
            )}
            {paymentSuccess && paymentSuccess !== feedback?.message && (
              <FeedbackAlert type="success" message={t(paymentSuccess)} />
            )}

            {stripeStatusUnknown ? (
              // Stripe may have an account the page couldn't read: check before starting again.
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-slate-600">
                  {t("admin.stripeAccountStatusCouldnTBeConfirmedCheckTheExisting")}
                </p>
                <button
                  type="button"
                  onClick={() => void refreshStripeOnboarding()}
                  disabled={refreshingStripe || !billingPropertyId}
                  className={SECONDARY_BUTTON}
                >
                  {refreshingStripe ? t("admin.checkingStripe") : t("admin.checkStripeStatus")}
                </button>
              </div>
            ) : (
              <>
                <div
                  role="radiogroup"
                  aria-labelledby="payment-provider-heading"
                  className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                >
                  {PAYMENT_PROVIDERS.map(({ id, name, desc }) => {
                    const checked = paymentProvider === id;
                    // vayada Payment once switched on for the hotel (VAY-2442); Xendit waits
                    // for VAY-2443.
                    const available =
                      id === "stripe" || (id === "vayada" && vayadaPayment?.available === true);
                    return (
                      <label
                        key={id}
                        className={`relative flex min-h-[108px] flex-col items-start gap-2 rounded-[10px] p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-500 has-[:focus-visible]:ring-offset-2 ${
                          checked
                            ? "border-2 border-primary-500 bg-primary-50"
                            : "m-px border border-slate-300"
                        } ${available ? "cursor-pointer hover:border-primary-400" : "cursor-not-allowed opacity-55"}`}
                      >
                        <input
                          type="radio"
                          name="payment-provider"
                          value={id}
                          checked={checked}
                          // The saved choice stays focusable even when it can't be chosen now,
                          // so the keyboard still reaches the group (a disabled checked radio
                          // takes the whole group out of the tab order).
                          disabled={!available && !checked}
                          onChange={() => {
                            if (!available) return;
                            // The vayada panel reads the payout account again when it opens.
                            if (id === "vayada") setVayadaPayoutSaved(null);
                            setPaymentProvider(id);
                          }}
                          className="sr-only"
                        />
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="text-[15px] font-semibold text-slate-900">
                            {t(name)}
                          </span>
                          <span
                            aria-hidden="true"
                            className={`h-[18px] w-[18px] shrink-0 rounded-full ${
                              checked
                                ? "border-[6px] border-primary-500"
                                : "border-2 border-slate-400"
                            }`}
                          />
                        </span>
                        <span className="text-[13px] leading-[1.45] text-slate-600">{t(desc)}</span>
                      </label>
                    );
                  })}
                </div>

                {/* The chosen provider: its status (for everyone) and what to do next.
                  Connecting and opening payout accounts is the owner's (VAY-2401). */}
                <div className="flex flex-col gap-3.5 border-t border-slate-200 pt-5">
                  {providerStatus && (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-slate-500">
                        {t("settings.payments.status")}
                      </span>
                      <span
                        data-testid="payment-provider-status"
                        className={`text-sm font-semibold ${providerStatus === "connected" ? "text-green-700" : "text-amber-700"}`}
                      >
                        {t(PROVIDER_STATUS_TEXT[providerStatus])}
                      </span>
                    </div>
                  )}
                  <fieldset
                    disabled={ownerFinance === false}
                    className="flex min-w-0 flex-col items-start gap-3.5 disabled:opacity-60"
                  >
                    {paymentProvider === "vayada" &&
                    vayadaPayment?.available &&
                    billingPropertyId ? (
                      <div className="w-full">
                        <VayadaPayoutAccountPanel
                          propertyId={billingPropertyId}
                          feePercent={vayadaPayment.feePercent ?? null}
                          canEdit={ownerFinance === true}
                          onAccountChange={setVayadaPayoutSaved}
                        />
                      </div>
                    ) : paymentProvider === "vayada" || paymentProvider === "xendit" ? (
                      <>
                        {paymentProvider === "xendit" && (
                          <p className="text-sm text-slate-600">
                            {t("settings.payments.xenditText")}
                          </p>
                        )}
                        <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                          <p className="text-[13px] font-medium text-amber-900">
                            {t("admin.comingSoon")}
                          </p>
                          {paymentProvider === "vayada" && (
                            <p className="mt-1 text-[12px] text-amber-800">
                              {t("admin.vayadaPaymentsIsNotAvailableInTargetCheckoutYet")}
                            </p>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-slate-600">
                          {t(
                            stripeUnconfirmed
                              ? "admin.stripeAccountStatusCouldnTBeConfirmedCheckTheExisting"
                              : stripeAccountId && !stripeOnboarded
                                ? "settings.billing.completeOnboardingDesc"
                                : "settings.payments.stripeText",
                          )}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {stripeUnconfirmed ? (
                            <button
                              type="button"
                              onClick={() => void refreshStripeOnboarding()}
                              disabled={refreshingStripe || !billingPropertyId}
                              className={SECONDARY_BUTTON}
                            >
                              {refreshingStripe
                                ? t("admin.checkingStripe")
                                : t("admin.checkStripeStatus")}
                            </button>
                          ) : !stripeAccountId ? (
                            <button
                              type="button"
                              onClick={handleCreateStripeAccount}
                              disabled={creatingAccount || refreshingStripe || !connectEmail}
                              className={PRIMARY_BUTTON}
                            >
                              {creatingAccount
                                ? t("settings.billing.connectingAccount")
                                : t("settings.payments.connectStripe")}
                            </button>
                          ) : (
                            <>
                              {!stripeOnboarded && (
                                <>
                                  <button
                                    type="button"
                                    onClick={handleOnboarding}
                                    disabled={refreshingStripe || issuingStripeOnboardingLink}
                                    className={PRIMARY_BUTTON}
                                  >
                                    {issuingStripeOnboardingLink
                                      ? t("admin.openingStripe")
                                      : t("settings.payments.finishSetup")}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void refreshStripeOnboarding()}
                                    disabled={refreshingStripe}
                                    className={SECONDARY_BUTTON}
                                  >
                                    {refreshingStripe
                                      ? t("admin.checkingStripe")
                                      : t("admin.checkStripeStatus")}
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={handleStripeDashboard}
                                disabled={openingStripeDashboard}
                                className={stripeOnboarded ? PRIMARY_BUTTON : SECONDARY_BUTTON}
                              >
                                <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
                                {openingStripeDashboard
                                  ? t("admin.openingStripe")
                                  : t("settings.payments.openStripeDashboard")}
                              </button>
                            </>
                          )}
                        </div>
                        {stripeAccountId && (
                          <p className="text-[13px] text-slate-500">
                            {t("admin.checkYourPayoutsBalanceAndPaymentHistoryOrUpdateYour")}
                          </p>
                        )}
                      </>
                    )}
                  </fieldset>
                </div>
              </>
            )}
          </section>
        )}
      {/* VAY-2424: what guests booking at different times see at checkout, as Step 1 stands. */}
      {activeSection === "payments" && paymentSettingsLoaded && billingPropertyId && (
        <div className="mt-4">
          <PaymentsGuestPreview
            methods={previewMethods}
            windows={paymentWindows}
            next={windowsPlan?.next ?? null}
          />
        </div>
      )}
      {/* VAY-2424: one save bar for the whole page (methods, bank details, booking windows), at
          page level so it sticks to the bottom of the screen anywhere on the page. As in Timo's
          mockup it shows only while there is something to save, or a save's result. */}
      {activeSection === "payments" && (paymentsChanged || paymentsSaveStatus || savingPayment) && (
        <div
          className="sticky bottom-0 z-10 mt-4 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] sm:px-6"
          data-testid="payments-save-bar"
        >
          {paymentsSaveStatus && paymentsSaveStatus.kind !== "saved" && !savingPayment && (
            <div role="alert" className="mb-3">
              <FeedbackAlert
                type="error"
                message={
                  paymentsSaveStatus.kind === "failed"
                    ? paymentsSaveFailureText(paymentsSaveStatus, t)
                    : t(paymentsSaveStatus.message, paymentsSaveStatus.params)
                }
                action={
                  paymentsSaveStatus.kind === "failed" && paymentsSaveStatus.retry
                    ? {
                        label: t("settings.paymentsSave.tryAgain"),
                        onClick: () => void handleSave(),
                      }
                    : undefined
                }
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p
              role="status"
              className={`mr-auto text-sm ${paymentsChanged ? "text-slate-600" : "font-medium text-green-700"}`}
            >
              {saveBarMessage}
            </p>
            <button
              type="button"
              onClick={discardPayments}
              disabled={!paymentsChanged || savingPayment}
              className={SECONDARY_BUTTON}
            >
              {t("settings.paymentsSave.discard")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!paymentsReady || !paymentsChanged || savingPayment}
              className={PRIMARY_BUTTON}
            >
              {savingPayment ? t("common.saving") : t("settings.paymentsSave.saveChanges")}
            </button>
          </div>
        </div>
      )}
    </SettingsSubPage>
  );
}

/** Shown to staff where only the account owner may look or change things (VAY-2401). */
function OwnerOnlyNote({ className = "", children }: { className?: string; children: string }) {
  return (
    <div
      role="note"
      className={`flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-[13px] text-gray-700 ${className}`}
    >
      <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
