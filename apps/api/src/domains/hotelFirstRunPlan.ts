import type { FinanceSubscriptionService } from "@vayada/domain-finance";

import { firstRunUuid } from "./hotelFirstRunPricing.js";
import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";

/**
 * VAY-2247 first run, the plan step: the four-step setup asks for no plan (VAY-2451), so every new hotel gets
 * Commission (Settings › Billing changes it). A plan the hotel already has is kept, and a Fixed Fee checkout
 * the 7-step setup started is left to Stripe.
 */

export type HotelFirstRunPlanPorts = Readonly<{
  plans: Pick<FinanceSubscriptionService, "getPlanStatus" | "selectCommissionPlan">;
}>;

export async function runFirstRunPlan(
  ports: HotelFirstRunPlanPorts,
  actor: HotelFirstRunActor,
): Promise<HotelFirstRunStepOutcome> {
  const status = await ports.plans.getPlanStatus(actor.propertyId);
  // A plan the hotel already has is kept, whichever it is.
  if (status.plan) return Object.freeze({ ok: true, wrote: false });
  // Selecting Commission would expire a Fixed Fee checkout the hotel started; the plan waits for Stripe.
  if (status.checkoutPending) return Object.freeze({ ok: true, wrote: false });
  // The same command id and key as when the 7-step setup could pick a plan.
  const plan = "commission";
  const context = (reason: string) => ({
    commandId: firstRunUuid(actor.propertyId, "first_run_plan_command", plan),
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "plan", plan),
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

  const result = await ports.plans.selectCommissionPlan(
    context("Select Commission Plan (hotel first run)"),
  );
  return result.ok
    ? Object.freeze({ ok: true, wrote: true })
    : Object.freeze({ ok: false, code: `first_run_plan_${result.code}`, cause: result });
}
