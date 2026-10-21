import type { FinanceSubscriptionService } from "@vayada/domain-finance";

import { firstRunUuid } from "./hotelFirstRunPricing.js";
import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 first run, step 7: the vayada plan the hotel picked in "How guests pay". Commission is selected
 * at once. Fixed Fee starts the Stripe checkout and waits: the plan only becomes active when Stripe confirms
 * the payment (invoice.paid), so the step reports the checkout link instead of "done".
 */

export type HotelFirstRunPlanPorts = Readonly<{
  plans: Pick<
    FinanceSubscriptionService,
    "getPlanStatus" | "selectCommissionPlan" | "createFixedPlanCheckout"
  >;
}>;

export type HotelFirstRunPlanChoice = "commission" | "fixed_fee";

export type HotelFirstRunPlanOutcome =
  | HotelFirstRunStepOutcome
  | Readonly<{ ok: true; wrote: boolean; checkoutUrl: string }>;

export async function runFirstRunPlan(
  ports: HotelFirstRunPlanPorts,
  actor: HotelFirstRunActor,
  input: Readonly<{ plan: HotelFirstRunPlanChoice; customerEmail: string | null }>,
): Promise<HotelFirstRunPlanOutcome> {
  const status = await ports.plans.getPlanStatus(actor.propertyId);
  // A plan the hotel already has is kept, whichever it is.
  if (status.plan) return Object.freeze({ ok: true, wrote: false });
  const context = (reason: string) => ({
    commandId: firstRunUuid(actor.propertyId, "first_run_plan_command", input.plan),
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "plan", input.plan),
    propertyId: actor.propertyId,
    organizationId: actor.organizationId,
    audit: {
      actor: { kind: "user" as const, userId: actor.userId, organizationId: actor.organizationId },
      requestId: actor.requestId,
      ...(actor.correlationId ? { correlationId: actor.correlationId } : {}),
      reason,
      requestedAt: actor.requestedAt,
    },
  });

  if (input.plan === "commission") {
    const result = await ports.plans.selectCommissionPlan(
      context("Select Commission Plan (hotel first run)"),
    );
    return result.ok
      ? Object.freeze({ ok: true, wrote: true })
      : Object.freeze({ ok: false, code: `first_run_plan_${result.code}`, cause: result });
  }
  if (!input.customerEmail)
    return Object.freeze({ ok: false, code: "first_run_plan_email_missing" });
  const result = await ports.plans.createFixedPlanCheckout({
    ...context("Start Fixed Plan checkout (hotel first run)"),
    customerEmail: input.customerEmail,
    returnSurface: "booking-admin",
  });
  return result.ok
    ? Object.freeze({ ok: true, wrote: true, checkoutUrl: result.value.checkoutUrl })
    : Object.freeze({ ok: false, code: `first_run_plan_${result.code}`, cause: result });
}
