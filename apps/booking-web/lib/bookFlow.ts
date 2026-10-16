import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import { isPricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
import type { RoomChoice } from "@/services/api/replacementOffers";
import type { ReplacementExtrasValue } from "@/services/api/replacementAddonSelection";
import { emptyGuest, type GuestDetails } from "@/components/booking/GuestDetailsForm";

/** The booking steps on /book (VAY-2195): `step` in the URL, no step is the room form. */
export type BookStep = "rooms" | "extras" | "details" | "payment";

const ORDER: readonly BookStep[] = ["rooms", "extras", "details", "payment"];

/** The steps this hotel's flow shows: Extras only when it has extras to offer. */
export function bookSteps(hasExtras: boolean): BookStep[] {
  return ORDER.filter((step) => step !== "extras" || hasExtras);
}

export function parseBookStep(value: string | null | undefined): BookStep {
  return ORDER.includes(value as BookStep) ? (value as BookStep) : "rooms";
}

/** The step to show for a requested one: a later step only opens when every step before it is
 * complete (a deep link or a refresh lands on the first one that isn't). */
export function reachableStep(
  wanted: BookStep,
  steps: readonly BookStep[],
  complete: Partial<Record<BookStep, boolean>>,
): BookStep {
  const target = steps.includes(wanted)
    ? wanted
    : (steps.find((s) => ORDER.indexOf(s) > ORDER.indexOf(wanted)) ?? "rooms");
  for (const step of steps) {
    if (step === target || !complete[step]) return step;
  }
  return target;
}

/** The /book query for a step, keeping everything the hotel page handed over. */
export function bookStepQuery(search: string, step: BookStep): string {
  const params = new URLSearchParams(search);
  if (step === "rooms") params.delete("step");
  else params.set("step", step);
  return params.toString();
}

/** What a guest has chosen so far, kept per tab so a refresh or Back doesn't lose it. Never the
 * acknowledgements (they belong to one price) and never card details. */
export type BookFlowDraft = {
  version: 1;
  /** The hotel page's hand-off this draft started from; a new hand-off starts afresh. */
  entry: string;
  checkIn: string;
  checkOut: string;
  promoCode: string;
  choices: RoomChoice[];
  allocationRevision: number;
  extras: ReplacementExtrasValue | null;
  payment: PricingPaymentMethod | "";
  guest: GuestDetails;
};

const ENTRY_PARAMS = ["checkIn", "checkOut", "adults", "children", "promoCode", "offer", "rooms"];

/** The hand-off part of a /book query, ignoring the step and anything else. */
export function bookEntry(search: string): string {
  const params = new URLSearchParams(search);
  return ENTRY_PARAMS.map((name) => `${name}=${params.get(name) ?? ""}`).join("&");
}

const key = (slug: string) => `bookFlow:${slug}`;
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 4000;

export function readBookFlowDraft(slug: string, entry: string): BookFlowDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(sessionStorage.getItem(key(slug)) ?? "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (
    d.version !== 1 ||
    d.entry !== entry ||
    ![d.checkIn, d.checkOut, d.promoCode].every(text) ||
    !Array.isArray(d.choices) ||
    d.choices.length > 99 ||
    !d.choices.every(
      (c) =>
        c &&
        typeof c === "object" &&
        text(c.selectionId) &&
        text(c.publicOfferKey) &&
        text(c.adults) &&
        Array.isArray(c.childAges) &&
        c.childAges.every(text),
    ) ||
    typeof d.allocationRevision !== "number" ||
    !(d.payment === "" || isPricingPaymentMethod(d.payment))
  )
    return null;
  const extras = d.extras as ReplacementExtrasValue | null;
  return {
    version: 1,
    entry,
    checkIn: d.checkIn as string,
    checkOut: d.checkOut as string,
    promoCode: d.promoCode as string,
    choices: d.choices as RoomChoice[],
    allocationRevision: d.allocationRevision,
    // The extras builder re-checks every item against the current catalogue and stay.
    extras: extras && typeof extras === "object" && Array.isArray(extras.items) ? extras : null,
    payment: d.payment as BookFlowDraft["payment"],
    guest: Object.fromEntries(
      (Object.keys(emptyGuest) as (keyof GuestDetails)[]).map((field) => {
        const value = (d.guest as Record<string, unknown> | undefined)?.[field];
        return [field, text(value) ? value : ""];
      }),
    ) as GuestDetails,
  };
}

export function saveBookFlowDraft(slug: string, draft: BookFlowDraft): void {
  try {
    sessionStorage.setItem(key(slug), JSON.stringify(draft));
  } catch {}
}

export function clearBookFlowDraft(slug: string): void {
  try {
    sessionStorage.removeItem(key(slug));
  } catch {}
}
