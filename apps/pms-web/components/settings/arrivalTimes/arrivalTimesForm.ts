import {
  BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS,
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  parseBookingGuestPolicyChoices,
  type BookingGuestLanguage,
  type BookingGuestPolicyChoices,
} from "@vayada/domain-booking";

/** Settings → Property → Check-in & check-out as the hotel edits it (VAY-2455, Timo's redesign): the guest rules,
 * with anything still open ("" when nothing is chosen yet). The optional windows keep their time while switched
 * off, so switching one back on shows it again. */
export type ArrivalForm = {
  checkInTime: string;
  checkInUntilOn: boolean;
  checkInUntil: string;
  checkOutTime: string;
  checkOutFromOn: boolean;
  checkOutFrom: string;
  language: BookingGuestLanguage | "";
  children: "yes" | "no" | "";
  adultAge: string;
  phoneRequired: boolean;
  arrivalTimeEnabled: boolean;
  specialRequestsEnabled: boolean;
};

/** Guest rules, or a draft of them with choices still open: the old PMS guest policy's draft leaves the language
 * and children open, and an empty one leaves everything open. */
export type ArrivalDraft = {
  defaultGuestLanguage?: BookingGuestLanguage | null;
  childrenEnabled?: boolean | null;
  adultAgeThreshold?: number | null;
  phoneRequired?: boolean;
  arrivalTimeEnabled?: boolean;
  specialRequestsEnabled?: boolean;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  checkInUntil?: string;
  checkOutFrom?: string;
};

export type ArrivalFieldError =
  | { kind: "pickTime" }
  | { kind: "laterThan"; time: string }
  | { kind: "earlierThan"; time: string }
  | { kind: "age" };

export type ArrivalFormCheck = {
  /** 5 settings must be chosen, 4 for adults-only hotels: the age only counts when children may stay. */
  required: number;
  done: number;
  missing: number;
  errors: Partial<Record<"checkInUntil" | "checkOutFrom" | "adultAge", ArrivalFieldError>>;
};

/** The save bar's line, most urgent first (Timo's six states). */
export type ArrivalSaveStatus = "missing" | "invalid" | "dirty" | "ready" | "saved" | "clean";

export const CHECK_IN_TIMES = ["14:00", "15:00", "16:00"];
export const CHECK_OUT_TIMES = ["10:00", "11:00", "12:00"];
export const ADULT_AGES = ["12", "16", "18", "21"];
/** The guest rules accept 1–21 (`parseBookingGuestPolicyChoices`). */
export const MAX_ADULT_AGE = 21;
/** "00:00" as the latest check-in means midnight at the end of the arrival day. */
export const MIDNIGHT = "00:00";

const LATEST_CHECK_IN = "22:00";
const EARLIEST_CHECK_OUT = "07:00";

export function formFromChoices(draft: ArrivalDraft): ArrivalForm {
  const language = draft.defaultGuestLanguage ?? "";
  return {
    checkInTime: draft.checkInTime ?? "",
    checkInUntilOn: typeof draft.checkInUntil === "string",
    checkInUntil: draft.checkInUntil ?? LATEST_CHECK_IN,
    checkOutTime: draft.checkOutTime ?? "",
    checkOutFromOn: typeof draft.checkOutFrom === "string",
    checkOutFrom: draft.checkOutFrom ?? EARLIEST_CHECK_OUT,
    language: (BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES as readonly string[]).includes(language)
      ? (language as BookingGuestLanguage)
      : "",
    children: draft.childrenEnabled == null ? "" : draft.childrenEnabled ? "yes" : "no",
    adultAge: draft.adultAgeThreshold == null ? "" : String(draft.adultAgeThreshold),
    phoneRequired: draft.phoneRequired ?? BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.phoneRequired,
    arrivalTimeEnabled:
      draft.arrivalTimeEnabled ?? BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.arrivalTimeEnabled,
    specialRequestsEnabled:
      draft.specialRequestsEnabled ??
      BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.specialRequestsEnabled,
  };
}

/** A whole number the guest rules accept, else null. */
export function adultAge(text: string): number | null {
  if (!/^\s*\d{1,2}\s*$/.test(text)) return null;
  const age = Number(text);
  return age >= 1 && age <= MAX_ADULT_AGE ? age : null;
}

export const ageCounts = (form: ArrivalForm) => form.children !== "no";

/** The guest rules to save, checked as the API checks them; null while anything is open or wrong. An optional window
 * is sent only while switched on. An adults-only hotel's age isn't shown, so it keeps the age it had (`keptAge`,
 * which the API preserves), never one typed before switching to adults only. */
