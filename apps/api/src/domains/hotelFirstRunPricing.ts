import { createHash } from "node:crypto";

import { firstRunPricing, type FirstRunFreeCancellationDays } from "@vayada/domain-booking";
import type { PricingCapacity } from "@vayada/domain-pms";

import {
  firstRunIdempotencyKey,
  type HotelFirstRunActor,
  type HotelFirstRunStepOutcome,
} from "./hotelFirstRunSteps.js";
import type { createReplacementPricingCommands } from "./replacementPricingCommands.js";
import { PricingStorageError } from "./replacementPricingStore.js";

/**
 * VAY-2247 first run, step 4: the first room type's price, published the way the setup screen does it
 * (publishFirstPricing): stage the offer's terms in a draft → prepare → save the draft → review the charges →
 * the hotel's "my prices include all mandatory taxes and fees" declaration → attach it → publish.
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

export type HotelFirstRunPricingInput = Readonly<{
  roomTypeId: string;
  capacity: PricingCapacity;
  currency: string;
  pricePerNight: string;
  /** The tick under the price; the declaration is the hotel's own and is never assumed. */
  pricesIncludeMandatoryCharges: boolean;
  /** The owner's cancellation choice (1.12b); 3 when not given. */
  freeCancellationDays?: FirstRunFreeCancellationDays;
}>;

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
  if (!input.pricesIncludeMandatoryCharges) return fail("mandatory_charges_declaration_required");
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
  const current = await pricing.read(propertyId);
  if (
    current?.rooms.some((room) => room.roomTypeId === input.roomTypeId && room.offers.length > 0)
  ) {
    return Object.freeze({ ok: true, wrote: false });
  }
  if (current && current.currency !== input.currency)
    return fail("first_run_pricing_currency_mismatch");
  const baseRevision = current?.revision ?? 0;
  const offerId = firstRunUuid(propertyId, "first_run_offer", input.roomTypeId);
  const built = firstRunPricing({ propertyId, offerId, ...input });
  if (!built) return fail("first_run_price_invalid");
  // The terms are part of the draft: a retry with another cancellation choice stages a new draft rather
  // than replaying the first one's terms request with different terms.
  const draftId = firstRunUuid(
    propertyId,
    "first_run_pricing_draft",
    baseRevision,
    built.configuration,
    built.terms.cancellation,
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
    ...(current?.rooms ?? []),
    {
      ...built.configuration,
      offers: built.configuration.offers.map((offer) =>
        offer.id === offerId ? { ...offer, termsRevision: staged.revision } : offer,
      ),
    },
  ].map((room) => ({ ...room, revision: baseRevision + 1 }));
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
      declaredVia: "save_prices",
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
    requestId: key("pricing_publish"),
  });
  return Object.freeze({ ok: true, wrote: true });
}
