"use client";

import {
  BuildingStorefrontIcon,
  CheckIcon,
  CreditCardIcon,
  InformationCircleIcon,
  ReceiptPercentIcon,
} from "@heroicons/react/24/outline";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
  type SVGProps,
} from "react";

import { QuickBookingPagePreview, type QuickPreviewRoom } from "./QuickBookingPagePreview";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";
import { currencyName } from "./quickHotelCurrency";
import { quickFixedFeePrice } from "./quickPlanPrice";

const FORM_ID = "quick-setup-guest-payment";

export type QuickPlanChoice = "commission" | "fixed_fee";

export type QuickPayStepProps = {
  hotel: { name: string; place: string; url: string };
  currency: { code: string; symbol: string };
  rooms: readonly QuickPreviewRoom[];
  /** A Fixed Fee checkout already started in Stripe (back from checkout before it confirmed). */
  checkoutPending?: boolean;
  initialPlan?: QuickPlanChoice;
  onSubmit: (plan: QuickPlanChoice) => Promise<void>;
  onBack: () => void;
  onSaveAndExit: () => void;
};

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function Badge({ tone, children }: { tone: "green" | "amber" | "blue"; children: ReactNode }) {
  const colors = {
    green: "bg-green-50 text-green-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-primary-50 text-primary-700",
  }[tone];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${colors}`}>
      {children}
    </span>
  );
}

function SectionTitle({
  icon: Icon,
  id,
  title,
  note,
}: {
  icon: Icon;
  id: string;
  title: string;
  note?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="pt-1">
        <h2 id={id} className="text-lg font-semibold leading-6 text-gray-950">
          {title}
        </h2>
        {note ? <p className="mt-0.5 text-[13px] text-gray-500">{note}</p> : null}
      </div>
    </div>
  );
}

function MethodRow({
  icon: Icon,
  title,
  note,
  badge,
  selected,
  onClick,
}: {
  icon: Icon;
  title: string;
  note: string;
  badge: ReactNode;
  selected: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
        selected
          ? "border-2 border-primary-600 px-[15px] py-[13px]"
          : "border border-gray-200 bg-white px-4 py-3.5"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
          selected ? "border-primary-600 bg-primary-600 text-white" : "border-gray-300 bg-white"
        }`}
      >
        {selected ? <CheckIcon className="h-3.5 w-3.5" /> : null}
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-600">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-gray-950">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-5 text-gray-500">{note}</span>
      </span>
      {badge}
    </button>
  );
}

/**
 * VAY-2247 step 4, "How guests pay" (Paper rev 4): paying at the hotel now, online cards after launch
 * (VAY-2205), and the vayada plan. Continue sends the whole first run; Fixed Fee then opens Stripe.
 */
