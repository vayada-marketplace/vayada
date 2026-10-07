import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";

import { createBookingPricingAuthorityStore } from "./domains/bookingPricingAuthority.js";
import { createCurrentPricingQuoteStore } from "./domains/currentPricingQuoteStore.js";
import { createPublicPricingOfferCatalog } from "./domains/publicPricingOfferCatalog.js";
import { buildPricingCommandService } from "./pricingCommandService.js";
import {
  assertPricingCommandPoolScope,
  assertPricingCommandTransactionScope,
  loadPricingCommandServiceConfig,
} from "./pricingCommandServiceConfig.js";
import { createReplacementBookingQuoteIssuer } from "./routes/replacementBookingQuote.js";

const config = loadPricingCommandServiceConfig();
const operationPoolLimits = {
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
  lock_timeout: 5_000,
  idle_in_transaction_session_timeout: 20_000,
  max: 5,
} as const;
const ownerReadPool = new pg.Pool({
  ...operationPoolLimits,
  connectionString: config.ownerReadDatabaseUrl,
});
const ownerManagePool = new pg.Pool({
  ...operationPoolLimits,
  connectionString: config.ownerManageDatabaseUrl,
});
const publicPool = new pg.Pool({
  ...operationPoolLimits,
  connectionString: config.publicDatabaseUrl,
});
try {
  await Promise.all([
    assertPricingCommandPoolScope(ownerReadPool, {
      propertyId: config.propertyId,
      operationClass: "owner_read",
    }),
    assertPricingCommandPoolScope(ownerManagePool, {
      propertyId: config.propertyId,
      operationClass: "owner_manage",
    }),
    assertPricingCommandPoolScope(publicPool, {
      propertyId: config.propertyId,
      operationClass: "public",
    }),
  ]);
} catch {
  await Promise.all([ownerReadPool.end(), ownerManagePool.end(), publicPool.end()]);
  throw new Error("Pricing command database preflight failed");
}
const assertRuntimeScope = (
  client: pg.PoolClient,
  scope: { propertyId: string; organizationId: string },
  operationClass: "owner_read" | "owner_manage",
) =>
  assertPricingCommandTransactionScope(client, {
    propertyId: scope.propertyId,
    organizationId: scope.organizationId,
    operationClass,
  }).then(() => undefined);
const ownerRead = createBookingPricingAuthorityStore(ownerReadPool, { assertRuntimeScope });
const ownerManage = createBookingPricingAuthorityStore(ownerManagePool, { assertRuntimeScope });
const assertPublicRuntimeScope = (client: pg.PoolClient) =>
  assertPricingCommandTransactionScope(client, {
    propertyId: config.propertyId,
    operationClass: "public",
  });
const publicOffers = createPublicPricingOfferCatalog(publicPool, {
  assertRuntimeScope: assertPublicRuntimeScope,
});
const publicQuote = createReplacementBookingQuoteIssuer(
  createCurrentPricingQuoteStore(publicPool, 300, {
    assertRuntimeScope: assertPublicRuntimeScope,
  }),
);

const rolePermissionRepository = createPgRolePermissionRepository({
  connectionString: config.authDatabaseUrl,
});
const entitlementRepository = createPgEntitlementRepository({
  connectionString: config.authDatabaseUrl,
});
const propertyAccessRepository = createPgPropertyAccessRepository({
  connectionString: config.authDatabaseUrl,
});
const app = buildPricingCommandService({
  internalToken: config.internalToken,
  propertyId: config.propertyId,
  hotelSlug: config.hotelSlug,
  auth: {
    verifier: createWorkOSVerifier({
      jwksUrl: config.workosJwksUrl,
      issuer: config.workosIssuer,
      audience: config.workosAudience,
    }),
    repository: createPgIdentityRepository({ connectionString: config.authDatabaseUrl }),
    rolePermissionRepository,
    entitlementRepository,
    propertyAccessRepository,
  },
  ownerRead: ownerRead.read,
  ownerManage: ownerManage.save,
  publicOffers: publicOffers.read,
  publicQuote,
});

app.addHook("onClose", async () => {
  await Promise.all([
    ownerReadPool.end(),
    ownerManagePool.end(),
    publicPool.end(),
    rolePermissionRepository.close?.(),
    entitlementRepository.close?.(),
    propertyAccessRepository.close?.(),
  ]);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
