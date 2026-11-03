import { createHash } from "node:crypto";

import {
  FIRST_RUN_PLACEHOLDER_PRICE_PER_NIGHT,
  firstRunPricing,
  type FirstRunFreeCancellationDays,
} from "@vayada/domain-booking";
import type { PricingCapacity } from "@vayada/domain-pms";

import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";
import type { createReplacementPricingCommands } from "./replacementPricingCommands.js";
import { PricingStorageError } from "./replacementPricingStore.js";

/**
 * VAY-2247 first run, the pricing step: the placeholder price for the setup's room type (VAY-2451), published
 * the way the setup screen did it (publishFirstPricing): stage the offer's terms in a draft → prepare → save the
 * draft → review the charges → the "prices include all mandatory taxes and fees" declaration, made by the
 * first run for the placeholder only → attach it → publish.
 *
 * Retries replay: the draft id, the offer id and every request id are derived from the property and the
 * input. Draft saves carry no key, so the draft is read back before saving again.
 */

type PricingCommands = ReturnType<typeof createReplacementPricingCommands>;
export type HotelFirstRunPricingPorts = Readonly<{
  pricing: Pick<
    PricingCommands,
    | "read"
    | "readDraft"
    | "stageTerms"
    | "prepare"
    | "saveDraft"
    | "reviewCharges"
    | "confirmCharges"
    | "publish"
  >;
}>;

/**
 * VAY-2451: the four-step setup asks for no price. The setup's room type gets FIRST_RUN_PLACEHOLDER_PRICE_PER_NIGHT,
 * and the system makes the taxes declaration for that price only (recorded as made by the first run); any real
 * price needs the owner's own declaration in Prices. Its publish carries the placeholder step in its request id,
 * which keeps the booking page from being published until real prices replace it.
 */
export type HotelFirstRunPricingInput = Readonly<{
  roomTypeId: string;
  capacity: PricingCapacity;
  currency: string;
  /** Free cancellation until this many days before arrival (the first run's default, 3). */
  freeCancellationDays?: FirstRunFreeCancellationDays;
}>;

/** The request-id step of the placeholder price's publish (VAY-2451); the old first run used "pricing_publish". */
export const FIRST_RUN_PLACEHOLDER_PUBLISH_STEP = "pricing_placeholder_publish";

/** Whether a pricing revision is the first run's placeholder publish (its request id, see firstRunIdempotencyKey). */
export function isFirstRunPlaceholderPricingRequestId(requestId: unknown): boolean {
  return (
    typeof requestId === "string" &&
    requestId.startsWith(`first-run:v1:${FIRST_RUN_PLACEHOLDER_PUBLISH_STEP}:`)
  );
}

/** A stable UUID (v4 layout) from the parts, for draft and offer ids the pricing store requires to be UUIDs. */
export function firstRunUuid(...parts: unknown[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const fail = (code: string, cause?: unknown): HotelFirstRunStepOutcome =>
  Object.freeze({ ok: false, code, cause });

export async function runFirstRunPricing(
  ports: HotelFirstRunPricingPorts,
  actor: HotelFirstRunActor,
  input: HotelFirstRunPricingInput,
): Promise<HotelFirstRunStepOutcome> {
  try {
    return await publish(ports.pricing, actor.propertyId, input);
  } catch (error) {
    if (error instanceof PricingStorageError) return fail(`first_run_pricing_${error.code}`, error);
    throw error;
  }
}

async function publish(
  pricing: HotelFirstRunPricingPorts["pricing"],
  propertyId: string,
  input: HotelFirstRunPricingInput,
): Promise<HotelFirstRunStepOutcome> {
  // VAY-2451: the placeholder only ever comes first. A hotel with prices keeps them and its setup room waits
  // for the owner's own price, so the system's declaration never covers prices the owner set.
  if (await pricing.read(propertyId)) return Object.freeze({ ok: true, wrote: false });
  const baseRevision = 0;
  const offerId = firstRunUuid(propertyId, "first_run_offer", input.roomTypeId);
  const built = firstRunPricing({
    propertyId,
    offerId,
    roomTypeId: input.roomTypeId,
    capacity: input.capacity,
    currency: input.currency,
    pricePerNight: FIRST_RUN_PLACEHOLDER_PRICE_PER_NIGHT,
    freeCancellationDays: input.freeCancellationDays,
  });
  if (!built) return fail("first_run_price_invalid");
  // The terms are part of the draft: a retry with another cancellation choice stages a new draft rather
  // than replaying the first one's terms request with different terms.
  const draftId = firstRunUuid(
    propertyId,
    "first_run_pricing_draft",
    baseRevision,
    built.configuration,
    built.terms.cancellation,
    // Kept from when the 7-step setup's own prices shared this path: the same draft id as before (VAY-2451).
    "placeholder",
  );
  const draftContext = { draftId, baseRevision };
  const key = (step: string) => firstRunIdempotencyKey(propertyId, step, [draftId]);

  const { expectedRevision, ...terms } = built.terms;
  const staged = await pricing.stageTerms(
    propertyId,
    { requestId: key("pricing_terms"), expectedRevision, terms },
    draftContext,
  );
  const rooms = [
    {
      ...built.configuration,
      offers: built.configuration.offers.map((offer) =>
        offer.id === offerId ? { ...offer, termsRevision: staged.revision } : offer,
      ),
      revision: baseRevision + 1,
    },
  ];
  const prepared = await pricing.prepare(
    propertyId,
    { currency: input.currency, rooms },
    draftContext,
  );
  if (!(await pricing.readDraft(propertyId, draftId))) {
    await pricing.saveDraft(propertyId, {
      draftId,
      expectedDraftRevision: 0,
      baseRevision,
      ...prepared,
    });
  }

  const review = await pricing.reviewCharges(propertyId, draftId);
  if (!review) return fail("first_run_pricing_draft_missing");
  let snapshot = review.snapshot;
  let draftRevision = review.revision;
  const effective = review.effectiveSources ? { effectiveSources: review.effectiveSources } : {};
  if (!review.snapshot.ownerReferences.charges) {
    const declared = await pricing.confirmCharges(propertyId, {
      draftId,
      expectedDraftRevision: review.revision,
      claimedFingerprint: review.fingerprint,
      declaration: review.declaration,
      declaredVia: "first_run_placeholder",
      requestId: key("pricing_charges"),
    });
    snapshot = {
      ...review.snapshot,
      ownerReferences: { ...review.snapshot.ownerReferences, charges: declared.id },
    };
    draftRevision = await pricing.saveDraft(propertyId, {
      draftId,
      expectedDraftRevision: review.revision,
      baseRevision: review.baseRevision,
      sources: review.sources,
      ...effective,
      snapshot,
    });
  }
  await pricing.publish(propertyId, {
    expectedRevision: review.baseRevision,
    sources: review.sources,
    ...effective,
    snapshot,
    draft: { id: draftId, revision: draftRevision },
    requestId: key(FIRST_RUN_PLACEHOLDER_PUBLISH_STEP),
  });
  return Object.freeze({ ok: true, wrote: true });
}
