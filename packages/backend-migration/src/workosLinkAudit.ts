import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

export type WorkosLinkAuditMetric = {
  metric: string;
  value: number;
};

export type WorkosLinkAuditResourceLinkCount = {
  product: string;
  resourceType: string;
  status: string;
  count: number;
};

export type WorkosLinkAuditResult = {
  kind: "workos_link_audit";
  ok: boolean;
  summary: WorkosLinkAuditMetric[];
  resourceLinks: WorkosLinkAuditResourceLinkCount[];
  blockers: string[];
};

export class WorkosLinkAuditError extends Error {
  constructor(
    readonly code: "target_schema_missing",
    message: string,
    readonly missingTables: string[],
  ) {
    super(message);
  }
}

const REQUIRED_TABLES = [
  "identity.users",
  "identity.external_identities",
  "identity.organizations",
  "identity.organization_memberships",
  "identity.organization_resource_links",
  "identity.product_entitlements",
] as const;

const BLOCKING_METRICS = [
  "users_active_missing_workos_link",
  "organizations_active_missing_workos_link",
  "memberships_active_missing_workos_link",
  "hotel_group_orgs_with_active_members_missing_booking_hotel_link",
  "hotel_group_orgs_with_active_members_missing_pms_property_link",
  "affiliate_partner_orgs_with_active_members_missing_affiliate_link",
] as const;

const REQUIRED_NONZERO_METRICS = [
  "users_active_total",
  "organizations_active_total",
  "memberships_active_total",
  "resource_links_active_total",
  "platform_orgs_with_workos_linked_active_members_total",
] as const;

export async function runWorkosLinkAudit(config: {
  connectionString: string;
  max?: number;
}): Promise<WorkosLinkAuditResult> {
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max,
  });
  try {
    await assertRequiredTables(pool);

    const summary: WorkosLinkAuditMetric[] = [];
    summary.push(await one(pool, "users_total", `SELECT count(*) FROM identity.users`));
    summary.push(
      await one(
        pool,
        "users_active_total",
        `SELECT count(*)
         FROM identity.users users
         WHERE users.status = 'active'`,
      ),
    );
    summary.push(
      await one(
        pool,
        "users_active_missing_workos_link",
        `SELECT count(*)
         FROM identity.users users
         WHERE users.status = 'active'
           AND NOT EXISTS (
             SELECT 1
             FROM identity.external_identities external_identity
             WHERE external_identity.user_id = users.id
               AND external_identity.provider = 'workos'
               AND external_identity.provider_user_id IS NOT NULL
           )`,
      ),
    );
    summary.push(
      await one(pool, "organizations_total", `SELECT count(*) FROM identity.organizations`),
    );
    summary.push(
      await one(
        pool,
        "organizations_active_total",
        `SELECT count(*)
         FROM identity.organizations organizations
         WHERE organizations.status = 'active'`,
      ),
    );
    summary.push(
      await one(
        pool,
        "organizations_active_missing_workos_link",
        `SELECT count(*)
         FROM identity.organizations organizations
         WHERE organizations.status = 'active'
           AND (
             organizations.workos_org_id IS NULL
             OR organizations.workos_external_id IS NULL
           )`,
      ),
    );
    summary.push(
      await one(
        pool,
        "memberships_active_total",
        `SELECT count(*)
         FROM identity.organization_memberships memberships
         JOIN identity.users users ON users.id = memberships.user_id
         JOIN identity.organizations organizations ON organizations.id = memberships.organization_id
         WHERE memberships.status = 'active'
           AND users.status = 'active'
           AND organizations.status = 'active'`,
      ),
    );
    summary.push(
      await one(
        pool,
        "memberships_active_missing_workos_link",
        `SELECT count(*)
         FROM identity.organization_memberships memberships
         JOIN identity.users users ON users.id = memberships.user_id
         JOIN identity.organizations organizations ON organizations.id = memberships.organization_id
         WHERE memberships.status = 'active'
           AND users.status = 'active'
           AND organizations.status = 'active'
           AND (
             memberships.workos_membership_id IS NULL
             OR organizations.workos_org_id IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM identity.external_identities external_identity
               WHERE external_identity.user_id = users.id
                 AND external_identity.provider = 'workos'
                 AND external_identity.provider_user_id IS NOT NULL
             )
           )`,
      ),
    );
    summary.push(
      await one(
        pool,
        "resource_links_active_total",
        `SELECT count(*)
         FROM identity.organization_resource_links
         WHERE status = 'active'`,
      ),
    );
    summary.push(await platformAccessMetric(pool));
    summary.push(
      await missingResourceMetric(pool, {
        metric: "hotel_group_orgs_with_active_members_missing_booking_hotel_link",
        organizationKind: "hotel_group",
        product: "booking",
        resourceType: "booking_hotel",
      }),
    );
    summary.push(
      await missingResourceMetric(pool, {
        metric: "hotel_group_orgs_with_active_members_missing_pms_property_link",
        organizationKind: "hotel_group",
        product: "pms",
        resourceType: "pms_property",
      }),
    );
    summary.push(
      await missingResourceMetric(pool, {
        metric: "affiliate_partner_orgs_with_active_members_missing_affiliate_link",
        organizationKind: "affiliate_partner",
        product: "affiliate",
        resourceType: "affiliate",
      }),
    );

    const resourceLinks = await loadResourceLinkCounts(pool);
    const blockers = findWorkosLinkAuditBlockers(summary);

    return {
      kind: "workos_link_audit",
      ok: blockers.length === 0,
      summary,
      resourceLinks,
      blockers,
    };
  } finally {
    await pool.end();
  }
}

