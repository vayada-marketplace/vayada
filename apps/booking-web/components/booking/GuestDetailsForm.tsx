"use client";

import { useId, type ReactNode } from "react";
import type { PublicQuoteGuestDisclosure } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAcceptanceGuest } from "@/services/api/pricingAcceptance";

export type GuestDetails = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  arrivalTime: string;
  specialRequests: string;
};
export const emptyGuest: GuestDetails = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  countryCode: "",
  arrivalTime: "",
  specialRequests: "",
};
type Rules = PublicQuoteGuestDisclosure["choices"] | null | undefined;

/** Until this quote's rules are known, the phone is required and the optional fields stay hidden
 * (VAY-2163). */
export const phoneRequired = (rules: Rules) => rules?.phoneRequired ?? true;

export function guestComplete(guest: GuestDetails, rules: Rules): boolean {
  return (
    !!guest.firstName.trim() &&
    !!guest.lastName.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email.trim()) &&
    (!phoneRequired(rules) || !!guest.phone.trim()) &&
    /^([A-Za-z]{2})?$/.test(guest.countryCode.trim())
  );
}

/** What the booking sends: the optional fields only when the hotel's rules ask for them. */
export function acceptanceGuest(guest: GuestDetails, rules: Rules): PricingAcceptanceGuest {
  return {
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    phone: guest.phone,
    countryCode: guest.countryCode,
    arrivalTime: rules?.arrivalTimeEnabled ? guest.arrivalTime : "",
    specialRequests: rules?.specialRequestsEnabled ? guest.specialRequests : "",
  };
}

const input =
  "w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 disabled:bg-gray-100";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  // The asterisk stays outside the label, so the field's name is just its label.
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-1 text-sm font-semibold text-gray-900">
        <label htmlFor={id}>
          {label}
          {!required && <span className="font-normal text-gray-500"> (optional)</span>}
        </label>
        {required && (
          <span className="text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </div>
      {children(id)}
    </div>
  );
}

/** The old guest-information form on the details step (VAY-2195), filled in by the guest and
 * kept in the tab's draft. */
export default function GuestDetailsForm({
  value,
  onChange,
  rules,
  locked = false,
}: {
  value: GuestDetails;
  onChange: (value: GuestDetails) => void;
  rules: Rules;
  /** A booking attempt is open: its details can't change until it is settled. */
  locked?: boolean;
}) {
  const set = (field: keyof GuestDetails) => (event: { target: { value: string } }) =>
    onChange({ ...value, [field]: event.target.value });
  const phone = phoneRequired(rules);
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <p className="text-gray-600 mb-6">
        Please tell us who is staying. We send the confirmation to this email.
      </p>
      <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="First name" required>
            {(id) => (
              <input
                id={id}
                className={input}
                name="firstName"
                autoComplete="given-name"
                maxLength={100}
                required
                disabled={locked}
                value={value.firstName}
                onChange={set("firstName")}
              />
            )}
          </Field>
          <Field label="Last name" required>
            {(id) => (
              <input
                id={id}
                className={input}
                name="lastName"
                autoComplete="family-name"
                maxLength={100}
                required
                disabled={locked}
                value={value.lastName}
                onChange={set("lastName")}
              />
            )}
          </Field>
        </div>
        <Field label="Email" required>
          {(id) => (
            <input
              id={id}
              className={input}
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              disabled={locked}
              value={value.email}
              onChange={set("email")}
            />
          )}
        </Field>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Phone" required={phone}>
            {(id) => (
              <input
                id={id}
                className={input}
                name="phone"
                type="tel"
                autoComplete="tel"
                maxLength={64}
                required={phone}
                disabled={locked}
                value={value.phone}
                onChange={set("phone")}
              />
            )}
          </Field>
          <Field label="Country code" required={false}>
            {(id) => (
              <input
                id={id}
                className={input}
                name="countryCode"
                autoComplete="country"
                maxLength={2}
                pattern="[A-Za-z]{2}"
                placeholder="DE"
                disabled={locked}
                value={value.countryCode}
                onChange={set("countryCode")}
              />
            )}
          </Field>
        </div>
        {rules?.arrivalTimeEnabled && (
          <Field label="Expected arrival time" required={false}>
            {(id) => (
              <input
                id={id}
                className={input}
                name="arrivalTime"
                type="time"
                disabled={locked}
                value={value.arrivalTime}
                onChange={set("arrivalTime")}
              />
            )}
          </Field>
        )}
        {rules?.specialRequestsEnabled && (
          <Field label="Special requests" required={false}>
            {(id) => (
              <textarea
                id={id}
                className={input}
                name="specialRequests"
                maxLength={2000}
                rows={4}
                placeholder="Any special requests or preferences for your stay..."
                disabled={locked}
                value={value.specialRequests}
                onChange={set("specialRequests")}
              />
            )}
          </Field>
        )}
      </div>
    </div>
  );
}
