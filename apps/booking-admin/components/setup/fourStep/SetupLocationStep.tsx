"use client";

import { CheckIcon } from "@heroicons/react/24/outline";
import { CountryPhoneField } from "@vayada/product-onboarding/CountryPhoneField";
import type { ReactNode } from "react";

import type { QuickHotelDraft } from "../quick/quickHotelDraft";
import { SETUP_SOCIALS, socialLinkValid } from "./setupDraft";
import { SetupStepHeading, SETUP_INPUT, SETUP_LABEL } from "./SetupStepHeading";

export type SetupLocationStepProps = {
  draft: QuickHotelDraft;
  onChange: (patch: Partial<QuickHotelDraft>) => void;
  /** The address search, map, time zone and currency (the shared address component, compact). */
  address: ReactNode;
  /** "Use my details" above the contacts, when the account's own can fill them. */
  contactsAction?: ReactNode;
  /** A save error from the last Continue. */
  error?: string | null;
};

const PHONE_INPUT = "h-12 text-[15px]";

/**
 * VAY-2451 step 2, "Location & contact" (the old "Where it is" and "How guests reach you" on one screen,
 * without the preview): the address, reception email and phone, WhatsApp (the phone unless unticked) and
 * four optional social links as full https links.
 */
export function SetupLocationStep({
  draft,
  onChange,
  address,
  contactsAction,
  error,
}: SetupLocationStepProps) {
  const sameAsPhone = draft.whatsappSameAsPhone !== false;
  return (
    <div>
      <SetupStepHeading
        title="Location & contact"
        subtitle="Where guests find you and how they reach you. Shown on your booking page and in confirmation emails."
      />
      <div className="mt-6 flex flex-col gap-4">
        {address}
        <div className="h-px bg-gray-200" />
        {contactsAction}
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 min-[720px]:grid-cols-2">
          <div className="min-[720px]:col-span-2">
            <label htmlFor="setup-reception-email" className={SETUP_LABEL}>
              Reception email
            </label>
            <input
              id="setup-reception-email"
              type="email"
              value={draft.contactEmail}
              onChange={(event) => onChange({ contactEmail: event.target.value })}
              placeholder="reception@yourproperty.com"
              autoComplete="email"
              className={SETUP_INPUT}
            />
          </div>
          <CountryPhoneField
            label="Reception phone"
            value={draft.phone}
            defaultCountry={draft.countryCode}
            onChange={(phone) => onChange({ phone })}
            inputClassName={PHONE_INPUT}
          />
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className={SETUP_LABEL} id="setup-whatsapp-label">
                WhatsApp
              </span>
              <button
                type="button"
                role="checkbox"
                aria-checked={sameAsPhone}
                onClick={() =>
                  onChange({
                    whatsappSameAsPhone: !sameAsPhone,
                    // Unticking starts from the phone, so a different number is one edit away.
                    ...(sameAsPhone && !draft.whatsapp ? { whatsapp: draft.phone } : {}),
                  })
                }
                className="flex items-center gap-1.5 rounded text-[13px] text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded ${
                    sameAsPhone ? "bg-primary-600" : "border-[1.5px] border-gray-400 bg-white"
                  }`}
                >
                  {sameAsPhone ? (
                    <CheckIcon className="h-3 w-3 stroke-[3] text-white" aria-hidden="true" />
                  ) : null}
                </span>
                Same as phone
              </button>
            </div>
            {sameAsPhone ? (
              <input
                disabled
                aria-labelledby="setup-whatsapp-label"
                value={draft.phone.trim()}
                placeholder="Your reception phone"
                className={SETUP_INPUT}
              />
            ) : (
              <div className="-mt-1">
                <CountryPhoneField
                  label="WhatsApp number"
                  value={draft.whatsapp ?? ""}
                  defaultCountry={draft.countryCode}
                  onChange={(whatsapp) => onChange({ whatsapp })}
                  inputClassName={PHONE_INPUT}
                />
              </div>
            )}
          </div>
        </div>
        <div>
          <p className={SETUP_LABEL}>
            Social media{" "}
            <span className="font-normal text-gray-500">
              · optional, linked on your booking page
            </span>
          </p>
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 min-[720px]:grid-cols-2">
            {SETUP_SOCIALS.map((social) => {
              const value = draft[social.key] ?? "";
              const invalid = !socialLinkValid(value);
              return (
                <input
                  key={social.key}
                  type="url"
                  inputMode="url"
                  aria-label={`${social.label} link`}
                  aria-invalid={invalid || undefined}
                  value={value}
                  onChange={(event) => onChange({ [social.key]: event.target.value })}
                  placeholder={social.placeholder}
                  className={`block h-10 w-full rounded-[10px] border bg-white px-3 text-sm text-gray-950 outline-none placeholder:text-gray-400 focus:ring-2 focus:ring-primary-100 ${
                    invalid ? "border-red-500" : "border-gray-300 focus:border-primary-600"
                  }`}
                />
              );
            })}
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