export function findWorkosLinkAuditBlockers(summary: WorkosLinkAuditMetric[]): string[] {
  const values = new Map(summary.map((metric) => [metric.metric, metric.value]));
  return [
    ...REQUIRED_NONZERO_METRICS.filter((metric) => (values.get(metric) ?? 0) === 0).map(
      (metric) => `${metric}_zero`,
    ),
    ...BLOCKING_METRICS.filter((metric) => (values.get(metric) ?? 0) > 0),
  ];
}

async function assertRequiredTables(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; exists: string | null }>(
    `SELECT table_name, to_regclass(table_name) AS exists
     FROM unnest($1::text[]) AS table_name`,
    [[...REQUIRED_TABLES]],
  );
  const missingTables = rows.filter((row) => row.exists === null).map((row) => row.table_name);
  if (missingTables.length > 0) {
    throw new WorkosLinkAuditError(
      "target_schema_missing",
      `Target schema is missing required WorkOS identity tables: ${missingTables.join(", ")}`,
      missingTables,
    );
  }
}

async function one(pool: pg.Pool, metric: string, sql: string): Promise<WorkosLinkAuditMetric> {
  const { rows } = await pool.query<{ count: string }>(sql);
  return { metric, value: Number(rows[0].count) };
}

async function missingResourceMetric(
  pool: pg.Pool,
  input: {
    metric: string;
    organizationKind: string;
    product: string;
    resourceType: string;
  },
): Promise<WorkosLinkAuditMetric> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT organizations.id)
     FROM identity.organizations organizations
     WHERE organizations.kind = $1
       AND organizations.status = 'active'
       AND EXISTS (
         SELECT 1
         FROM identity.organization_memberships memberships
         WHERE memberships.organization_id = organizations.id
           AND memberships.status = 'active'
       )
       AND EXISTS (
         SELECT 1
         FROM identity.product_entitlements entitlements
         WHERE entitlements.organization_id = organizations.id
           AND entitlements.product = $2
           AND entitlements.status = 'active'
           AND (
             (
               entitlements.resource_product IS NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM identity.organization_resource_links resource_links
                 WHERE resource_links.organization_id = organizations.id
                   AND resource_links.product = $2
                   AND resource_links.resource_type = $3
                   AND resource_links.status = 'active'
               )
             )
             OR (
               entitlements.resource_product = $2
               AND entitlements.resource_type = $3
               AND NOT EXISTS (
                 SELECT 1
                 FROM identity.organization_resource_links resource_links
                 WHERE resource_links.organization_id = organizations.id
                   AND resource_links.product = $2
                   AND resource_links.resource_type = $3
                   AND resource_links.resource_id = entitlements.resource_id
                   AND resource_links.status = 'active'
               )
             )
           )
       )`,
    [input.organizationKind, input.product, input.resourceType],
  );
  return { metric: input.metric, value: Number(rows[0].count) };
}

async function platformAccessMetric(pool: pg.Pool): Promise<WorkosLinkAuditMetric> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT organizations.id)
     FROM identity.organizations organizations
     WHERE organizations.kind = 'platform'
       AND organizations.status = 'active'
       AND organizations.workos_org_id IS NOT NULL
       AND organizations.workos_external_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM identity.organization_memberships memberships
         JOIN identity.users users ON users.id = memberships.user_id
         WHERE memberships.organization_id = organizations.id
           AND memberships.status = 'active'
           AND memberships.workos_membership_id IS NOT NULL
           AND users.status = 'active'
           AND EXISTS (
             SELECT 1
             FROM identity.external_identities external_identity
             WHERE external_identity.user_id = users.id
               AND external_identity.provider = 'workos'
               AND external_identity.provider_user_id IS NOT NULL
           )
       )`,
  );
  return {
    metric: "platform_orgs_with_workos_linked_active_members_total",
    value: Number(rows[0].count),
  };
}

async function loadResourceLinkCounts(pool: pg.Pool): Promise<WorkosLinkAuditResourceLinkCount[]> {
  const { rows } = await pool.query<{
    product: string;
    resource_type: string;
    status: string;
    count: string;
  }>(
    `SELECT product, resource_type, status, count(*) AS count
     FROM identity.organization_resource_links
     GROUP BY product, resource_type, status
     ORDER BY product, resource_type, status`,
  );
  return rows.map((row) => ({
    product: row.product,
    resourceType: row.resource_type,
    status: row.status,
    count: Number(row.count),
  }));
}
