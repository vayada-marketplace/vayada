import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import {
  createHotelSetupCredentialResolver,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";
import { writeHotelSetupLaunchSettings } from "./hotelSetupLaunchSettingsRepository.js";
import { BookingContactPublicationConflictError } from "./routes/bookingSettings.js";

/** Private executor only; no ambient pool or fallback, and no credential caching. */
export function createHotelSetupLaunchSettingsCommands(options: HotelSetupCredentialOptions) {
  const resolveCredential = createHotelSetupCredentialResolver(options, "launch_settings");
  return {
    async updateLaunchSettings(
      context: Parameters<typeof writeHotelSetupLaunchSettings>[1],
      propertyId: string,
      settings: Parameters<typeof writeHotelSetupLaunchSettings>[3],
    ) {
      try {
        const connectionString = await resolveCredential(
          propertyId,
          context.selectedOrganization.organizationId,
        );
        const pool = new pg.Pool({ connectionString, max: 1 });
        try {
          return await writeHotelSetupLaunchSettings(pool, context, propertyId, settings);
        } finally {
          await pool.end();
        }
      } catch (error) {
        if (
          error instanceof AuthorizationError ||
          error instanceof BookingContactPublicationConflictError
        )
          throw error;
        throw new Error("Hotel setup launch settings command unavailable");
      }
    },
  };
}
