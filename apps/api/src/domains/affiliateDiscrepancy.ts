export type AffiliateClaimKind = "booking_attribution" | "earning" | "payment";
export type AffiliateClaimDecision = "denied" | "confirmed_earning" | "confirmed_payment";
export type AffiliateClaimCreatorScope = {
  organizationId: string;
  creatorProfileId: string;
  affiliateId: string;
};
export type AffiliateClaim = {
  claimId: string;
  kind: AffiliateClaimKind;
  status: "submitted" | AffiliateClaimDecision;
  agreementId: string;
  propertyId: string;
  bookingReference: string;
  payoutId: string | null;
  message: string;
  evidenceReferences: string[];
  decisionReason: string | null;
  decisionEvidenceReferences: string[];
  createdAt: string;
  resolvedAt: string | null;
};
export type AffiliateDiscrepancyRepository = {
  submit(input: {
    scope: AffiliateClaimCreatorScope;
    kind: AffiliateClaimKind;
    agreementId: string;
    propertyId: string;
    bookingId: string;
    payoutId: string | null;
    message: string;
    evidenceReferences: string[];
    actorUserId: string;
    requestId: string;
  }): Promise<{ claim: AffiliateClaim; replayed: boolean }>;
  list(scope: AffiliateClaimCreatorScope): Promise<AffiliateClaim[]>;
  get(scope: AffiliateClaimCreatorScope, claimId: string): Promise<AffiliateClaim | null>;
  close(): Promise<void>;
};
