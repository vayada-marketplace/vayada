import { pricingDraftFixture } from "./pricingBookingDraft.fixtures.js";
import { calculateReplacementFixedCharges } from "./replacementFixedCharges.js";
export function preparationFixture() {
  const f = pricingDraftFixture((quote) => {
    const charges = calculateReplacementFixedCharges(quote.stay, {
      version: "booking.fixed-charges.v1",
      currency: "EUR",
      charges: [],
    })!;
    Object.assign(quote.evidence, { mandatoryChargeEvidenceId: charges.basisEvidenceId });
    Object.assign(quote.evidence.revisions, { charges: "charges:1" });
  });
  Object.assign(f.current, {
    calculation: {
      charges: {
        ...calculateReplacementFixedCharges(f.current.quote.stay, {
          version: "booking.fixed-charges.v1",
          currency: "EUR",
          charges: [],
        })!,
        sourceRevision: "charges:1",
      },
    },
  });
  const { fingerprint, ...input } = f.command;
  void fingerprint;
  return { ...f, input };
}
