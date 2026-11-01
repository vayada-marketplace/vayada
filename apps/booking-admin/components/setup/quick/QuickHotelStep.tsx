"use client";

import {
  ArrowUpTrayIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  PhoneIcon,
} from "@heroicons/react/24/outline";
import type { SharedPropertyTypeOption } from "@vayada/product-onboarding";
import { CountryPhoneField } from "@vayada/product-onboarding/CountryPhoneField";
import { propertyTypeIcon } from "@vayada/product-onboarding/setupProfileFields";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { QuickBookingPagePreview } from "./QuickBookingPagePreview";
import { QuickSetupField, QuickSetupFieldError } from "./QuickSetupField";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";
import {
  QUICK_PROPERTY_TYPE_ORDER,
  previewBookingHost,
  quickHotelErrors,
  type QuickHotelDraft,
  type QuickHotelErrors,
} from "./quickHotelDraft";

const FORM_ID = "quick-setup-hotel";

/** "Your hotel" is three screens (Flamur, 2026-10-21): the hotel, where it is, how guests reach it. */
export type QuickHotelPart = "hotel" | "where" | "contacts";
const PARTS: readonly QuickHotelPart[] = ["hotel", "where", "contacts"];
const PART_STEP: Record<QuickHotelPart, number> = { hotel: 2, where: 3, contacts: 4 };
const PART_ERRORS: Record<QuickHotelPart, readonly (keyof QuickHotelErrors)[]> = {
  hotel: ["displayName", "propertyType"],
  where: ["address"],
  contacts: ["contactEmail", "phone"],
};
const PART_TEXT: Record<QuickHotelPart, { title: string; subtitle: string }> = {
  hotel: { title: "Your hotel", subtitle: "The name and type guests see first." },
  where: {
    title: "Where it is",
    subtitle:
      "Search your address or paste a Google Maps link. We pin it on the map and set your time zone and currency.",
  },
  contacts: { title: "How guests reach you", subtitle: "Your reception's email and phone." },
};

export type QuickHotelStepProps = {
  draft: QuickHotelDraft;
  onChange: (patch: Partial<QuickHotelDraft>) => void;
  propertyTypes: readonly SharedPropertyTypeOption[];
  /** "Where it is": address search, manual entry, map, time zone and currency; shows the error itself. */
  address: (error: string | undefined) => ReactNode;
  /** Above the contact fields, e.g. "Use my details". */
  contactsAction?: ReactNode;
  /** Under the contact fields, e.g. "Filled from your account". */
  contactsNote?: ReactNode;
  /** For the preview's placeholder price ("€ —"). */
  currencySymbol?: string;
  logoPreviewUrl?: string | null;
  onLogoSelected: (file: File) => void;
  logoError?: string | null;
  /** Shown above the title of the first screen, e.g. "Welcome back". */
  banner?: ReactNode;
  /** The screen to open on (Back from the rooms step opens the last one). */
  initialPart?: QuickHotelPart;
  /** After the last screen, with everything checked. */
  onSubmit: (draft: QuickHotelDraft) => Promise<void>;
  /** Back from the first screen; with `onExitSave`, it saves first as Save & exit does (VAY-2394). */
  onBack?: (() => void) | null;
  /** The footer's note on where the answers are, which must be true (VAY-2383): e.g. kept on this device. */
  footerNote: string;
  /** "Save & exit" leaves at once; with `onExitSave`, it first checks every screen and saves through it, and
   * stays with the reason when the hotel can't be saved yet or the save fails (VAY-2383). */
  onSaveAndExit: () => void;
  onExitSave?: ((draft: QuickHotelDraft) => Promise<void>) | null;
};

/** Hotel first, then the rest of the catalogue's types in its order. */
export function orderedPropertyTypes(options: readonly SharedPropertyTypeOption[]) {
  const first: readonly string[] = QUICK_PROPERTY_TYPE_ORDER;
  const shown = first.flatMap((value) => options.filter((option) => option.value === value));
  return { shown, more: options.filter((option) => !first.includes(option.value)) };
}

