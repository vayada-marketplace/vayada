"use client";

import { CheckIcon, MapPinIcon, PhoneIcon, PhotoIcon } from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding/HotelIcon";
import type { SharedPropertyTypeOption } from "@vayada/product-onboarding";
import { useState, type ComponentType, type FormEvent, type ReactNode, type SVGProps } from "react";

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
  /** Shown above the title, e.g. "Welcome back". */
  banner?: ReactNode;
  onSubmit: (draft: QuickHotelDraft) => Promise<void>;
  onBack?: (() => void) | null;
  onSaveAndExit: () => void;
};

/** Hotel first, then the rest of the catalogue's types in its order. */
export function orderedPropertyTypes(options: readonly SharedPropertyTypeOption[]) {
  const first: readonly string[] = QUICK_PROPERTY_TYPE_ORDER;
  const shown = first.flatMap((value) => options.filter((option) => option.value === value));
  return { shown, more: options.filter((option) => !first.includes(option.value)) };
}

function SectionTitle({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="pt-1">
        <h2 className="text-lg font-semibold leading-6 text-gray-950">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[13px] text-gray-500">{subtitle}</p> : null}
      </div>
    </div>
  );
}

/**
 * VAY-2247 step 2, "Your hotel" (Paper rev 4): name with an optional logo, property type, where it
 * is and how guests reach it. The booking-page preview on the right follows as the owner types.
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
  onSubmit,
  onBack,
  onSaveAndExit,
}: QuickHotelStepProps) {
  const [errors, setErrors] = useState<QuickHotelErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { shown, more } = orderedPropertyTypes(propertyTypes);
  const [showMore, setShowMore] = useState(() =>
    more.some((option) => option.value === draft.propertyType),
  );

  const change = (patch: Partial<QuickHotelDraft>, cleared: keyof QuickHotelErrors) => {
    onChange(patch);
    setErrors((current) => ({ ...current, [cleared]: undefined }));
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const found = quickHotelErrors(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit(draft);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We couldn't save your hotel.");
    } finally {
      setSubmitting(false);
    }
  }

  const typeButton = (option: SharedPropertyTypeOption) => {
    const selected = draft.propertyType === option.value;
    return (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => change({ propertyType: option.value }, "propertyType")}
        className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
          selected
            ? "border-primary-600 bg-primary-50 font-semibold text-primary-800"
            : "border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
        }`}
      >
        {selected ? <CheckIcon className="h-4 w-4" aria-hidden="true" /> : null}
        {option.label}
      </button>
    );
  };

  return (
    <QuickSetupShell step={2} onSaveAndExit={onSaveAndExit} saveAndExitDisabled={submitting}>
      <QuickSetupStepLayout
        title="Your hotel"
        subtitle="The basics guests see first. Everything else can wait."
        banner={banner}
        footer={{
          note: "Saved as you type",
          onBack: onBack ?? null,
          backDisabled: submitting,
          formId: FORM_ID,
          primaryLabel: "Continue",
          primaryBusy: submitting,
          primaryBusyLabel: "Saving…",
        }}
        preview={
          <QuickSetupPreviewCard caption="Your booking page, live as you type">
            <QuickBookingPagePreview
              url={previewBookingHost(draft.displayName, draft.city)}
              hotelName={draft.displayName.trim() || "Your hotel name"}
              place={
                [draft.streetAddress.trim(), draft.city.trim()].filter(Boolean).join(", ") ||
                "Your address"
              }
              rooms={[]}
              currencySymbol={currencySymbol}
            />
          </QuickSetupPreviewCard>
        }
      >
        <form id={FORM_ID} noValidate onSubmit={handleSubmit} className="flex flex-col gap-8">
          <section className="flex flex-col gap-5">
            <SectionTitle icon={HotelIcon} title="Your hotel" />
            <div className="flex items-start gap-5">
              <label className="flex shrink-0 cursor-pointer flex-col items-center gap-1.5">
                <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-dashed border-gray-300 bg-gray-50">
                  {logoPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                    <img src={logoPreviewUrl} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <PhotoIcon className="h-6 w-6 text-gray-400" aria-hidden="true" />
                  )}
                </span>
                <span className="text-xs font-semibold text-primary-600">
                  {logoPreviewUrl ? "Change logo" : "Add logo"}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="sr-only"
                  aria-label={logoPreviewUrl ? "Change logo" : "Add logo"}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onLogoSelected(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <div className="min-w-0 flex-1">
                <QuickSetupField
                  label="Hotel name"
                  required
                  value={draft.displayName}
                  error={errors.displayName}
                  helper={logoError ?? "Logo optional — you can add it later."}
                  inputProps={{ placeholder: "e.g. Hotel Alpenrose", maxLength: 120 }}
                  onChange={(displayName) => change({ displayName }, "displayName")}
                />
              </div>
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
                className="mt-2 flex flex-wrap gap-2"
              >
                {shown.map(typeButton)}
                {showMore ? more.map(typeButton) : null}
                {!showMore && more.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowMore(true)}
                    className="inline-flex h-10 items-center rounded-full border border-gray-300 bg-white px-4 text-sm text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                  >
                    More…
                  </button>
                ) : null}
              </div>
              <QuickSetupFieldError message={errors.propertyType} />
            </div>
          </section>

          <section className="flex flex-col gap-5">
            <SectionTitle icon={MapPinIcon} title="Where it is" />
            {address(errors.address)}
          </section>

          <section className="flex flex-col gap-5">
            <SectionTitle
              icon={PhoneIcon}
              title="How guests reach you"
              subtitle="Guests see these on your booking page and in emails."
            />
            {contactsAction}
            <div className="grid gap-6 lg:grid-cols-2 lg:gap-4">
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
              <QuickSetupField
                label="Reception phone"
                required
                value={draft.phone}
                error={errors.phone}
                inputProps={{ type: "tel", autoComplete: "tel", placeholder: "+49 …" }}
                onChange={(phone) => change({ phone }, "phone")}
              />
            </div>
            {contactsNote}
          </section>
          {submitError ? (
            <p role="alert" className="text-sm text-red-700">
              {submitError}
            </p>
          ) : null}
        </form>
      </QuickSetupStepLayout>
    </QuickSetupShell>
  );
}
