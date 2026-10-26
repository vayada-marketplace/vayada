"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { errorText } from "./pricingAmounts";
import { setMealDescription } from "./simplePricing";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];

/** "What guests read" about an option's meal (VAY-2281), in the option's window: any meal, the same field and limits
 * as breakfast in step "Meals". Applied as typed; text that can't be stored stays typed, says why and holds Save.
 * Room only has no meal to describe, so the field is left out. */
export function PricingMealText({
  room,
  offer,
  disabled,
  onChange,
  onPending,
}: {
  room: PricingConfiguration;
  offer: Offer;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const saved = offer.meal.description ?? "";
  const [typed, setTyped] = useState(saved);
  const [error, setError] = useState("");
  // A reload or a reset brings the saved text back; text that already means it (a trailing space) stays as typed.
  useEffect(() => setTyped((text) => (text.trim() === saved ? text : saved)), [saved]);
  // The editor's callback is new on every render, so it is read through a ref.
  const pendingRef = useRef(onPending);
  useEffect(() => {
    pendingRef.current = onPending;
  });
  const meal = offer.meal.kind !== "room_only";
  const pending = meal && !!error;
  useEffect(() => pendingRef.current(pending), [pending]);
  if (!meal) return null;
  const edit = (value: string) => {
    setTyped(value);
    try {
      onChange(setMealDescription(room, offer.id, value));
      setError("");
    } catch (cause) {
      setError(errorText(cause, t, "pricing.mealText.invalid"));
    }
  };
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className={ui.fieldLabel}>{t("pricing.mealText.label")}</span>
        <input
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          maxLength={200}
          disabled={disabled}
          value={typed}
          placeholder={t("pricing.mealText.placeholder")}
          onChange={(event) => edit(event.target.value)}
          className={`block w-full ${ui.field}`}
        />
      </label>
      {error && (
        <p id={errorId} role="alert" className={ui.errorText}>
          {error}
        </p>
      )}
    </div>
  );
}
