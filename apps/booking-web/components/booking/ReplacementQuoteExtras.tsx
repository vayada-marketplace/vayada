"use client";

import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import {
  addonPerNight,
  addonPerPerson,
  buildReplacementAddonSelection,
  replacementExtraDates,
  replacementExtrasScope,
  type ExtraPerson,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";

export type ReplacementQuoteExtrasProps = {
  catalogue: PricingAddon[];
  selection: PublicBookingQuoteRequest["selection"] | null;
  allocationRevision: number;
  value: ReplacementExtrasValue | null;
  onChange: (value: ReplacementExtrasValue | null) => void;
};
const field = "block w-full rounded-lg border border-gray-300 p-3 mt-1 text-gray-900 bg-white";
const tick = "h-5 w-5 shrink-0";
const samePerson = (a: ExtraPerson, b: ExtraPerson) =>
  a.selectionId === b.selectionId && a.kind === b.kind && a.index === b.index;

/** Caller retires the quote on every edit and increments allocationRevision for room/guest changes. */
export default function ReplacementQuoteExtras({
  catalogue,
  selection,
  allocationRevision,
  value,
  onChange,
}: ReplacementQuoteExtrasProps) {
  const scope = selection ? replacementExtrasScope(catalogue, selection, allocationRevision) : null;
  const stale = value !== null && value.scope !== scope;
  const items = value?.items ?? [];
  const update = (id: string, patch: Partial<ReplacementExtrasValue["items"][number]>) => {
    if (scope && !stale)
      onChange({
        scope,
        items: items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      });
  };
  return (
    <section
      className="space-y-4 rounded-xl border border-gray-200 p-5"
      aria-label="Optional extras"
    >
      <h2 className="text-xl font-semibold">Optional extras</h2>
      <p>Choose your extras, guests and dates. We’ll include their prices in your updated quote.</p>
      {!selection || stale ? (
        <div role="status">
          <p>
            {stale
              ? "Your rooms, guests, dates or extra options changed. Clear these extras and select them again."
              : "Complete your room, guest, date and payment choices to choose extras."}
          </p>
          {value && (
            <button type="button" className="underline py-2" onClick={() => onChange(null)}>
              Clear extra selections
            </button>
          )}
        </div>
      ) : (
        <>
          {catalogue.filter((addon) => addon.currency === selection.currency).length === 0 && (
            <p>No optional extras are currently available.</p>
          )}
          {catalogue
            .filter((addon) => addon.currency === selection.currency)
            .map((addon) => {
              const item = items.find((item) => item.id === addon.id),
                perPerson = addonPerPerson(addon),
                perNight = addonPerNight(addon);
              return (
                <fieldset key={addon.id} className="space-y-3 border-t pt-3">
                  <legend className="font-semibold">{addon.name}</legend>
                  <label className="flex gap-3 items-center">
                    <input
                      type="checkbox"
                      className={tick}
                      checked={!!item}
                      disabled={!item && items.length >= 99}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [
                              ...items,
                              {
                                id: addon.id,
                                quantity: perPerson ? "1" : "",
                                people: [],
                                dates: [],
                              },
                            ]
                          : items.filter((selected) => selected.id !== addon.id);
                        onChange(next.length ? { scope: scope!, items: next } : null);
                      }}
                    />
                    Add {addon.name}
                  </label>
                  {item && (
                    <>
                      <p>
                        {perPerson ? "For selected guests" : "By quantity"}
                        {perNight ? ", on selected nights." : ", on one selected date."}
                      </p>
                      {addon.maxGuests !== null && (
                        <p>
                          {perPerson ? "Maximum selected guests" : "Maximum guests in your party"}:{" "}
                          {addon.maxGuests}.
                        </p>
                      )}
                      {!perPerson && (
                        <label className="block">
                          Quantity for {addon.name}
                          <input
                            type="number"
                            className={field}
                            min={1}
                            max={addon.maxQuantity}
                            step={1}
                            required
                            value={item.quantity}
                            onChange={(event) => update(addon.id, { quantity: event.target.value })}
                          />
                        </label>
                      )}
                      {perPerson && (
                        <fieldset className="space-y-2">
                          <legend>Guests for {addon.name}</legend>
                          {selection.rooms
                            .flatMap((room, roomIndex) => [
                              ...Array.from({ length: room.guests.adults }, (_, index) => ({
                                person: {
                                  selectionId: room.selectionId,
                                  kind: "adult" as const,
                                  index,
                                },
                                label: `Room ${roomIndex + 1}, adult ${index + 1}`,
                              })),
                              ...room.guests.childAgesAtCheckIn.map((age, index) => ({
                                person: {
                                  selectionId: room.selectionId,
                                  kind: "child" as const,
                                  index,
                                },
                                label: `Room ${roomIndex + 1}, child ${index + 1} (age ${age} at check-in)`,
                              })),
                            ])
                            .map(({ person, label }) => (
                              <label
                                key={JSON.stringify(person)}
                                className="flex gap-3 items-start"
                              >
                                <input
                                  type="checkbox"
                                  className={tick}
                                  checked={item.people.some((selected) =>
                                    samePerson(selected, person),
                                  )}
                                  onChange={(event) =>
                                    update(addon.id, {
                                      people: event.target.checked
                                        ? [...item.people, person]
                                        : item.people.filter(
                                            (selected) => !samePerson(selected, person),
                                          ),
                                    })
                                  }
                                />
                                {label}
                              </label>
                            ))}
                        </fieldset>
                      )}
                      {perNight ? (
                        <fieldset>
                          <legend>Nights for {addon.name} (choose each night)</legend>
                          <div className="max-h-40 overflow-y-auto space-y-2 py-2">
                            {replacementExtraDates(selection, true).map((date) => (
                              <label key={date} className="flex gap-3 items-center">
                                <input
                                  type="checkbox"
                                  className={tick}
                                  checked={item.dates.includes(date)}
                                  onChange={(event) =>
                                    update(addon.id, {
                                      dates: event.target.checked
                                        ? [...item.dates, date]
                                        : item.dates.filter((selected) => selected !== date),
                                    })
                                  }
                                />
                                {date}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      ) : (
                        <label className="block">
                          Date for {addon.name}
                          <select
                            className={field}
                            required
                            value={item.dates[0] ?? ""}
                            onChange={(event) =>
                              update(addon.id, {
                                dates: event.target.value ? [event.target.value] : [],
                              })
                            }
                          >
                            <option value="">Choose a date</option>
                            {replacementExtraDates(selection, false).map((date) => (
                              <option key={date} value={date}>
                                {date}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </fieldset>
              );
            })}
          {items.length > 0 &&
            buildReplacementAddonSelection(catalogue, selection, allocationRevision, value) ===
              null && (
              <p role="status">
                Complete each selected extra’s quantity, guests and dates within its limits, or
                remove it before requesting a price.
              </p>
            )}
        </>
      )}
    </section>
  );
}
