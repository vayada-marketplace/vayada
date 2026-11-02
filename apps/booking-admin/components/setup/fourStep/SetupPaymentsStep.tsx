"use client";

import {
  BanknotesIcon,
  BuildingStorefrontIcon,
  CheckIcon,
  CreditCardIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType, SVGProps } from "react";

import { SetupStepHeading } from "./SetupStepHeading";

export type SetupPaymentChoices = Readonly<{ card: boolean; bank: boolean }>;

const OPTIONS: ReadonlyArray<{
  id: "hotel" | "card" | "bank";
  title: string;
  description: string;
  badge: string;
  badgeClass: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  {
    id: "hotel",
    title: "Pay at the property",
    description: "Guests pay when they arrive. Nothing to connect.",
    badge: "Ready now",
    badgeClass: "bg-green-50 text-green-700",
    Icon: BuildingStorefrontIcon,
  },
  {
    id: "card",
    title: "Online card payment",
    description: "Guests pay when they book. You connect it after setup, it is on your checklist.",
    badge: "After setup",
    badgeClass: "bg-amber-50 text-amber-700",
    Icon: CreditCardIcon,
  },
  {
    id: "bank",
    title: "Bank transfer",
    description: "Guests transfer before they arrive. Add your bank details later in Settings.",
    badge: "Optional",
    badgeClass: "bg-gray-100 text-gray-600",
    Icon: BanknotesIcon,
  },
];

/**
 * VAY-2451 step 4, "How guests pay". Paying at the property stays on in setup: the placeholder price is paid
 * at the property and card payments aren't live yet. Card and bank transfer are the owner's intent, set up
 * after setup (the dashboard's "Later" list, Settings › Payments); setup saves nothing for them.
 */
export function SetupPaymentsStep({
  choices,
  onChange,
}: {
  choices: SetupPaymentChoices;
  onChange: (choices: SetupPaymentChoices) => void;
}) {
  return (
    <div>
      <SetupStepHeading
        title="How guests pay"
        subtitle="Pick everything you accept. Most properties start with paying at the property."
      />
      <div className="mt-7 flex flex-col gap-3">
        {OPTIONS.map(({ id, title, description, badge, badgeClass, Icon }) => {
          const checked = id === "hotel" || choices[id];
          return (
            <button
              key={id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-disabled={id === "hotel" || undefined}
              onClick={() => {
                if (id !== "hotel") onChange({ ...choices, [id]: !choices[id] });
              }}
              className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
                checked
                  ? "border-primary-600 bg-primary-50 ring-1 ring-inset ring-primary-600"
                  : "border-gray-300 bg-white hover:bg-gray-50"
              } ${id === "hotel" ? "cursor-default" : ""}`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                  checked ? "bg-primary-600" : "border-[1.5px] border-gray-400 bg-white"
                }`}
              >
                {checked ? <CheckIcon className="h-3.5 w-3.5 stroke-[3] text-white" /> : null}
              </span>
              <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white text-primary-600 min-[720px]:flex">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[15px] font-semibold text-gray-950">{title}</span>
                <span className="text-[13px] leading-5 text-gray-600">{description}</span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}
              >
                {badge}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-[13px] text-gray-500">
        You can change this anytime in Settings › Payments.
      </p>
    </div>
  );
}