export function QuickPayStep({
  hotel,
  currency,
  rooms,
  checkoutPending = false,
  initialPlan = "commission",
  onSubmit,
  onBack,
  onSaveAndExit,
}: QuickPayStepProps) {
  const fixedFee = quickFixedFeePrice(currency.code);
  const [plan, setPlan] = useState<QuickPlanChoice>(
    initialPlan === "fixed_fee" && !fixedFee.available ? "commission" : initialPlan,
  );
  const [cardInterest, setCardInterest] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const focusBeforeFailedSave = useRef<HTMLElement | null>(null);

  // The browser takes focus off a control as it is disabled for the first run: after a failed run it goes
  // back there, unless the owner has moved on (as on "Your hotel", VAY-2397).
  useEffect(() => {
    const focused = focusBeforeFailedSave.current;
    focusBeforeFailedSave.current = null;
    if (submitting || !focused?.isConnected) return;
    if (!document.activeElement || document.activeElement === document.body) focused.focus();
  }, [submitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const focused =
      typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
    setSubmitting(true);
    try {
      await onSubmit(plan);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "We couldn't finish setting up your hotel.",
      );
      focusBeforeFailedSave.current = focused;
    } finally {
      setSubmitting(false);
    }
  }

  const planCard = (
    value: QuickPlanChoice,
    title: string,
    badge: ReactNode,
    price: string,
    note: string,
    disabled = false,
  ) => (
    <label
      className={`flex flex-col gap-2 rounded-xl ${
        disabled
          ? "cursor-not-allowed border border-gray-200 bg-gray-50 p-4"
          : plan === value
            ? "cursor-pointer border-2 border-primary-600 p-[15px]"
            : "cursor-pointer border border-gray-200 bg-white p-4"
      }`}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="quick-setup-plan"
          value={value}
          checked={plan === value}
          disabled={disabled}
          onChange={() => setPlan(value)}
          className="h-4 w-4 accent-primary-600"
        />
        <span className={`text-sm font-semibold ${disabled ? "text-gray-500" : "text-gray-950"}`}>
          {title}
        </span>
        {badge}
      </span>
      <span
        className={
          disabled
            ? "text-sm font-semibold leading-6 text-gray-500"
            : "text-[17px] font-bold leading-6 text-gray-950"
        }
      >
        {price}
      </span>
      <span className="text-[13px] leading-5 text-gray-500">{note}</span>
    </label>
  );

  return (
    <QuickSetupShell step={6} onSaveAndExit={onSaveAndExit} saveAndExitDisabled={submitting}>
      <QuickSetupStepLayout
        title="How guests pay"
        subtitle="Start with paying at the hotel. Add online cards when you're ready."
        footer={{
          onBack,
          backDisabled: submitting,
          formId: FORM_ID,
          primaryLabel: "Continue",
          primaryBusy: submitting,
          primaryBusyLabel: "Setting up your hotel…",
        }}
        preview={
          <QuickSetupPreviewCard caption="Guests see “Pay at the hotel” at checkout">
            <QuickBookingPagePreview
              url={hotel.url}
              hotelName={hotel.name}
              place={hotel.place}
              currencySymbol={currency.symbol}
              rooms={rooms}
            />
          </QuickSetupPreviewCard>
        }
      >
        {/* While the first run runs the choices are disabled, as the buttons are: a plan picked meanwhile
            would not be part of it, and the step then leaves (VAY-2399). One fieldset, with no group role. */}
        <form id={FORM_ID} noValidate onSubmit={handleSubmit}>
          <fieldset role="none" disabled={submitting} className="flex min-w-0 flex-col gap-8">
            <section className="flex flex-col gap-3" aria-labelledby="quick-pay-methods">
              <SectionTitle icon={CreditCardIcon} id="quick-pay-methods" title="How guests pay" />
              <MethodRow
                icon={BuildingStorefrontIcon}
                title="Pay at the hotel"
                note="Guests pay when they arrive. Nothing to connect."
                badge={<Badge tone="green">Ready now</Badge>}
                selected
              />
              <MethodRow
                icon={CreditCardIcon}
                title="Online card"
                note="Connect Stripe after launch — it's on your checklist."
                badge={
                  <Badge tone={cardInterest ? "blue" : "amber"}>
                    {cardInterest ? "After launch" : "Later"}
                  </Badge>
                }
                selected={false}
                onClick={() => setCardInterest(true)}
              />
              <p className="text-[13px] text-gray-500">
                Bank transfer and PayPal live in Booking Engine settings.
              </p>
            </section>

            <section className="flex flex-col gap-3" aria-labelledby="quick-pay-plan">
              <SectionTitle
                icon={ReceiptPercentIcon}
                id="quick-pay-plan"
                title="Your vayada plan"
                note="How you pay vayada for direct bookings. Switch any time in Settings → Billing."
              />
              <div className="grid gap-3 lg:grid-cols-2">
                {planCard(
                  "commission",
                  "Commission",
                  <Badge tone="blue">Recommended</Badge>,
                  "5% per direct booking",
                  "No monthly fee. Pay only when you earn.",
                )}
                {fixedFee.available
                  ? planCard(
                      "fixed_fee",
                      "Fixed Fee",
                      null,
                      `${fixedFee.base} / month`,
                      `${fixedFee.base} for the first active room + ${fixedFee.extraRoom} for each additional room.`,
                    )
                  : planCard(
                      "fixed_fee",
                      "Fixed Fee",
                      null,
                      `Not available in ${currency.code} yet.`,
                      `Your hotel uses ${currencyName(currency.code)}. Commission works in every currency.`,
                      true,
                    )}
              </div>
              {plan === "fixed_fee" || checkoutPending ? (
                <p className="flex gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-[13px] leading-5 text-primary-800">
                  <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {checkoutPending
                    ? "Your Fixed Fee checkout is open in Stripe. Your booking page goes live once the subscription is active."
                    : "You'll confirm the Fixed Fee in Stripe checkout. Your booking page goes live once the subscription is active."}
                </p>
              ) : null}
            </section>
            {submitError ? (
              <p role="alert" className="text-sm text-red-700">
                {submitError}
              </p>
            ) : null}
          </fieldset>
        </form>
      </QuickSetupStepLayout>
    </QuickSetupShell>
  );
}
