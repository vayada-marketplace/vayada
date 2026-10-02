import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";
import { PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD } from "./domains/pmsPricingCurrencyCapabilities.js";
import { buildHotelSetupCommandService } from "./hotelSetupCommandService.js";
import {
  assertHotelSetupServiceReader,
  loadHotelSetupCommandServiceConfig,
} from "./hotelSetupCommandServiceConfig.js";
import { createHotelSetupCreationCommands } from "./hotelSetupCreationCommands.js";
import { createHotelSetupCurrencyCommands } from "./hotelSetupCurrencyCommands.js";
import { createHotelSetupFeatureHubCommands } from "./hotelSetupFeatureHubCommands.js";
import { assertHotelSetupReaderPrivileges } from "./hotelSetupReaderPrivileges.js";
import { installPostgresPoolRuntime } from "./platform/postgresRuntime.js";
import { createSecretsManagerProviderCredentialVault } from "./platform/providerCredentialVault.js";
import { registerShutdownSignals } from "./platform/shutdown.js";
import { createPgPmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";

const config = loadHotelSetupCommandServiceConfig();
const runtime = installPostgresPoolRuntime(pg);
try {
  const reader = new pg.Pool({ connectionString: config.readerDatabaseUrl });
  await assertHotelSetupServiceReader(reader, config.mode);
  await assertHotelSetupReaderPrivileges(reader, config.mode);
  const repositoryConfig = { connectionString: config.readerDatabaseUrl };
  const vault = createSecretsManagerProviderCredentialVault();
  const credentials = {
    assignments: reader,
    vault: { get: vault.get },
    databaseEndpoint: config.databaseEndpoint,
    secretPrefix: config.secretPrefix,
  };
  const commandOptions =
    config.mode === "property_creation"
      ? { propertyCreation: createHotelSetupCreationCommands(credentials) }
      : (() => {
          const reads = createPgPmsModuleActivationRepository({
            ...repositoryConfig,
            pool: reader,
          });
          return {
            currencyCommands: createHotelSetupCurrencyCommands({
              ...credentials,
              currencyChangeGuard: PMS_PRICING_CURRENCY_CHANGE_FAIL_CLOSED_GUARD,
            }),
            featureHub: {
              reads: { list: reads.list },
              commands: createHotelSetupFeatureHubCommands(credentials),
              setupComplete: reads.isFinancialsSetupComplete!,
            },
          };
        })();
  const app = buildHotelSetupCommandService({
    internalToken: config.internalToken,
    auth: {
      verifier: createWorkOSVerifier({
        jwksUrl: config.workosJwksUrl,
        issuer: config.workosIssuer,
        audience: config.workosAudience,
      }),
      repository: createPgIdentityRepository(repositoryConfig),
      rolePermissionRepository: createPgRolePermissionRepository(repositoryConfig),
      entitlementRepository: createPgEntitlementRepository(repositoryConfig),
      propertyAccessRepository: createPgPropertyAccessRepository(repositoryConfig),
    },
    ...commandOptions,
  });
  app.addHook("onClose", () => runtime.close());
  registerShutdownSignals(app);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error("Hotel setup listener unavailable");
  }
} catch {
  await runtime.close();
  // Do not log connection strings, credentials, SDK responses or bearer tokens.
  throw new Error("Hotel setup command service startup failed");
}
