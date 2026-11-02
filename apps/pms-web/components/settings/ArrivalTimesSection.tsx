"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS,
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  bookingArrivalTimeErrors,
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
} from "@vayada/domain-booking";
import { SettingsCard } from "@vayada/settings-ui";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { arrivalTimesService } from "@/services/settings/arrivalTimes";
import {
  guestRulesSaveError,
  guestRulesService,
  type GuestRules,
} from "@/services/settings/guestRules";
import { useTranslation } from "@/lib/i18n";
import { forgetGuestStayTimes } from "@/lib/settings/useGuestStayTimes";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { humanizeApiError } from "./constants";

const fields = [
  ["checkInTime", "Guests can check in from", true],
  ["checkInUntil", "Check-in until (optional)", false],
  ["checkOutFrom", "Check-out from (optional)", false],
  ["checkOutTime", "Guests must check out by", true],
] as const;

type ArrivalDraft = Omit<
  BookingGuestPolicyChoices,
  "defaultGuestLanguage" | "childrenEnabled" | "checkInTime" | "checkOutTime"
> & {
  defaultGuestLanguage: BookingGuestPolicyChoices["defaultGuestLanguage"] | null;
  childrenEnabled: boolean | null;
  checkInTime: string | null;
  checkOutTime: string | null;
};

const EMPTY_DRAFT: ArrivalDraft = {
  defaultGuestLanguage: null,
  childrenEnabled: null,
  adultAgeThreshold: null,
  ...BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS,
  checkInTime: null,
  checkOutTime: null,
};

/** A property without guest rules yet starts from the PMS guest policy it saved before VAY-2455, else from its
 * catalog times (the old policy's draft), else from nothing chosen. */
async function firstDraft(signal: AbortSignal): Promise<ArrivalDraft> {
  try {
    const setup = await arrivalTimesService.load(signal);
    return { ...(setup.current?.bundle.choices ?? setup.draft ?? EMPTY_DRAFT) };
  } catch {
    return EMPTY_DRAFT;
  }
}

/** The check-in and check-out times and guest policies guests see on the booking page: the guest rules, which the
 * hotel's first run and Booking Admin's setup also save (VAY-2455). */
