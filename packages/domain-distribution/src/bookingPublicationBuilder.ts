import {
  hashSourceManifest,
  type ReadyProductReadinessEvidence,
  type SourceManifest,
  type SourceManifestHash,
} from "@vayada/domain-hotels";

import {
  buildPublicBookabilityProfileProjection,
  type PublicBookabilityProducerInputs,
} from "./index.js";
import {
  tryBuildBookingPublicContent,
  type BookingPublicContentBuild,
  type BookingPublicContentRejection,
} from "./bookingPublication.js";
import { publicBookabilityProfileIssuePaths } from "./publicBookabilityProfileParser.js";
import {
  bookingPublicationOwnerSnapshotProvenanceMatches,
  type BookingPublicationOwnerSnapshot,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
  type BookingPublicationSnapshotRequest,
} from "./bookingPublicationOwnerSnapshots.js";

export type BookingPublicationBuildResult =
  | Readonly<{ outcome: "built"; build: BookingPublicContentBuild }>
  | Readonly<{
      outcome: "rejected";
      code: "owner_snapshot_unavailable" | "source_manifest_mismatch" | "public_content_incomplete";
      /** Which rule refused incomplete content, for logs (VAY-2292). */
      reason?: BookingPublicationContentRejectionReason;
      /** Profile fields that break the public contract: paths only, never values. */
      issuePaths?: readonly string[];
    }>;

export type BookingPublicationContentRejectionReason =
  | "currency"
  | "booking_web"
  | BookingPublicContentRejection
  | "build_error";

export type BookingPublicationBuilderPort = Readonly<{
  build(
    input: Readonly<{
      organizationId: string;
      readiness: ReadyProductReadinessEvidence<"booking">;
      generatedAt: string;
    }>,
  ): Promise<BookingPublicationBuildResult>;
}>;

