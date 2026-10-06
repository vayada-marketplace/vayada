import { AuthorizationError } from "@vayada/backend-authorization";
import {
  createHotelSetupCredentialResolver,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";
import { createPgHotelSetupFeatureHubRepository } from "./hotelSetupFeatureHubRepository.js";
import type { PmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";

/** Private executor only; reselect purpose-specific credentials on every command. */
export function createHotelSetupFeatureHubCommands(
  options: HotelSetupCredentialOptions,
): Pick<PmsModuleActivationRepository, "updateFinancials"> {
  const resolveCredential = createHotelSetupCredentialResolver(options, "feature_hub");
  return {
    async updateFinancials(context, propertyId, isActive) {
      try {
        const connectionString = await resolveCredential(
          propertyId,
          context.selectedOrganization.organizationId,
        );
        const repository = createPgHotelSetupFeatureHubRepository({ connectionString });
        try {
          return await repository.updateFinancials(context, propertyId, isActive);
        } finally {
          await repository.close?.();
        }
      } catch (error) {
        if (error instanceof AuthorizationError) throw error;
        throw new Error("Hotel setup Feature Hub command unavailable");
      }
    },
  };
}
