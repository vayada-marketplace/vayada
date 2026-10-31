import { replacementPricingManualPaymentMethods, type ApiConfig } from "./config.js";
import {
  createTargetPublicHotelProfileRepository,
  type PublicHotelProfileReadPool,
} from "./routes/aiHotels.js";
import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";

export type PublicRuntimePools = {
  publicHotelProfilePool?: PublicHotelProfileReadPool;
};

export function createPublicRuntimeRepositories(config: ApiConfig, pools: PublicRuntimePools = {}) {
  const publicHotelProfileRepository =
    config.publicHotelProfileSource === "active_publication"
      ? createActiveBookingPublicationProfileRepository({
          connectionString: requireTargetDatabaseUrl(config),
          pool: pools.publicHotelProfilePool,
          manualPayments: config.replacementPricingManualPaymentAcceptanceEnabled,
          manualMethods: replacementPricingManualPaymentMethods(config),
        })
      : createTargetPublicHotelProfileRepository({
          connectionString: requireTargetDatabaseUrl(config),
          pool: pools.publicHotelProfilePool,
        });

  return { publicHotelProfileRepository };
}

function requireTargetDatabaseUrl(config: ApiConfig): string {
  if (!config.targetDatabaseUrl) {
    throw new Error("TARGET_DATABASE_URL is required for target public runtime repositories");
  }
  return config.targetDatabaseUrl;
}
