import { createHotelCatalogMarketplaceSubmissionSource } from "../domains/hotelCatalogMarketplaceSubmissionSource.js";
import { readLockedHotelCatalogStep1State } from "../domains/hotelCatalogStep1Repository.js";
import {
  readLockedMarketplaceHotelCollaborationPreferences,
  type MarketplaceHotelCollaborationPreferencesClient,
} from "../domains/marketplaceHotelCollaborationPreferencesRepository.js";
import { createMarketplaceSubmissionReadiness } from "../domains/marketplaceSubmissionReadiness.js";
import {
  loadPropertyProfile,
  loadPublicPropertyProfile,
} from "./sharedHotelSetupStatusReadModel.js";

/** Compose owner readers on the command's transaction; never open a second connection under its locks. */
export function marketplaceSubmissionTransactionSources(
  client: MarketplaceHotelCollaborationPreferencesClient,
) {
  return createMarketplaceSubmissionReadiness({
    catalog: createHotelCatalogMarketplaceSubmissionSource({
      step1: { getState: (scope) => readLockedHotelCatalogStep1State(client, scope) },
      profiles: {
        getPropertyProfile: (scope) =>
          loadPropertyProfile(client, scope.organizationId, scope.propertyId),
        getPublicPropertyProfile: (scope) =>
          loadPublicPropertyProfile(client, scope.organizationId, scope.propertyId),
      },
    }),
    preferences: {
      getHotelCollaborationPreferences: (scope) =>
        readLockedMarketplaceHotelCollaborationPreferences(client, scope, new Date()),
    },
  });
}
