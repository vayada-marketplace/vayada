/** Class names for the shared pricing forms, so each app can match the page around them. */
export type PricingFormLook = {
  heading: string;
  text: string;
  hint: string;
  smallHint: string;
  label: string;
  legend: string;
  check: string;
  input: string;
  error: string;
  button: string;
};

/** The look used by onboarding. */
export const defaultPricingFormLook: PricingFormLook = {
  heading: "text-lg font-semibold",
  text: "text-sm",
  hint: "text-sm text-gray-600",
  smallHint: "text-xs text-gray-600",
  label: "block text-sm",
  legend: "text-sm font-medium",
  check: "flex items-center gap-2 text-sm",
  input: "mt-1 block w-full rounded-lg border px-3 py-2",
  error: "text-red-700",
  button: "rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50",
};