export function ArrivalTimesSection() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<GuestRules | null>(null);
  const [choices, setChoices] = useState<ArrivalDraft | null>(null);
  const [review, setReview] = useState<BookingGuestPolicyChoices | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setRules(null);
    setChoices(null);
    setError("");
    setLoadError(null);
    void (async () => {
      const id = await resolveSelectedPmsPropertyId("loading arrival times");
      const value = await guestRulesService.load(controller.signal, id);
      return { id, value, draft: value ? value.choices : await firstDraft(controller.signal) };
    })()
      .then(({ id, value, draft }) => {
        if (controller.signal.aborted) return;
        setPropertyId(id);
        setRules(value);
        setChoices(draft);
        setReview(null);
        setConfirmed(false);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setLoadError(cause);
        setError(humanizeApiError(cause, "Arrival times could not be loaded."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!choices) return;
    setError("");
    if (!review) {
      if (
        !choices.defaultGuestLanguage ||
        choices.childrenEnabled === null ||
        !choices.checkInTime ||
        !choices.checkOutTime
      ) {
        setError("Choose a guest language, child policy and both required times before reviewing.");
        return;
      }
      const parsed = parseBookingGuestPolicyChoices(choices);
      if (!parsed) {
        setError(
          bookingArrivalTimeErrors(choices)[0] ??
            "Choose an adult age from 1 to 21 when children are welcome.",
        );
        return;
      }
      setReview(parsed);
      setKey(`arrival-times:${crypto.randomUUID()}`);
      return;
    }
    if (!confirmed) return;
    setSaving(true);
    try {
      await guestRulesService.save(propertyId, rules?.revision ?? null, review, key);
      forgetGuestStayTimes();
      setSaved(true);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(guestRulesSaveError(cause));
    } finally {
      setSaving(false);
    }
  };
  const updateChoices = (patch: Partial<ArrivalDraft>) => {
    setChoices((current) => (current ? { ...current, ...patch } : current));
    setReview(null);
    setConfirmed(false);
    setSaved(false);
  };

  return (
    <SettingsCard>
      {loading ? (
        <p className="text-sm" role="status">
          Loading arrival times…
        </p>
      ) : (
        <div className="space-y-3">
          {error && (
            <p className="text-sm text-red-700" role="alert">
              {localizedErrorText(loadError, error, t)}
            </p>
          )}
          {saved && (
            <p className="text-sm text-green-700" role="status">
              Arrival times saved. A live booking page shows them within a minute.
            </p>
          )}
          {!choices ? (
            <p className="text-sm">
              Arrival times are unavailable. Retry loading your property settings.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-xs text-gray-500">
                Times use your property timezone. Leave optional times empty for check-in from a
                time or check-out by a time.
              </p>
              {!rules && (
                <fieldset disabled={saving} className="space-y-3 text-sm">
                  <legend className="mb-2 font-medium">Confirm your initial guest policy</legend>
                  <p>
                    Existing arrival times are prefilled when available. Choose the remaining guest
                    policies before saving.
                  </p>
                  <label className="block">
                    Default guest language
                    <select
                      required
                      value={choices.defaultGuestLanguage ?? ""}
                      onChange={(event) =>
                        updateChoices({
                          defaultGuestLanguage: event.target
                            .value as BookingGuestPolicyChoices["defaultGuestLanguage"],
                        })
                      }
                      className="ml-2 rounded border p-2"
                    >
                      <option value="">Choose a language</option>
                      {BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES.map((language) => (
                        <option key={language} value={language}>
                          {language}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    Are children welcome?
                    <select
                      required
                      value={
                        choices.childrenEnabled === null ? "" : String(choices.childrenEnabled)
                      }
                      onChange={(event) =>
                        updateChoices({ childrenEnabled: event.target.value === "true" })
                      }
                      className="ml-2 rounded border p-2"
                    >
                      <option value="">Choose a child policy</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </label>
                  {choices.childrenEnabled && (
                    <label className="block">
                      Adult age threshold
                      <input
                        type="number"
                        min={1}
                        max={21}
                        required
                        value={choices.adultAgeThreshold ?? ""}
                        onChange={(event) =>
                          updateChoices({
                            adultAgeThreshold: event.target.value
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                        className="ml-2 w-20 rounded border p-2"
                      />
                    </label>
                  )}
                  {(
                    [
                      ["phoneRequired", "Require phone number"],
                      ["arrivalTimeEnabled", "Ask for arrival time"],
                      ["specialRequestsEnabled", "Allow special requests"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field} className="block">
                      <input
                        type="checkbox"
                        checked={choices[field]}
                        onChange={(event) => updateChoices({ [field]: event.target.checked })}
                        className="mr-2"
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {fields.map(([field, label, required]) => (
                  <label key={field} className="text-sm">
                    {label}
                    <input
                      type="time"
                      required={required}
                      disabled={saving}
                      value={choices[field] ?? ""}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2"
                      onChange={(event) => {
                        const next = { ...choices };
                        if (
                          (field === "checkInUntil" || field === "checkOutFrom") &&
                          !event.target.value
                        )
                          delete next[field];
                        else next[field] = event.target.value;
                        setChoices(next);
                        setReview(null);
                        setConfirmed(false);
                        setSaved(false);
                      }}
                    />
                  </label>
                ))}
              </div>
              {review && (
                <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm">
                  <p>
                    Check-in: {review.checkInTime}
                    {review.checkInUntil ? `–${review.checkInUntil}` : " onwards"}. Check-out:{" "}
                    {review.checkOutFrom ? `${review.checkOutFrom}–` : "by "}
                    {review.checkOutTime}.
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={saving}
                    />
                    I have reviewed how these times and guest policies will appear to guests.
                  </label>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  disabled={saving || Boolean(review && !confirmed)}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : review ? "Save arrival times" : "Review policy"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  className="text-sm underline"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Reload saved values
                </button>
              </div>
            </form>
          )}
          {!choices && (
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
              className="text-sm underline"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
