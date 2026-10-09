import type { firstPricingInput } from "@vayada/product-onboarding/FirstPricingSetup";
import {
  samePricingValue,
  type createReplacementPricingClient,
  type PricingChargeReview,
} from "@vayada/product-onboarding/replacementPricingClient";

import { ApiErrorResponse } from "@/services/api/client";

type Client = ReturnType<typeof createReplacementPricingClient>;
export type FirstPricing = ReturnType<typeof firstPricingInput>;
export type CurrentPublication = Awaited<ReturnType<Client["read"]>>;

/** Completed stages of one publish attempt; a retry after a lost response resumes from here. */
export type PublishProgress = {
  draftId: string;
  terms: Record<string, () => Promise<{ revision: string }>>;
  termsRevisions: Record<string, string>;
  prepared?: Awaited<ReturnType<Client["prepare"]>>;
  draftRevision?: number;
  review?: PricingChargeReview;
  confirm?: ReturnType<Client["confirmationAction"]>;
  chargesId?: string;
  attachedRevision?: number;
  /** Draft saves sent without a known outcome; a retry reads the draft back first. */
  sent: { draft?: true; attached?: true };
  publish?: ReturnType<Client["publicationAction"]>;
};

export const newPublishProgress = (): PublishProgress => ({
  draftId: crypto.randomUUID(),
  terms: {},
  termsRevisions: {},
  sent: {},
});

/** Draft saves carry no idempotency key: after a lost response, keep the revision that landed. */
async function saveDraftOnce(
  client: Client,
  progress: PublishProgress,
  stage: "draft" | "attached",
  expectedRevision: number,
  save: () => Promise<number>,
): Promise<number> {
  if (progress.sent[stage]) {
    const saved = await client.readDraft(progress.draftId);
    if (saved?.revision === expectedRevision) return expectedRevision;
  }
  progress.sent[stage] = true;
  return save();
}

/**
 * Adds the first offers of unpriced rooms to the active publication, as the PMS pricing editor
 * does: stage each new offer's terms in a draft, prepare and save the draft, confirm that the
 * prices include every mandatory charge, attach that confirmation and publish.
 */
export async function publishFirstPricing(
  client: Client,
  current: CurrentPublication,
  added: readonly FirstPricing[],
  progress: PublishProgress,
): Promise<void> {
  const baseRevision = current?.revision ?? 0;
  const selected = { draftId: progress.draftId, baseRevision };
  const currency = current?.currency ?? added[0]?.configuration.currency;
  if (!currency || added.some(({ configuration }) => configuration.currency !== currency)) {
    throw new Error("Every room must be priced in the hotel currency.");
  }
  for (const { terms } of added) {
    const key = JSON.stringify([terms.roomTypeId, terms.offerId]);
    progress.terms[key] ??= client.termsAction(terms, selected);
    progress.termsRevisions[key] ??= (await progress.terms[key]!()).revision;
  }
  const rooms = [
    ...(current?.rooms ?? []),
    ...added.map(({ configuration, terms }) => ({
      ...configuration,
      offers: configuration.offers.map((offer) =>
        offer.id === terms.offerId
          ? {
              ...offer,
              termsRevision: progress.termsRevisions[JSON.stringify([terms.roomTypeId, offer.id])]!,
            }
          : offer,
      ),
    })),
  ].map((room) => ({ ...room, revision: baseRevision + 1 }));

  progress.prepared ??= await client.prepare({ currency, rooms }, selected);
  const prepared = progress.prepared;
  progress.draftRevision ??= await saveDraftOnce(client, progress, "draft", 1, () =>
    client.saveDraft({
      draftId: progress.draftId,
      expectedDraftRevision: 0,
      baseRevision,
      ...prepared,
    }),
  );
  if (!progress.review) {
    const review = await client.reviewCharges(progress.draftId);
    // Declare only for exactly what this attempt saved; another save in between means start again.
    if (
      !review ||
      review.revision !== progress.draftRevision ||
      !samePricingValue(review.snapshot, prepared.snapshot)
    ) {
      throw new ApiErrorResponse(409, { message: "The saved prices changed. Reload pricing." });
    }
    progress.review = review;
  }
  const review = progress.review;
  // Pressing "Publish prices" is the mandatory-charges declaration, as "Save prices" in the PMS.
  progress.confirm ??= client.confirmationAction(review, "save_prices");
  progress.chargesId ??= (await progress.confirm()).id;
  const snapshot = {
    ...review.snapshot,
    ownerReferences: { ...review.snapshot.ownerReferences, charges: progress.chargesId },
  };
  const effective = review.effectiveSources ? { effectiveSources: review.effectiveSources } : {};
  progress.attachedRevision ??= await saveDraftOnce(
    client,
    progress,
    "attached",
    review.revision + 1,
    () =>
      client.saveDraft({
        draftId: review.draftId,
        expectedDraftRevision: review.revision,
        baseRevision: review.baseRevision,
        sources: review.sources,
        ...effective,
        snapshot,
      }),
  );
  progress.publish ??= client.publicationAction({
    draftId: review.draftId,
    snapshot,
    revision: progress.attachedRevision,
    baseRevision: review.baseRevision,
    sources: review.sources,
    ...effective,
    stale: false,
  });
  await progress.publish();
}
