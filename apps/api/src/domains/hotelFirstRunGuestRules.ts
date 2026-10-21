import {
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  FIRST_RUN_BOOKING_DESIGN,
  FIRST_RUN_GUEST_TERMS,
  firstRunGuestPolicy,
  type BookingDesignCommandPort,
  type BookingDesignReadPort,
  type BookingGuestLanguage,
} from "@vayada/domain-booking";

import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 first run, step 6, saved last because nothing after it can make it stale: the booking page
 * shows the city and country, the guest rules (children welcome, 15:00 / 11:00, the hotel's language), the
 * default guest terms and the Classic page style. Each is written only when the hotel has none yet.
 */

type Scope = { propertyId: string; organizationId: string; actorUserId: string };

export type HotelFirstRunGuestRulesPorts = Readonly<{
  /** Turns on "show city and country" on the hotel profile; the wiring reuses the profile writer. */
  locality: {
    showCityAndCountry(actor: HotelFirstRunActor): Promise<{ ok: boolean; code?: string }>;
  };
  guestRules: {
    read(scope: Scope): Promise<{ revision: string; choices: unknown } | null>;
    save(scope: Scope, input: unknown): Promise<unknown>;
  };
  terms: {
    read(scope: Scope): Promise<{ termsText: string | null }>;
    save(scope: Scope, text: unknown, expected: unknown): Promise<{ termsText: string }>;
  };
  designRead: BookingDesignReadPort;
  design: BookingDesignCommandPort;
}>;

export type HotelFirstRunGuestRulesInput = Readonly<{
  /** The hotel's language; guest rules fall back to English when the booking page can't speak it. */
  language: string | null;
  hasCity: boolean;
  localityPublic: boolean;
}>;

const fail = (code: string, cause?: unknown): HotelFirstRunStepOutcome =>
  Object.freeze({ ok: false, code, cause });

export function firstRunGuestLanguage(language: string | null): BookingGuestLanguage {
  const code = (language ?? "").trim().toLowerCase().slice(0, 2);
  return (BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES as readonly string[]).includes(code)
    ? (code as BookingGuestLanguage)
    : "en";
}

export async function runFirstRunGuestRules(
  ports: HotelFirstRunGuestRulesPorts,
  actor: HotelFirstRunActor,
  input: HotelFirstRunGuestRulesInput,
): Promise<HotelFirstRunStepOutcome> {
  const scope = {
    propertyId: actor.propertyId,
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
  };
  let wrote = false;

  if (input.hasCity && !input.localityPublic) {
    const shown = await ports.locality.showCityAndCountry(actor);
    if (!shown.ok) return fail(shown.code ?? "first_run_locality_failed");
    wrote = true;
  }

  if (!(await ports.guestRules.read(scope))) {
    const choices = firstRunGuestPolicy(firstRunGuestLanguage(input.language));
    await ports.guestRules.save(scope, {
      requestId: firstRunIdempotencyKey(actor.propertyId, "guest_rules", choices),
      expectedRevision: null,
      confirmed: true,
      choices,
    });
    wrote = true;
  }

  if (!(await ports.terms.read(scope)).termsText) {
    await ports.terms.save(scope, FIRST_RUN_GUEST_TERMS, null);
    wrote = true;
  }

  if (
    !(await ports.designRead.getCurrentDesign({
      organizationId: actor.organizationId,
      propertyId: actor.propertyId,
    }))
  ) {
    const result = await ports.design.upsertDesign({
      organizationId: actor.organizationId,
      propertyId: actor.propertyId,
      actorUserId: actor.userId,
      idempotencyKey: firstRunIdempotencyKey(
        actor.propertyId,
        "booking_design",
        FIRST_RUN_BOOKING_DESIGN,
      ),
      audit: {
        requestId: actor.requestId,
        ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
        source: "hotel_first_run",
      },
      expectedRevision: 0,
      choices: FIRST_RUN_BOOKING_DESIGN,
    });
    if (!result.ok) return fail("first_run_booking_design_failed", result.error);
    wrote = true;
  }
  return Object.freeze({ ok: true, wrote });
}
