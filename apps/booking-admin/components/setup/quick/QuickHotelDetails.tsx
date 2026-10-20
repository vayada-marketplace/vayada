"use client";

import { EyeIcon, UserCircleIcon } from "@heroicons/react/24/outline";

import { QUICK_SETUP_INPUT } from "./QuickSetupField";
import { currencyChoices } from "./quickHotelCurrency";

/**
 * VAY-2247 "How guests reach you": the reception contacts start empty, and "Use my details" copies the
 * owner's account email and phone into them (Paper rev 4, decision: reception ≠ owner by default).
 */
export function QuickUseMyDetails({
  email,
  phone,
  onUse,
}: {
  email: string;
  phone: string | null;
  onUse: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onUse}
      className="flex w-fit items-center gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-2.5 text-left outline-none hover:bg-primary-100 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
    >
      <UserCircleIcon className="h-5 w-5 shrink-0 text-primary-600" aria-hidden="true" />
      <span>
        <span className="block text-sm font-semibold text-primary-700">Use my details</span>
        <span className="block text-xs text-gray-600">
          {[email, phone].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

/** Under the contacts once they were copied from the account. */
export function QuickContactsFromAccountNote() {
  return (
    <p className="flex gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-[13px] leading-5 text-primary-800">
      <EyeIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      Filled from your account. Guests will see these — change them if your reception uses others.
    </p>
  );
}

/** Replaces the currency box after "Change": the popular currencies first. */
export function QuickCurrencyPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <select
      aria-label="Currency"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${QUICK_SETUP_INPUT} mt-2 border-gray-300`}
    >
      {currencyChoices().map((option) => (
        <option key={option.code} value={option.code}>
          {`${option.code} · ${option.name}`}
        </option>
      ))}
    </select>
  );
}
