"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";

import { SetupStepHeading } from "./SetupStepHeading";

export type SetupRoomChoiceValue = "now" | "skip";

const CHOICES = [
  {
    id: "now",
    title: "Set it up now",
    description:
      "About 5 minutes: the same details as in Rooms & Rates. Name, beds, guests, size, photos, description, location and amenities.",
    recommended: true,
  },
  {
    id: "skip",
    title: "Skip for now",
    description: "Add rooms later in Rooms & Rates. Your booking page can’t go live without one.",
    recommended: false,
  },
] as const;

/** Radio cards, as the mockup draws them (selected: a blue border and a filled ring). */
export function SetupRadioCard({
  title,
  description,
  selected,
  onSelect,
  badge,
}: {
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 ${
        selected
          ? "border-primary-600 bg-primary-50 ring-1 ring-inset ring-primary-600"
          : "border-gray-300 bg-white hover:bg-gray-50"
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          selected ? "border-2 border-primary-600" : "border-[1.5px] border-gray-400"
        }`}
      >
        {selected ? <span className="h-2.5 w-2.5 rounded-full bg-primary-600" /> : null}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-gray-950">
          {title}
          {badge ? (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="text-[13px] leading-5 text-gray-600">{description}</span>
      </span>
    </button>
  );
}

/**
 * VAY-2451 step 3, the choice: set the first room type up now (recommended) or later in Rooms & Rates, and
 * what setup sets for prices meanwhile (the first run's defaults, with the placeholder price).
 */
export function SetupRoomChoice({
  value,
  onChange,
  placeholderPrice,
}: {
  value: SetupRoomChoiceValue;
  onChange: (value: SetupRoomChoiceValue) => void;
  /** "Rs 100" in the hotel's currency. */
  placeholderPrice: string;
}) {
  return (
    <div>
      <SetupStepHeading
        title="Your first room type"
        subtitle="Optional. If you add it now, we ask for everything your booking page needs, except prices."
      />
      <div role="radiogroup" aria-label="Set up first room" className="mt-7 flex flex-col gap-3">
        {CHOICES.map((choice) => (
          <SetupRadioCard
            key={choice.id}
            title={choice.title}
            description={choice.description}
            badge={choice.recommended ? "Recommended" : undefined}
            selected={value === choice.id}
            onSelect={() => onChange(choice.id)}
          />
        ))}
      </div>
      <div className="mt-5 flex gap-3 rounded-xl bg-gray-50 p-4">
        <InformationCircleIcon className="h-5 w-5 shrink-0 text-primary-600" aria-hidden="true" />
        <div className="text-[13px] leading-5 text-gray-700">
          <p className="font-semibold text-gray-950">Prices aren&apos;t part of setup.</p>
          <p className="mt-1">
            We set these for you, and you change them later in Rooms &amp; Rates › Prices:
          </p>
          <p className="mt-1">
            {`${placeholderPrice} a night as a placeholder · open all year · min. 1 night · flexible rate, free cancellation until 3 days before · nothing paid when booking · room only, no meals`}
          </p>
        </div>
      </div>
    </div>
  );
}
