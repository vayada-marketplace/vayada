import type pg from "pg";

import type { MigrationEnvironment } from "./runner.js";

export type ParityCheckSeverity = "fail" | "warn";

export type ParityFinding = {
  severity: ParityCheckSeverity;
  code: string;
  owner: string;
  targetObject: string;
  message: string;
  expected: string;
  actual: string;
  suggestedAction?: string;
};

export type ParityReport = {
  runId: string;
  environment: MigrationEnvironment;
  fixtureCase: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  summary: {
    failures: number;
    warnings: number;
  };
  findings: ParityFinding[];
};

export type ParityConfig = {
  connectionString: string;
  fixtureCase: string;
  fixturesDir: string;
  environment: MigrationEnvironment;
};

export type ExpectedTarget = {
  counts: Record<string, number>;
  idStability: Record<string, string[]>;
  uniquenessChecks?: string[];
  identityChecks?: {
    memberships?: Array<{
      organizationId: string;
      userId: string;
      status: string;
      roleKey: string;
    }>;
    resourceLinks?: Array<{
      organizationId: string;
      product: string;
      resourceType: string;
      resourceId: string;
      relationship: string;
      status: string;
    }>;
    entitlements?: Array<{
      organizationId: string;
      product: string;
      entitlementKey: string;
      status: string;
      resourceProduct: string | null;
      resourceType: string | null;
      resourceId: string | null;
    }>;
    rolePermissionGrants?: Array<{
      organizationKind: string;
      roleKey: string;
      permissionKey: string;
    }>;
    permissionKeys?: string[];
  };
  catalogPublicProfileChecks?: {
    completePropertyIds?: string[];
    missingLocationPropertyIds?: string[];
    customDomainProperties?: Array<{
      propertyId: string;
      hostname: string;
    }>;
    forbiddenPublicProfileKeys?: string[];
  };
  bookingCheckoutChecks?: {
    flows: Array<{
      propertyId: string;
      organizationId: string;
      bookingHotelResourceId: string;
      quoteSessionId: string;
      checkoutContextId: string;
      guestBookingId: string;
      paymentId: string;
      publicQuoteReference: string;
      publicBookingReference: string;
      lifecycleStatus: string;
      paymentStatus: string;
      paymentAmount: string;
      currency: string;
      guestCount: number;
      addonSelectionCount: number;
      promoApplicationCount: number;
      statusEventCount: number;
      bookerCountryCode: string | null;
      bookerCountryCodeRaw: string | null;
      bookerCountryCodeReviewRequired: boolean;
    }>;
    settings?: Array<{
      propertyId: string;
      bookingHotelResourceId: string;
      showAddonsStep: boolean;
      groupAddonsByCategory: boolean;
      specialRequestsEnabled: boolean;
      arrivalTimeEnabled: boolean;
      guestCountEnabled: boolean;
      phoneRequired: boolean;
      adultAgeThreshold: number;
      childrenEnabled: boolean;
      benefits: string[];
      defaultCurrency: string;
      defaultLanguage: string;
      supportedCurrencies: string[];
      supportedLanguages: string[];
      bookingFilters: string[];
      customFilters: Record<string, string>;
      filterRooms: Record<string, string[]>;
      sourceFreshness: Record<string, unknown>;
      heroImageUrl: string | null;
      heroHeading: string | null;
      heroSubtext: string | null;
      primaryColor: string;
      fontPairing: string;
      acceptanceMode: "instant" | "request";
    }>;
    forbiddenSummaryKeys?: string[];
  };
  financeChecks?: {
    propertyFlows?: Array<{
      propertyId: string;
      organizationId: string;
      ownerUserId: string;
      bookingHotelResourceId: string;
      pmsHotelResourceId: string;
      providerAccountId: string;
      paymentId: string;
      guestBookingId: string;
      payoutSettingsId: string;
      payoutId: string;
      commissionRuleId: string;
      commissionRateChangeId: string;
      identityEntitlementId: string;
      billingEntitlementId: string;
      visibilityReadModelId: string;
      sourcePaymentId: string;
      providerAccountRef: string;
      providerPaymentIntentId: string;
      providerPayoutId: string;
      paymentAmount: string;
      netPaymentAmount: string;
      payoutAmount: string;
      commissionRate: string;
      currency: string;
      visibilityScope: string;
      requiredPermissionKey: string;
    }>;
    forbiddenVisibilityKeys?: string[];
  };
  pmsOperationsChecks?: {
    properties: Array<{
      propertyId: string;
      organizationId: string;
      pmsHotelResourceId: string;
      roomTypeId: string;
      roomId: string;
      ratePlanId: string;
      rateRuleId: string;
      inventoryDate: string;
      inventoryStatus: string;
      roomBlockId: string;
      guestBookingId: string;
      assignmentId: string;
      checkinRecordId: string;
      checkoutChargeId: string;
      checkoutRecordId: string;
      privateNoteId: string;
      messageThreadId: string;
      messageId: string;
      messageAttachmentId: string;
      channelConnectionId: string;
      channelRoomTypeMappingId: string;
      channelRatePlanMappingId: string;
      channelBookingMappingId: string;
      bookingSyncStatusId: string;
      roomTypeSourceSystem: string;
      roomSourceSystem: string;
      sourceRoomTypeId: string;
      sourceRoomId: string;
      ratePlanCode: string;
      publicBookingReference: string;
      assignmentStatus: string;
      roomNumber: string;
      channel: string;
      externalBookingId: string;
      externalRoomTypeId: string;
      externalRatePlanId: string;
      inventoryTotalCount: number;
      inventoryAssignedCount: number;
      inventoryBlockedCount: number;
      inventoryAvailableCount: number;
      messageCount: number;
      attachmentCount: number;
      privateNoteCount: number;
      checkoutChargeCount: number;
      syncStatusCount: number;
      bookerCountryCode: string | null;
      bookerCountryCodeRaw: string | null;
      bookerCountryCodeReviewRequired: boolean;
    }>;
    forbiddenOperationalSummaryKeys?: string[];
  };
  distributionBookabilityChecks?: {
    properties: Array<{
      propertyId: string;
      organizationId: string;
      ownerUserId: string;
      bookingHotelResourceId: string;
      pmsHotelResourceId: string;
      providerAccountId: string;
      providerAccountRef: string;
      quoteSessionId: string;
      checkoutContextId: string;
      availableRoomOfferSnapshotId: string;
      soldOutRoomOfferSnapshotId: string;
      roomTypeId: string;
      ratePlanId: string;
      deepLinkContextId: string;
      activeApiClientId: string;
      revokedApiClientId: string;
      profileUsageEventId: string;
      quoteUsageEventId: string;
      deepLinkUsageEventId: string;
      publicId: string;
      canonicalSlug: string;
      canonicalUrl: string;
      bookingBaseUrl: string;
      timezone: string;
      defaultLocale: string;
      defaultCurrency: string;
      publicQuoteReference: string;
      quoteHash: string;
      deepLinkUrl: string;
      contextTokenHash: string;
      activePublicClientId: string;
      revokedPublicClientId: string;
      availableOfferKey: string;
      soldOutOfferKey: string;
      checkIn: string;
      checkOut: string;
      availableStayDate: string;
      soldOutStayDate: string;
      totalAmount: string;
      adults: number;
      children: number;
      rooms: number;
      availableRooms: number;
    }>;
    forbiddenPublicOutputValues?: string[];
  };
  platformMediaChecks?: {
    legacyUrlInventory: {
      sourceUrlCount: number;
      copiedObjectCount: number;
      externalReferenceCount: number;
      unresolvedExternalUrlCount: number;
      publicObjectCount: number;
      privateObjectCount: number;
    };
    requiredPurposes: string[];
    requiredPublicVariants: string[];
    forbiddenPublicValues?: string[];
  };
  mediaUrlMigrationChecks?: {
    bookingPropertyMedia?: Array<{
      id: string;
      mediaType: string;
      url: string;
      sourceSystem: string;
      publicApproved: boolean;
    }>;
    propertyPublicProfiles?: Array<{
      propertyId: string;
      mediaObjectIds: string[];
      urls: string[];
      forbiddenUrls: string[];
    }>;
    pms?: {
      roomTypeId: string;
      roomMediaObjectIds: string[];
      roomMediaUrls: string[];
      attachments: Array<{
        id: string;
        s3Key: string | null;
        sourceUrl: string | null;
      }>;
    };
    forbiddenPublicReferenceValues?: string[];
  };
};

export type ParityHandlerContext = {
  client: pg.Client;
  expected: ExpectedTarget;
  findings: ParityFinding[];
};

export type ParityHandler = (context: ParityHandlerContext) => Promise<void>;
