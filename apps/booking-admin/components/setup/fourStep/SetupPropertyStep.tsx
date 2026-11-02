"use client";

import { ArrowUpTrayIcon } from "@heroicons/react/24/outline";
import type { SharedPropertyTypeOption } from "@vayada/product-onboarding";
import { propertyTypeIcon } from "@vayada/product-onboarding/setupProfileFields";

import type { QuickHotelDraft } from "../quick/quickHotelDraft";
import { SetupStepHeading, SETUP_INPUT, SETUP_LABEL } from "./SetupStepHeading";

/** The grid's types, in the mockup's order; the catalog decides which exist and names them. */
export const SETUP_PROPERTY_TYPES = [
  "hotel",
  "villa",
  "guesthouse",
  "resort",
  "bed_and_breakfast",
  "apartment",
  "hostel",
  "homestay",
  "other",
] as const;

/** The grid: the catalog's types in the mockup's order, plus the draft's own when it is another. */
export function setupPropertyTypeOptions(
  catalog: readonly SharedPropertyTypeOption[],
  current: string,
): SharedPropertyTypeOption[] {
  const order: readonly string[] = SETUP_PROPERTY_TYPES;
  const shown = order.flatMap((value) => catalog.filter((option) => option.value === value));
  const extra = catalog.find((option) => option.value === current && !order.includes(current));
  return extra ? [...shown, extra] : shown;
}

export type SetupPropertyStepProps = {
  draft: QuickHotelDraft;
  onChange: (patch: Partial<QuickHotelDraft>) => void;
  propertyTypes: readonly SharedPropertyTypeOption[];
  logoPreviewUrl?: string | null;
  onLogoSelected: (file: File) => void;
};

/** VAY-2451 step 1, "Your property": the name, the type as a compact grid and an optional logo. */
export function SetupPropertyStep({
  draft,
  onChange,
  propertyTypes,
  logoPreviewUrl,
  onLogoSelected,
}: SetupPropertyStepProps) {
  const options = setupPropertyTypeOptions(propertyTypes, draft.propertyType);
  return (
    <div>
      <SetupStepHeading title="Your property" subtitle="The name and type guests see first." />
      <div className="mt-7 flex flex-col gap-6">
        <div>
          <label htmlFor="setup-property-name" className={SETUP_LABEL}>
            Property name
          </label>
          <input
            id="setup-property-name"
            value={draft.displayName}
            onChange={(event) => onChange({ displayName: event.target.value })}
            placeholder="e.g. Sunset Villas Ubud"
            autoComplete="organization"
            maxLength={200}
            className={SETUP_INPUT}
            aria-describedby="setup-property-name-help"
          />
          <p id="setup-property-name-help" className="mt-1.5 text-[13px] text-gray-500">
            Shown on your booking page and in guest emails.
          </p>
        </div>

        <div>
          <p id="setup-property-type" className={SETUP_LABEL}>
            Property type
          </p>
          <div
            role="radiogroup"
            aria-labelledby="setup-property-type"
            className="mt-2 grid grid-cols-2 gap-2 min-[720px]:grid-cols-3"
          >
            {options.map((option) => {
              const selected = draft.propertyType === option.value;
              const Icon = propertyTypeIcon(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ propertyType: option.value })}
                  className={`flex h-12 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
                    selected
                      ? "border border-primary-600 bg-primary-50 text-primary-700 ring-1 ring-inset ring-primary-600"
                      : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className={SETUP_LABEL}>
            Logo <span className="font-normal text-gray-500">· optional</span>
          </p>
          <label className="mt-2 flex cursor-pointer items-center gap-3.5 rounded-xl border border-dashed border-primary-300 bg-primary-50 px-3.5 py-3 focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-gray-200 bg-white text-primary-600">
              {logoPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                <img src={logoPreviewUrl} alt="" className="h-full w-full object-contain" />
              ) : (
                <ArrowUpTrayIcon className="h-5 w-5" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-gray-950">
                {logoPreviewUrl ? "Your logo" : "Upload your logo"}
              </span>
              <span className="block text-[13px] text-gray-500">
                PNG, JPG or SVG. You can add it later.
              </span>
            </span>
            <span className="inline-flex h-10 shrink-0 items-center rounded-[10px] border border-gray-300 bg-white px-3.5 text-sm font-semibold text-gray-700">
              {logoPreviewUrl ? "Change file" : "Choose file"}
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
        </div>
      </div>
    </div>
  );
}