/** The errors one screen checks before Continue. */
export function quickHotelPartErrors(part: QuickHotelPart, draft: QuickHotelDraft) {
  const all = quickHotelErrors(draft);
  const errors: QuickHotelErrors = {};
  for (const key of PART_ERRORS[part]) if (all[key]) errors[key] = all[key];
  return errors;
}

/**
 * VAY-2247 steps 2–4 (Paper "7 steps · approved", 2026-10-21): "Your hotel" (name, a logo upload strip and
 * the property type as cards), "Where it is" (the address with a bigger map) and "How guests reach you"
 * (reception email and phone). The booking-page preview on the right follows as the owner types. One
 * save at the end, as before the split.
 */
export function QuickHotelStep({
  draft,
  onChange,
  propertyTypes,
  address,
  contactsAction,
  contactsNote,
  currencySymbol,
  logoPreviewUrl,
  onLogoSelected,
  logoError,
  banner,
  initialPart = "hotel",
  onSubmit,
  onBack,
  footerNote,
  onSaveAndExit,
  onExitSave = null,
}: QuickHotelStepProps) {
  const [part, setPart] = useState<QuickHotelPart>(initialPart);
  const [errors, setErrors] = useState<QuickHotelErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { shown, more } = orderedPropertyTypes(propertyTypes);
  const [showMore, setShowMore] = useState(() =>
    more.some((option) => option.value === draft.propertyType),
  );
  const firstRender = useRef(true);
  const whereRef = useRef<HTMLDivElement>(null);
  const focusBeforeFailedSave = useRef<HTMLElement | null>(null);

  // While a save runs the fields are disabled, as the buttons are: a change made meanwhile would not be part
  // of the save, and the screen then leaves (VAY-2397). One fieldset does it, with no group role to announce.
  // Google's map and address search on "Where it is" aren't form controls, so the disabled fieldset doesn't
  // reach them; that screen's part is inert instead.
  useEffect(() => {
    whereRef.current?.toggleAttribute("inert", submitting);
  }, [submitting, part]);

  // The browser takes focus off a control as it is disabled: after a failed save it goes back there, unless
  // the owner has moved on.
  useEffect(() => {
    const focused = focusBeforeFailedSave.current;
    focusBeforeFailedSave.current = null;
    if (submitting || !focused?.isConnected) return;
    if (!document.activeElement || document.activeElement === document.body) focused.focus();
  }, [submitting]);

  // A new screen starts at its title, for keyboard and screen-reader users too.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.scrollTo({ top: 0 });
    document.getElementById("quick-setup-heading")?.focus();
  }, [part]);

  const change = (patch: Partial<QuickHotelDraft>, cleared: keyof QuickHotelErrors) => {
    onChange(patch);
    setErrors((current) => ({ ...current, [cleared]: undefined }));
  };

  const index = PARTS.indexOf(part);

  /** The first screen with a gap, after checking the whole hotel; the gaps are shown and that screen opened. */
  function screenWithGap(): QuickHotelPart | null {
    const all = quickHotelErrors(draft);
    const first = PARTS.find((each) => PART_ERRORS[each].some((key) => all[key]));
    if (!first) return null;
    setErrors(all);
    setPart(first);
    return first;
  }

  async function save(action: (draft: QuickHotelDraft) => Promise<void>) {
    const focused =
      typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
    setSubmitting(true);
    try {
      await action(draft);
      return true;
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We couldn't save your hotel.");
      focusBeforeFailedSave.current = focused;
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const found = quickHotelPartErrors(part, draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (index < PARTS.length - 1) {
      setPart(PARTS[index + 1]!);
      return;
    }
    // The earlier screens were checked when they were left; check them again before the save.
    if (screenWithGap()) return;
    await save(onSubmit);
  }

  /** Save & exit, and Back from the first screen: the same save as Continue on the last screen, then leave;
   * never leave an edit behind. */
  async function saveThenLeave(leave: () => void) {
    if (!onExitSave) return leave();
    setSubmitError(null);
    if (screenWithGap()) {
      setSubmitError("Your hotel can't be saved yet: fill in what is marked, then try again.");
      return;
    }
    if (await save(onExitSave)) leave();
  }

  const back =
    index === 0
      ? onBack
        ? () => void saveThenLeave(onBack)
        : null
      : () => setPart(PARTS[index - 1]!);

  const typeCard = (option: SharedPropertyTypeOption) => {
    const selected = draft.propertyType === option.value;
    const Icon = propertyTypeIcon(option.value);
    return (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => change({ propertyType: option.value }, "propertyType")}
        className={`relative flex h-[60px] items-center gap-2.5 rounded-xl px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 lg:h-[104px] lg:flex-col lg:items-start lg:justify-between lg:rounded-[14px] lg:p-3.5 ${
          selected
            ? "border-2 border-primary-500 bg-primary-50"
            : "border border-gray-200 bg-white hover:bg-gray-50"
        }`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg lg:h-10 lg:w-10 lg:rounded-[10px] ${
            selected ? "bg-white text-primary-700" : "bg-gray-50 text-gray-600"
          }`}
        >
          <Icon className="h-[18px] w-[18px] lg:h-[22px] lg:w-[22px]" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-gray-950 lg:flex-none">
          {option.label}
        </span>
        {selected ? (
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-primary-600 lg:absolute lg:right-2.5 lg:top-2.5 lg:h-5 lg:w-5">
            <CheckIcon className="h-3 w-3 text-white" strokeWidth={2.6} aria-hidden="true" />
          </span>
        ) : null}
      </button>
    );
  };

  const { title, subtitle } = PART_TEXT[part];
  const phoneShown = draft.phone.trim();
  return (
    <QuickSetupShell
      step={PART_STEP[part]}
      onSaveAndExit={() => void saveThenLeave(onSaveAndExit)}
      saveAndExitDisabled={submitting}
    >
      <QuickSetupStepLayout
        title={title}
        subtitle={subtitle}
        banner={part === "hotel" ? banner : null}
        footer={{
          note: footerNote,
          onBack: back,
          backDisabled: submitting,
          formId: FORM_ID,
          primaryLabel: "Continue",
          primaryBusy: submitting,
          primaryBusyLabel: "Saving…",
        }}
        preview={
          <QuickSetupPreviewCard caption="Your booking page, live as you type">
            <QuickBookingPagePreview
              url={previewBookingHost(draft.displayName)}
              hotelName={draft.displayName.trim() || "Your hotel name"}
              place={
                [draft.streetAddress.trim(), draft.city.trim()].filter(Boolean).join(", ") ||
                (part === "hotel" ? "Your address comes next" : "Your address")
              }
              rooms={[]}
              currencySymbol={currencySymbol}
            />
            {part === "contacts" && (draft.contactEmail.trim() || phoneShown) ? (
              <div className="mt-2 flex flex-col gap-2 rounded-xl bg-gray-50 px-3.5 py-2.5 text-[13px] font-medium text-gray-700 lg:flex-row lg:gap-4">
                {draft.contactEmail.trim() ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <EnvelopeIcon className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                    <span className="truncate">{draft.contactEmail.trim()}</span>
                  </span>
                ) : null}
                {phoneShown ? (
                  <span className="flex items-center gap-2">
                    <PhoneIcon className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                    {phoneShown}
                  </span>
                ) : null}
              </div>
            ) : null}
          </QuickSetupPreviewCard>
        }
      >
        <form id={FORM_ID} noValidate onSubmit={handleSubmit}>
          <fieldset role="none" disabled={submitting} className="flex min-w-0 flex-col gap-8">
            {part === "hotel" ? (
              <>
                <QuickSetupField
                  label="Hotel name"
                  required
                  value={draft.displayName}
                  error={errors.displayName}
                  helper="Guests see it on your booking page and in emails."
                  inputProps={{ placeholder: "e.g. Hotel Alpenrose", maxLength: 120 }}
                  onChange={(displayName) => change({ displayName }, "displayName")}
                />
                <div>
                  <p className="text-sm font-semibold text-gray-950">Logo</p>
                  <label className="mt-2 flex cursor-pointer items-start gap-3.5 rounded-[14px] border-[1.5px] border-dashed border-primary-300 bg-primary-50 p-4 focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 lg:items-center lg:gap-4 lg:p-5">
                    <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-primary-100 bg-white">
                      {logoPreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                        <img src={logoPreviewUrl} alt="" className="h-full w-full object-contain" />
                      ) : (
                        <ArrowUpTrayIcon className="h-6 w-6 text-primary-600" aria-hidden="true" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 lg:flex-row lg:items-center lg:gap-4">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-base font-semibold text-gray-950">
                          {logoPreviewUrl ? "Your logo" : "Upload your logo"}
                        </span>
                        <span className="text-[13px] text-gray-500">
                          PNG or SVG · optional
                          <span className="hidden lg:inline"> · you can add it later</span>
                        </span>
                      </span>
                      <span className="mt-2 inline-flex h-10 w-fit shrink-0 items-center rounded-full border border-primary-200 bg-white px-4 text-sm font-semibold text-primary-700 lg:mt-0">
                        {logoPreviewUrl ? "Change file" : "Choose file"}
                      </span>
                    </span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="sr-only"
                      aria-label={logoPreviewUrl ? "Change logo" : "Upload your logo"}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) onLogoSelected(file);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  <QuickSetupFieldError message={logoError} />
                </div>
                <div>
                  <p id="quick-hotel-type" className="text-sm font-semibold text-gray-950">
                    Property type
                    <span aria-hidden="true" className="ml-1 text-red-600">
                      *
                    </span>
                  </p>
                  <div
                    role="radiogroup"
                    aria-labelledby="quick-hotel-type"
                    className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4"
                  >
                    {shown.map(typeCard)}
                    {showMore ? more.map(typeCard) : null}
                    {!showMore && more.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setShowMore(true)}
                        className="flex h-[60px] items-center gap-2.5 rounded-xl border border-gray-200 bg-white px-3 text-left outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 lg:h-[104px] lg:flex-col lg:items-start lg:justify-between lg:rounded-[14px] lg:p-3.5"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-50 text-gray-600 lg:h-10 lg:w-10 lg:rounded-[10px]">
                          <EllipsisHorizontalIcon
                            className="h-[18px] w-[18px] lg:h-[22px] lg:w-[22px]"
                            aria-hidden="true"
                          />
                        </span>
                        <span className="text-sm font-semibold text-gray-950">More…</span>
                      </button>
                    ) : null}
                  </div>
                  <QuickSetupFieldError message={errors.propertyType} />
                </div>
              </>
            ) : null}

            {part === "where" ? <div ref={whereRef}>{address(errors.address)}</div> : null}

            {part === "contacts" ? (
              <>
                {contactsAction}
                <QuickSetupField
                  label="Reception email"
                  required
                  value={draft.contactEmail}
                  error={errors.contactEmail}
                  inputProps={{
                    type: "email",
                    autoComplete: "email",
                    placeholder: "reception@yourhotel.com",
                  }}
                  onChange={(contactEmail) => change({ contactEmail }, "contactEmail")}
                />
                <CountryPhoneField
                  label="Reception phone"
                  required
                  value={draft.phone}
                  error={errors.phone}
                  defaultCountry={draft.countryCode}
                  onChange={(phone) => change({ phone }, "phone")}
                />
                {contactsNote}
              </>
            ) : null}
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
