import type pg from "pg";

import type { MigrationEnvironment } from "./runner.js";

export type ParityCheckSeverity = "fail" | "warn";

export type ParityFinding = {
  severity: ParityCheckSeverity;
  code: string;
  owner: string;
  targetObject: string;
  message: string;
  expected: string;
  actual: string;
  suggestedAction?: string;
};

export type ParityReport = {
  runId: string;
  environment: MigrationEnvironment;
  fixtureCase: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  summary: {
    failures: number;
    warnings: number;
  };
  findings: ParityFinding[];
};

export type ParityConfig = {
  connectionString: string;
  fixtureCase: string;
  fixturesDir: string;
  environment: MigrationEnvironment;
};

export type ExpectedTarget = {
  counts: Record<string, number>;
  idStability: Record<string, string[]>;
  uniquenessChecks?: string[];
  identityChecks?: {
    memberships?: Array<{
      organizationId: string;
      userId: string;
      status: string;
      roleKey: string;
    }>;
    resourceLinks?: Array<{
      organizationId: string;
      product: string;
      resourceType: string;
      resourceId: string;
      relationship: string;
      status: string;
    }>;
    entitlements?: Array<{
      organizationId: string;
      product: string;
      entitlementKey: string;
      status: string;
      resourceProduct: string | null;
      resourceType: string | null;
      resourceId: string | null;
    }>;
    rolePermissionGrants?: Array<{
      organizationKind: string;
      roleKey: string;
      permissionKey: string;
    }>;
    permissionKeys?: string[];
  };
  catalogPublicProfileChecks?: {
    completePropertyIds?: string[];
    missingLocationPropertyIds?: string[];
    customDomainProperties?: Array<{
      propertyId: string;
      hostname: string;
    }>;
    forbiddenPublicProfileKeys?: string[];
  };
};

export type ParityHandlerContext = {
  client: pg.Client;
  expected: ExpectedTarget;
  findings: ParityFinding[];
};

export type ParityHandler = (context: ParityHandlerContext) => Promise<void>;
