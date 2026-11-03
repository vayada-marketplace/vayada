import { createHash } from "node:crypto";

import { FIRST_RUN_DEFAULTS_VERSION } from "@vayada/domain-booking";
import {
  parseReplaceFinancePaymentMethodsCommand,
  type FinancePaymentMethodsCommandPort,
  type FinancePaymentReadinessReadPort,
} from "@vayada/domain-finance";
import {
  parseUpsertPropertyPricingCurrencyCommand,
  type DraftRoomTypeBindingReadPort,
  type PhysicalRoomUnitIdentityReadPort,
  type PmsPricingCommandPort,
  type PmsPricingReadPort,
  type RoomCapacityReadPort,
  type RoomFactsReadPort,
} from "@vayada/domain-pms";
import { defaultCurrencyForCountry } from "@vayada/locale-constants";

/**
 * VAY-2247 first run: the currency and payments steps. Each step reads first, writes only what is
 * missing and never overwrites what the owner set. Keys are derived from the property, the step and its
 * input, so a retry or a resume after a crash replays the same command instead of writing twice.
 */

export type HotelFirstRunActor = Readonly<{
  organizationId: string;
  propertyId: string;
  userId: string;
  requestId: string;
  correlationId: string | null;
  requestedAt: string;
}>;

/** The fixed setup-draft id of the setup's room type at `index` (the four-step setup makes the first). */
export function firstRunDraftRoomId(index: number): string {
  return `first-run-room-${index + 1}`;
}

/** The first run looks for the setup's room types under this many draft ids (the 7-step setup made up to 10). */
export const FIRST_RUN_MAX_ROOM_TYPES = 10;

export type HotelFirstRunStepOutcome =
  | Readonly<{ ok: true; wrote: boolean }>
  | Readonly<{ ok: false; code: string; cause?: unknown }>;

export type HotelFirstRunSetupPorts = Readonly<{
  pricingRead: Pick<PmsPricingReadPort, "getPropertyPricingCurrency">;
  currency: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency">;
  roomRead: Pick<RoomFactsReadPort, "listRoomTypeFacts"> &
    DraftRoomTypeBindingReadPort &
    RoomCapacityReadPort &
    PhysicalRoomUnitIdentityReadPort;
  paymentRead: FinancePaymentReadinessReadPort;
  payments: FinancePaymentMethodsCommandPort;
}>;

/** `first-run:v1:<step>:<sha256>`: the same property, step and input always give the same key (≤ 200 chars). */
export function firstRunIdempotencyKey(propertyId: string, step: string, input: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([FIRST_RUN_DEFAULTS_VERSION, propertyId, step, input]))
    .digest("hex");
  return `first-run:v1:${step}:${digest}`;
}

function audit(actor: HotelFirstRunActor) {
  return {
    actor: { kind: "user" as const, userId: actor.userId },
    requestId: actor.requestId,
    correlationId: actor.correlationId,
    requestedAt: actor.requestedAt,
  };
}

const fail = (code: string, cause?: unknown) => Object.freeze({ ok: false as const, code, cause });
const ok = (wrote: boolean): HotelFirstRunStepOutcome => Object.freeze({ ok: true, wrote });

/** Step 1: the hotel's currency from its country, unless it already has one. */
export async function runFirstRunCurrency(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
  countryCode: string | null,
): Promise<HotelFirstRunStepOutcome> {
  if (await ports.pricingRead.getPropertyPricingCurrency(actor.propertyId)) return ok(false);
  const currency = defaultCurrencyForCountry(countryCode);
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId: actor.organizationId,
    propertyId: actor.propertyId,
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "currency", currency),
    audit: audit(actor),
    expectedPricingCurrencyRevision: 0,
    currency,
  });
  if (!command) return fail("first_run_currency_invalid");
  const result = await ports.currency.upsertPropertyPricingCurrency(command);
  return result.ok ? ok(true) : fail("first_run_currency_failed", result.error);
}

/** Step 3: pay at the property, unless payment methods are already chosen for the current currency. */
export async function runFirstRunPayments(
  ports: HotelFirstRunSetupPorts,
  actor: HotelFirstRunActor,
): Promise<HotelFirstRunStepOutcome> {
  const scope = { organizationId: actor.organizationId, propertyId: actor.propertyId };
  const readiness = await ports.paymentRead.getPaymentReadiness(scope);
  const current =
    readiness?.pricingCurrency.current ?? (await currentCurrency(ports, actor.propertyId));
  if (!current) return fail("first_run_payments_currency_missing");
  const selected =
    readiness?.methods.filter((method) => method.selected).map((method) => method.method) ?? [];
  if (selected.includes("pay_at_property") && readiness?.pricingCurrency.matchesCurrent)
    return ok(false);
  // Keep any method the owner already chose; add pay at the property.
  const selectedMethods = [...new Set([...selected, "pay_at_property"])];
  const command = parseReplaceFinancePaymentMethodsCommand({
    ...scope,
    idempotencyKey: firstRunIdempotencyKey(actor.propertyId, "payments", [
      readiness?.paymentMethodsRevision ?? 0,
      current.pricingCurrencyRevision,
      selectedMethods,
    ]),
    expectedPaymentMethodsRevision: readiness?.paymentMethodsRevision ?? 0,
    expectedPricingCurrencyRevision: current.pricingCurrencyRevision,
    selectedMethods,
    audit: audit(actor),
  });
  if (!command) return fail("first_run_payments_invalid");
  const result = await ports.payments.replacePaymentMethods(command);
  return result.ok ? ok(true) : fail("first_run_payments_failed", result.error);
}

async function currentCurrency(ports: HotelFirstRunSetupPorts, propertyId: string) {
  const snapshot = await ports.pricingRead.getPropertyPricingCurrency(propertyId);
  return snapshot ? { pricingCurrencyRevision: snapshot.pricingCurrencyRevision } : null;
}