export function choicesFromForm(
  form: ArrivalForm,
  keptAge: number | null = null,
): BookingGuestPolicyChoices | null {
  if (!form.language || !form.children) return null;
  return parseBookingGuestPolicyChoices({
    defaultGuestLanguage: form.language,
    childrenEnabled: form.children === "yes",
    adultAgeThreshold: form.children === "yes" ? adultAge(form.adultAge) : keptAge,
    phoneRequired: form.phoneRequired,
    arrivalTimeEnabled: form.arrivalTimeEnabled,
    specialRequestsEnabled: form.specialRequestsEnabled,
    checkInTime: form.checkInTime,
    checkOutTime: form.checkOutTime,
    ...(form.checkInUntilOn ? { checkInUntil: form.checkInUntil } : {}),
    ...(form.checkOutFromOn ? { checkOutFrom: form.checkOutFrom } : {}),
  });
}

/** The same rules as `bookingArrivalTimeErrors`, per field: check-in and check-out happen on different days, so
 * each window is only compared with itself. */
export function checkForm(form: ArrivalForm): ArrivalFormCheck {
  const errors: ArrivalFormCheck["errors"] = {};
  if (form.checkInUntilOn) {
    if (!form.checkInUntil) errors.checkInUntil = { kind: "pickTime" };
    else if (
      form.checkInTime &&
      form.checkInUntil !== MIDNIGHT &&
      form.checkInUntil <= form.checkInTime
    )
      errors.checkInUntil = { kind: "laterThan", time: form.checkInTime };
  }
  if (form.checkOutFromOn) {
    if (!form.checkOutFrom) errors.checkOutFrom = { kind: "pickTime" };
    else if (form.checkOutTime && form.checkOutFrom >= form.checkOutTime)
      errors.checkOutFrom = { kind: "earlierThan", time: form.checkOutTime };
  }
  if (ageCounts(form) && form.adultAge.trim() && adultAge(form.adultAge) === null)
    errors.adultAge = { kind: "age" };
  const chosen = [form.checkInTime, form.checkOutTime, form.language, form.children];
  if (ageCounts(form)) chosen.push(form.adultAge.trim());
  const done = chosen.filter(Boolean).length;
  return { required: chosen.length, done, missing: chosen.length - done, errors };
}

/** What the hotel would save, ignoring what doesn't count: a switched-off window's time, an adults-only age. */
function effective(form: ArrivalForm) {
  return {
    ...form,
    checkInUntil: form.checkInUntilOn ? form.checkInUntil : "",
    checkOutFrom: form.checkOutFromOn ? form.checkOutFrom : "",
    adultAge: ageCounts(form) ? form.adultAge.trim() : "",
  };
}

export function isDirty(form: ArrivalForm, saved: ArrivalForm): boolean {
  const a = effective(form);
  const b = effective(saved);
  return (Object.keys(a) as Array<keyof ArrivalForm>).some((key) => a[key] !== b[key]);
}

/** `confirmed`: the property has guest rules, so an unchanged form is already saved. */
export function saveStatus(
  check: ArrivalFormCheck,
  dirty: boolean,
  confirmed: boolean,
  justSaved: boolean,
): ArrivalSaveStatus {
  if (check.missing > 0) return "missing";
  if (Object.keys(check.errors).length) return "invalid";
  if (dirty) return "dirty";
  if (!confirmed) return "ready";
  return justSaved ? "saved" : "clean";
}

export const canSave = (status: ArrivalSaveStatus) => status === "dirty" || status === "ready";

export function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

/** Your day at a glance: each window as minutes of the day (0–1440). Check-out runs from its earliest time (else
 * the start of the day) to its deadline, check-in from its opening to its latest time (else the end of the day;
 * midnight is the end of the day). A window still wrong isn't drawn. */
export type ArrivalDay = {
  checkOut: { start: number; end: number; from: string | null; by: string } | null;
  checkIn: { start: number; end: number; from: string; until: string | null } | null;
  /** Minutes between the check-out deadline and check-in opening; null without both times. */
  turnover: number | null;
};

export function arrivalDay(form: ArrivalForm, check: ArrivalFormCheck): ArrivalDay {
  const from =
    form.checkOutFromOn && form.checkOutFrom && !check.errors.checkOutFrom
      ? form.checkOutFrom
      : null;
  const until =
    form.checkInUntilOn && form.checkInUntil && !check.errors.checkInUntil
      ? form.checkInUntil
      : null;
  const checkOut = form.checkOutTime
    ? {
        start: from ? minutes(from) : 0,
        end: minutes(form.checkOutTime),
        from,
        by: form.checkOutTime,
      }
    : null;
  const checkIn = form.checkInTime
    ? {
        start: minutes(form.checkInTime),
        end: until && until !== MIDNIGHT ? minutes(until) : 24 * 60,
        from: form.checkInTime,
        until,
      }
    : null;
  return {
    checkOut,
    checkIn,
    turnover: checkOut && checkIn ? checkIn.start - checkOut.end : null,
  };
}
