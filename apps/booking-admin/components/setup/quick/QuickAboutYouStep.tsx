"use client";

import { EnvelopeIcon, InformationCircleIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import {
  isValidSharedAccountPhone,
  normalizeSharedAccountName,
  sharedAccountInitials,
  splitSharedAccountName,
  type SharedAccountDetailsInput,
} from "@vayada/product-onboarding";
import { useState, type FormEvent } from "react";

import { QuickSetupField } from "./QuickSetupField";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";
import { QuickSetupStepLayout } from "./QuickSetupStepLayout";

const FORM_ID = "quick-setup-about-you";

export type QuickAboutYouStepProps = {
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
 * VAY-2247 step 1, "About you" (Paper rev 4): shown only when the account's name or phone is
 * missing. The card on the right shows how the team sees the person setting up the hotel.
 */
export function QuickAboutYouStep({
  email,
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

  const name = normalizeSharedAccountName(firstName, lastName);
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
        preview={
          <QuickSetupPreviewCard caption="How your team sees you">
            <div className="flex flex-col items-center pb-2 pt-3 text-center">
              <div
                role="img"
                aria-label={`Initials: ${sharedAccountInitials(firstName, lastName)}`}
                className="flex h-24 w-24 items-center justify-center rounded-full bg-primary-600 text-[28px] font-bold text-white"
              >
                {sharedAccountInitials(firstName, lastName)}
              </div>
              <p className="mt-4 text-xl font-bold text-gray-950">{name || "Your name"}</p>
              <p className="mt-1 text-sm text-gray-600">
                {organizationName ? `Owner · ${organizationName}` : "Owner"}
              </p>
              {email ? (
                <p className="mt-4 flex items-center gap-2 text-[13px] text-gray-700">
                  <EnvelopeIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  {email}
                </p>
              ) : null}
              <p className="mt-2 flex items-center gap-2 text-[13px] text-gray-700">
                <LockClosedIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
                Your phone stays private — guests never see it.
              </p>
            </div>
          </QuickSetupPreviewCard>
        }
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
          <QuickSetupField
            label="Your phone"
            required
            value={phone}
            error={errors.phone}
            helper="So we can reach you about your account. Not shown to guests."
            inputProps={{ type: "tel", autoComplete: "tel", inputMode: "tel", maxLength: 32 }}
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
