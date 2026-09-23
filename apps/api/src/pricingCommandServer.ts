import { createPgIdentityRepository, createWorkOSVerifier } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";

import { createBookingPricingAuthorityStore } from "./domains/bookingPricingAuthority.js";
import { buildPricingCommandService } from "./pricingCommandService.js";
import {
  assertPricingCommandPoolScope,
  assertPricingCommandTransactionScope,
  loadPricingCommandServiceConfig,
} from "./pricingCommandServiceConfig.js";

const config = loadPricingCommandServiceConfig();
const ownerReadPool = new pg.Pool({
  connectionString: config.ownerReadDatabaseUrl,
  connectionTimeoutMillis: 5_000,
  max: 5,
});
const ownerManagePool = new pg.Pool({
  connectionString: config.ownerManageDatabaseUrl,
  connectionTimeoutMillis: 5_000,
  max: 5,
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
  ]);
} catch {
  await Promise.all([ownerReadPool.end(), ownerManagePool.end()]);
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
  });
const ownerRead = createBookingPricingAuthorityStore(ownerReadPool, { assertRuntimeScope });
const ownerManage = createBookingPricingAuthorityStore(ownerManagePool, { assertRuntimeScope });

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
});

app.addHook("onClose", async () => {
  await Promise.all([
    ownerReadPool.end(),
    ownerManagePool.end(),
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
