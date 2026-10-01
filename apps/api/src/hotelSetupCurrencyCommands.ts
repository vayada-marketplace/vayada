import type { PmsPricingCommandPort, PmsPricingCurrencyChangeGuardPort } from "@vayada/domain-pms";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import {
  createHotelSetupCredentialResolver,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";

type Options = HotelSetupCredentialOptions & {
  currencyChangeGuard: PmsPricingCurrencyChangeGuardPort;
};

/** Private service only. The registry selects the login; secrets supply its password. */
export function createHotelSetupCurrencyCommands(
  options: Options,
): Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency"> {
  const resolveCredential = createHotelSetupCredentialResolver(options, "currency_ready");

  return {
    async upsertPropertyPricingCurrency(command) {
      try {
        const connectionString = await resolveCredential(
          command.propertyId,
          command.organizationId,
        );
        // ponytail: one pool per command avoids stale credential caches; reuse only if measured necessary.
        const repository = createPgPmsPricingCommandRepository({
          connectionString,
          max: 1,
          hotelSetupCurrencyOperation: "currency_ready",
          currencyChangeGuard: options.currencyChangeGuard,
        });
        try {
          return await repository.upsertPropertyPricingCurrency(command);
        } finally {
          await repository.close();
        }
      } catch {
        throw new Error("Hotel setup currency command unavailable");
      }
    },
  };
}
