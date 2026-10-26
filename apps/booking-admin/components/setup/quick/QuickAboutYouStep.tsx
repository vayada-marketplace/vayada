"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import {
  isValidSharedAccountPhone,
  normalizeSharedAccountName,
  splitSharedAccountName,
  type SharedAccountDetailsInput,
} from "@vayada/product-onboarding";
import { CountryPhoneField } from "@vayada/product-onboarding/CountryPhoneField";
import { useState, type FormEvent } from "react";

import { QuickSetupField } from "./QuickSetupField";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";

const FORM_ID = "quick-setup-about-you";

export type QuickAboutYouStepProps = {
  /** The signed-in email (no longer shown here since the step became one card, 2026-10-21). */
  email: string;
  /** The hotel group, shown on the card ("Owner · Alpenrose Hotel Group"). */
  organizationName?: string | null;
  initialName?: string | null;
  initialPhone?: string | null;
  /** The group was invited by Vayada: its plan and products are already set up. */
  invited?: boolean;
  onSubmit: (input: SharedAccountDetailsInput) => Promise<void>;
  onSaveAndExit: () => void;
};

type Errors = Partial<Record<"firstName" | "lastName" | "phone", string>>;

/** The same rules as the account details step it replaces. */
export function aboutYouErrors(input: { firstName: string; lastName: string; phone: string }) {
  const errors: Errors = {};
  if (!input.firstName.trim()) errors.firstName = "Enter your first name.";
  if (!input.lastName.trim()) errors.lastName = "Enter your last name.";
  if (normalizeSharedAccountName(input.firstName, input.lastName).length > 120) {
    errors.lastName = "Enter a shorter name.";
  }
  if (!input.phone.trim()) errors.phone = "Enter your phone number.";
  else if (!isValidSharedAccountPhone(input.phone)) errors.phone = "Enter a valid phone number.";
  return errors;
}

/**
 * VAY-2247 step 1, "About you": shown only when the account's name or phone is missing. One centred card
 * with the phone as country + number (Flamur, 2026-10-21; Paper "7 steps · approved").
 */
export function QuickAboutYouStep({
  organizationName,
  initialName,
  initialPhone,
  invited = false,
  onSubmit,
  onSaveAndExit,
}: QuickAboutYouStepProps) {
  const initial = splitSharedAccountName(initialName);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const found = aboutYouErrors({ firstName, lastName, phone });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      await onSubmit({
        firstName: firstName.trim().replace(/\s+/g, " "),
        lastName: lastName.trim().replace(/\s+/g, " "),
        phone: phone.trim(),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "We couldn't save your details.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <QuickSetupShell step={1} onSaveAndExit={onSaveAndExit} saveAndExitDisabled={submitting}>
      <QuickSetupStepLayout
        title="Hi! Who's setting up the hotel?"
        subtitle="One quick step, then we set up your hotel."
        banner={
          invited ? (
            <div className="flex gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3.5 text-primary-800">
              <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="text-[13px] leading-5">
                <p className="text-sm font-semibold">You&apos;re invited</p>
                <p className="mt-0.5">
                  {`${organizationName || "Your hotel group"} was invited by Vayada. Your plan and products are already set up.`}
                </p>
              </div>
            </div>
          ) : null
        }
        footer={{
          formId: FORM_ID,
          primaryLabel: "Continue",
          primaryBusy: submitting,
          primaryBusyLabel: "Saving…",
        }}
      >
        <form id={FORM_ID} noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-4">
            <QuickSetupField
              label="First name"
              required
              value={firstName}
              error={errors.firstName}
              inputProps={{ autoComplete: "given-name", maxLength: 60 }}
              onChange={(value) => {
                setFirstName(value);
                setErrors((current) => ({ ...current, firstName: undefined }));
              }}
            />
            <QuickSetupField
              label="Last name"
              required
              value={lastName}
              error={errors.lastName}
              inputProps={{ autoComplete: "family-name", maxLength: 60 }}
              onChange={(value) => {
                setLastName(value);
                setErrors((current) => ({ ...current, lastName: undefined }));
              }}
            />
          </div>
          <CountryPhoneField
            label="Your phone"
            required
            value={phone}
            error={errors.phone}
            helper="So we can reach you about your account. Not shown to guests."
            onChange={(value) => {
              setPhone(value);
              setErrors((current) => ({ ...current, phone: undefined }));
            }}
          />
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
