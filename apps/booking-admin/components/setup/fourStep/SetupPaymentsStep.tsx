"use client";

import {
  BanknotesIcon,
  BuildingStorefrontIcon,
  CheckIcon,
  CreditCardIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType, SVGProps } from "react";

import { SetupStepHeading } from "./SetupStepHeading";

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
 * VAY-2451 step 4, "How guests pay". Paying at the property is what setup turns on: the placeholder price is
 * paid at the property and card payments aren't live yet. Card payments and bank transfer are shown as what
 * comes after setup (the dashboard's "Later" list, Settings › Payments); setup saves nothing for them, so
 * they aren't choices here.
 */
export function SetupPaymentsStep() {
  return (
    <div>
      <SetupStepHeading
        title="How guests pay"
        subtitle="Guests pay at the property to start. Card payments and bank transfer come after setup."
      />
      <ul className="mt-7 flex flex-col gap-3">
        {OPTIONS.map(({ id, title, description, badge, badgeClass, Icon }) => {
          const on = id === "hotel";
          return (
            <li
              key={id}
              className={`flex w-full items-start gap-3 rounded-xl border p-4 ${
                on
                  ? "border-primary-600 bg-primary-50 ring-1 ring-inset ring-primary-600"
                  : "border-gray-200 bg-white"
              }`}
            >
              <span
                className={`relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                  on ? "bg-primary-600" : "border-[1.5px] border-gray-300 bg-white"
                }`}
              >
                {on ? (
                  <>
                    <CheckIcon className="h-3.5 w-3.5 stroke-[3] text-white" aria-hidden="true" />
                    <span className="sr-only">On:</span>
                  </>
                ) : null}
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
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[13px] text-gray-500">
        You can change this anytime in Settings › Payments.
      </p>
    </div>
  );
}
