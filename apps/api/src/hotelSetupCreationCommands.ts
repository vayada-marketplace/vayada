import { AuthorizationError } from "@vayada/backend-authorization";
import {
  createHotelSetupCreationCredentialResolver,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import type { SharedHotelSetupStatusRepository } from "./routes/sharedHotelSetupStatus.js";
import { BookingContactPublicationConflictError } from "./routes/bookingSettings.js";

/** Private executor: select current organization credentials for every request. */
export function createHotelSetupCreationCommands(
  options: HotelSetupCredentialOptions,
): Pick<SharedHotelSetupStatusRepository, "createPropertyProfile"> {
  const resolveCredential = createHotelSetupCreationCredentialResolver(options);
  return {
    async createPropertyProfile(input) {
      try {
        const connectionString = await resolveCredential(input.organizationId);
        // ponytail: a pool per command avoids stale credentials; reuse only if measured necessary.
        const repository = createPgSharedHotelSetupStatusRepository({
          connectionString,
          max: 1,
          hotelSetupNativeCreation: true,
        });
        try {
          return await repository.createPropertyProfile(input);
        } finally {
          await repository.close?.();
        }
      } catch (error) {
        if (error instanceof AuthorizationError) throw error;
        if (error instanceof BookingContactPublicationConflictError)
          throw new BookingContactPublicationConflictError();
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "idempotency_key_conflict" || code === "command_in_progress")
          throw Object.assign(new Error(code), { code });
        throw new Error("Hotel setup property creation unavailable");
      }
    },
  };
}