export function createBookingPublicationBuilder(config: {
  catalog: BookingPublicationOwnerSnapshotPort<"hotel_catalog">;
  booking: BookingPublicationOwnerSnapshotPort<"booking">;
  pms: BookingPublicationOwnerSnapshotPort<"pms">;
  finance: BookingPublicationOwnerSnapshotPort<"finance">;
  bookingWeb(
    input: Readonly<{
      propertyId: string;
      slug: string;
      customDomainUrl: string | null;
      domainVerified: boolean;
    }>,
  ): PublicBookabilityProducerInputs["bookingWeb"];
}): BookingPublicationBuilderPort {
  return {
    async build(input) {
      const { readiness } = input;
      if (
        !input.organizationId.trim() ||
        readiness.product !== "booking" ||
        readiness.status !== "ready" ||
        readiness.propertyId !== readiness.sourceManifest.propertyId ||
        (await safeManifestHash(readiness.sourceManifest)) !== readiness.sourceManifestHash
      ) {
        return rejected("source_manifest_mismatch");
      }
      const request = deepFreeze({
        organizationId: input.organizationId,
        propertyId: readiness.propertyId,
        sourceManifest: structuredClone(readiness.sourceManifest),
        sourceManifestHash: readiness.sourceManifestHash,
      });
      let snapshots: readonly unknown[];
      try {
        snapshots = await Promise.all([
          config.catalog.getSnapshot(request),
          config.booking.getSnapshot(request),
          config.pms.getSnapshot(request),
          config.finance.getSnapshot(request),
        ]);
      } catch {
        return rejected("owner_snapshot_unavailable");
      }
      if (snapshots.some((snapshot) => !isRecord(snapshot) || snapshot["outcome"] !== "snapshot")) {
        return rejected("owner_snapshot_unavailable");
      }
      const [catalog, booking, pms, finance] = snapshots as [
        BookingPublicationOwnerSnapshot<"hotel_catalog">,
        BookingPublicationOwnerSnapshot<"booking">,
        BookingPublicationOwnerSnapshot<"pms">,
        BookingPublicationOwnerSnapshot<"finance">,
      ];
      if (
        !bookingPublicationOwnerSnapshotProvenanceMatches(catalog, "hotel_catalog", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(booking, "booking", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(pms, "pms", request) ||
        !bookingPublicationOwnerSnapshotProvenanceMatches(finance, "finance", request) ||
        catalog.content.propertyId !== request.propertyId
      ) {
        return rejected("source_manifest_mismatch");
      }
      try {
        // Existing publication supports one pricing currency; Finance multi-currency
        // support alone does not establish quote conversion evidence.
        if (
          finance.content.supportedCurrencies.length !== 1 ||
          finance.content.supportedCurrencies[0] !== finance.content.defaultCurrency
        )
          return rejected("public_content_incomplete", "currency");
        const bookingWeb = config.bookingWeb({
          propertyId: request.propertyId,
          slug: catalog.content.slug,
          ...catalog.content.bookingWeb,
        });
        if (!validBookingWeb(bookingWeb))
          return rejected("public_content_incomplete", "booking_web");
        // The page and its quotes offer one language list (VAY-2292).
        const supportedLocales = publishedLocales(
          catalog.content.defaultLocale,
          booking.content.supportedQuoteParameters.supportedLocales,
        );
        const profile = buildPublicBookabilityProfileProjection(input.generatedAt, {
          hotelCatalog: { ...catalog.content, supportedLocales },
          booking: sanitizeBooking({
            ...booking.content,
            supportedQuoteParameters: {
              ...booking.content.supportedQuoteParameters,
              supportedLocales,
              supportedCurrencies: finance.content.supportedCurrencies,
            },
          }),
          pms: pms.content,
          finance: finance.content,
          bookingWeb,
        });
        const result = tryBuildBookingPublicContent({
          sourceManifestHash: readiness.sourceManifestHash,
          readinessHash: readiness.readinessHash,
          profile,
          rooms: pms.content.rooms,
          calendar: pms.content.calendar,
          finance: finance.content,
        });
        if ("build" in result) return deepFreeze({ outcome: "built", build: result.build });
        const issuePaths =
          result.rejected === "profile" ? publicBookabilityProfileIssuePaths(profile) : [];
        return rejected(
          "public_content_incomplete",
          result.rejected,
          issuePaths.length > 0 ? issuePaths : undefined,
        );
      } catch {
        return rejected("public_content_incomplete", "build_error");
      }
    },
  };
}

/** Booking Admin's languages plus the hotel profile's main language, as the old page offered
 * them. An entry guests can't be served in is dropped, so it never blocks publishing. */
function publishedLocales(defaultLocale: string, bookingLocales: readonly string[]): string[] {
  return [...new Set([defaultLocale, ...bookingLocales.filter(servableLocale)])].sort();
}

function servableLocale(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  try {
    new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}

function validBookingWeb(value: PublicBookabilityProducerInputs["bookingWeb"]): boolean {
  try {
    const canonical = new URL(value.canonicalUrl);
    const booking = new URL(value.bookingBaseUrl);
    const custom = value.customDomainUrl ? new URL(value.customDomainUrl) : null;
    return (
      canonical.protocol === "https:" &&
      booking.protocol === "https:" &&
      !canonical.username &&
      !canonical.password &&
      cleanOriginUrl(booking) &&
      canonical.origin === booking.origin &&
      value.bookingDeepLinks &&
      (custom
        ? value.domainVerified && cleanOriginUrl(custom) && custom.origin === booking.origin
        : !value.domainVerified)
    );
  } catch {
    return false;
  }
}

const cleanOriginUrl = (value: URL) =>
  value.protocol === "https:" &&
  !value.username &&
  !value.password &&
  value.pathname === "/" &&
  !value.search &&
  !value.hash;

function sanitizeBooking(
  content: BookingPublicationSnapshotContent["booking"],
): BookingPublicationSnapshotContent["booking"] {
  const branding = content.branding;
  return {
    ...content,
    ...(branding
      ? {
          branding: {
            logoUrl: branding.logoUrl,
            showContactButton: branding.showContactButton,
            showReferAGuestButton: branding.showReferAGuestButton,
            showLanguageSelector: branding.showLanguageSelector,
            showCurrencySelector: branding.showCurrencySelector,
            heroImage: branding.heroImage,
            heroHeading: branding.heroHeading,
            heroSubtext: branding.heroSubtext,
            primaryColor: branding.primaryColor,
            fontPairing: branding.fontPairing,
          },
        }
      : { branding: undefined }),
  };
}

async function safeManifestHash(manifest: SourceManifest): Promise<SourceManifestHash | null> {
  try {
    return await hashSourceManifest(manifest);
  } catch {
    return null;
  }
}

function rejected(
  code: Extract<BookingPublicationBuildResult, { outcome: "rejected" }>["code"],
  reason?: BookingPublicationContentRejectionReason,
  issuePaths?: readonly string[],
) {
  return deepFreeze({
    outcome: "rejected" as const,
    code,
    ...(reason ? { reason } : {}),
    ...(issuePaths ? { issuePaths: [...issuePaths] } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
