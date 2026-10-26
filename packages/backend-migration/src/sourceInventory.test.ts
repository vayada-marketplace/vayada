import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getRegisteredFixtureCases } from "./cases/registry.js";
import { VAY_1350_ACTIVE_SOURCE_TABLES } from "./productionIdentitySnapshotReader.js";
import {
  buildSourceRowCountQueries,
  parseSourceInventory,
  RETENTION_POLICIES,
  REQUIRED_SOURCE_REVISION_ARGUMENT,
  REQUIRED_SOURCE_SNAPSHOT_ARGUMENTS,
  SOURCE_READ_ONLY_TRANSACTION_SQL,
  SOURCE_SCHEMA_FINGERPRINT_SQL,
  type SourceDatabase,
} from "./sourceInventory.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const inventoryText = readFileSync(new URL("../source-inventory.tsv", import.meta.url), "utf8");
const inventory = parseSourceInventory(inventoryText);

// VAY-2259: the old Marketplace API's source (apps/marketplace-api) is deleted with the
// Marketplace, but its production database stays a migration source until VAY-1362/1363
// retire it. These are the objects, writers, prefixes and media references the scanners
// below found in that source on its last main (897d64c6e); they stay its contract.
const FROZEN_MARKETPLACE_SOURCE = {
  migrationObjects: [
    "extension:uuid-ossp",
    "sequence:public.schema_migrations_id_seq",
    "table:public.chat_messages",
    "table:public.collaboration_deliverables",
    "table:public.collaborations",
    "table:public.consent_history",
    "table:public.cookie_consent",
    "table:public.creator_platforms",
    "table:public.creator_ratings",
    "table:public.creators",
    "table:public.email_verification_codes",
    "table:public.email_verification_tokens",
    "table:public.external_collaborations",
    "table:public.gdpr_requests",
    "table:public.hotel_listings",
    "table:public.hotel_profiles",
    "table:public.invite_codes",
    "table:public.listing_collaboration_offerings",
    "table:public.listing_creator_requirements",
    "table:public.newsletter_preferences",
    "table:public.notifications",
    "table:public.password_reset_tokens",
    "table:public.schema_migrations",
    "table:public.trips",
    "table:public.users",
  ],
  manualWriters: [
    "marketplace:scripts/backfill_listing_status.py",
    "marketplace:scripts/run_gdpr_migrations.py",
  ],
  objectPrefixes: ["chat", "client-supplied:*", "creators", "hotels", "images", "listings"],
  hasObjectStore: true,
  mediaReferences: [
    "marketplace:public.chat_messages.content",
    "marketplace:public.creators.profile_picture",
    "marketplace:public.hotel_listings.images",
    "marketplace:public.hotel_profiles.picture",
    "marketplace:public.users.avatar",
  ],
};

type ScannedSourceDatabase = Exclude<SourceDatabase, "marketplace">;

const migrationDirectories: Record<ScannedSourceDatabase, string> = {
  auth: "auth-db/migrations",
  booking: "apps/booking-api/migrations",
  pms: "apps/pms-api/migrations",
};
const migrationRuntimeFiles: Record<ScannedSourceDatabase, string[]> = {
  auth: ["auth-db/scripts/run_migrations.py"],
  booking: ["apps/booking-api/scripts/run_migrations.py"],
  pms: ["apps/pms-api/scripts/run_migrations.py", "apps/pms-api/app/main.py"],
};

function readFiles(...paths: string[]): string {
  return paths.map((path) => readFileSync(join(repoRoot, path), "utf8")).join("\n");
}

function readMigrationSql(sourceDatabase: ScannedSourceDatabase): string {
  const directory = join(repoRoot, migrationDirectories[sourceDatabase]);
  return (
    readdirSync(directory)
      .filter((filename) => filename.endsWith(".sql"))
      .sort()
      .map((filename) => readFileSync(join(directory, filename), "utf8"))
      .join("\n") + readFiles(...migrationRuntimeFiles[sourceDatabase])
  );
}

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
}

function discoverMigrationObjects(source: string): string[] {
  const sql = stripSqlComments(source);
  const objects = new Set<string>();
  const ddlPattern =
    /CREATE\s+(MATERIALIZED\s+VIEW|TABLE|VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?([a-z][a-z0-9_]*)"?)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?/gi;
  for (const match of sql.matchAll(ddlPattern)) {
    const objectType = match[1].toLowerCase().replace(" ", "_");
    objects.add(`${objectType}:${match[2] ?? "public"}.${match[3]}`);
  }
  const serialTablePattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?([a-z][a-z0-9_]*)"?)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?\s*\(([\s\S]*?)(?:\n\s*\)\s*;|\n\s*\)\s*""")/gi;
  for (const tableMatch of sql.matchAll(serialTablePattern)) {
    for (const columnMatch of tableMatch[3].matchAll(
      /^\s*"?([a-z][a-z0-9_]*)"?\s+(?:BIG|SMALL)?SERIAL\b/gim,
    )) {
      objects.add(`sequence:${tableMatch[1] ?? "public"}.${tableMatch[2]}_${columnMatch[1]}_seq`);
    }
  }
  const extensionPattern =
    /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-z0-9_-]+))/gi;
  for (const match of sql.matchAll(extensionPattern)) {
    objects.add(`extension:${match[1] ?? match[2]}`);
  }
  return [...objects].sort();
}

const MEDIA_REFERENCE_COLUMNS = new Set([
  "avatar",
  "branding_favicon_url",
  "branding_logo_url",
  "hero_image",
  "image",
  "images",
  "picture",
  "profile_picture",
  "public_cdn_url",
  "s3_key",
  "source_url",
  "storage_key",
]);

function discoverMediaReferences(sourceDatabase: SourceDatabase, source: string): string[] {
  const sql = stripSqlComments(source);
  const references = new Set<string>();
  const createTablePattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?([a-z][a-z0-9_]*)"?)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?\s*\(([\s\S]*?)(?:\n\s*\)\s*;|\n\s*\)\s*""")/gi;

  for (const tableMatch of sql.matchAll(createTablePattern)) {
    const tableName = `${tableMatch[1] ?? "public"}.${tableMatch[2]}`;
    for (const columnMatch of tableMatch[3].matchAll(
      /^\s*"?([a-z][a-z0-9_]*)"?\s+[a-z][a-z0-9_]*(?:\[\])?\b/gim,
    )) {
      if (MEDIA_REFERENCE_COLUMNS.has(columnMatch[1].toLowerCase())) {
        references.add(`${sourceDatabase}:${tableName}.${columnMatch[1].toLowerCase()}`);
      }
    }
  }

  const alterTablePattern =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:(?:"?([a-z][a-z0-9_]*)"?)\s*\.\s*)?"?([a-z][a-z0-9_]*)"?([\s\S]*?);/gi;
  for (const tableMatch of sql.matchAll(alterTablePattern)) {
    const tableName = `${tableMatch[1] ?? "public"}.${tableMatch[2]}`;
    for (const columnMatch of tableMatch[3].matchAll(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?/gi,
    )) {
      if (MEDIA_REFERENCE_COLUMNS.has(columnMatch[1].toLowerCase())) {
        references.add(`${sourceDatabase}:${tableName}.${columnMatch[1].toLowerCase()}`);
      }
    }
  }

  // These fields carry media identifiers conditionally, so their column names alone
  // do not reveal their role to the mechanical scanner above.
  if (sourceDatabase === "pms" && /CREATE\s+TABLE[\s\S]*?platform\.media_objects/i.test(sql)) {
    references.add("pms:platform.media_objects.bucket");
  }

  return [...references].sort();
}

describe("legacy production source inventory", () => {
  it("gives every object one complete authoritative contract", () => {
    expect(inventory).toHaveLength(162);
    expect(
      new Set(
        inventory.map(
          ({ sourceDatabase, objectType, objectName }) =>
            `${sourceDatabase}:${objectType}:${objectName}`,
        ),
      ).size,
    ).toBe(inventory.length);
    const registeredFixtures = new Set(getRegisteredFixtureCases());
    expect(
      inventory.every(
        ({ fixtureCase }) => fixtureCase === "none" || registeredFixtures.has(fixtureCase),
      ),
    ).toBe(true);
    expect(inventory.filter(({ objectType }) => objectType === "table")).not.toContainEqual(
      expect.objectContaining({ retentionPolicy: "cutover-control" }),
    );
    expect(RETENTION_POLICIES["rollback-window"].deleteRule).toContain("destroy");
  });

  it("keeps immutable extraction validation aligned with every active source table", () => {
    for (const sourceDatabase of Object.keys(VAY_1350_ACTIVE_SOURCE_TABLES) as SourceDatabase[]) {
      expect([...VAY_1350_ACTIVE_SOURCE_TABLES[sourceDatabase]].sort()).toEqual(
        inventory
          .filter(
            (entry) =>
              entry.sourceDatabase === sourceDatabase &&
              entry.objectType === "table" &&
              entry.lifecycle === "active",
          )
          .map((entry) => entry.objectName)
          .sort(),
      );
    }
  });

  const contractedMigrationObjects = (sourceDatabase: SourceDatabase) =>
    inventory
      .filter(
        (entry) =>
          entry.sourceDatabase === sourceDatabase &&
          ["extension", "materialized_view", "sequence", "table", "view"].includes(
            entry.objectType,
          ),
      )
      .map(({ objectType, objectName }) => `${objectType}:${objectName}`)
      .sort();

  it.each(Object.entries(migrationDirectories) as Array<[ScannedSourceDatabase, string]>)(
    "covers every %s source migration object",
    (sourceDatabase, relativeDirectory) => {
      expect(relativeDirectory).toBe(migrationDirectories[sourceDatabase]);
      expect(contractedMigrationObjects(sourceDatabase)).toEqual(
        discoverMigrationObjects(readMigrationSql(sourceDatabase)),
      );
    },
  );

  it("covers every object of the retired marketplace source", () => {
    expect(contractedMigrationObjects("marketplace")).toEqual(
      FROZEN_MARKETPLACE_SOURCE.migrationObjects,
    );
  });

  it("covers every scheduled, background, and manual legacy writer", () => {
    const scheduler = readFiles("apps/pms-api/app/services/scheduler.py");
    const main = readFiles("apps/pms-api/app/main.py");
    const scheduledIds = [...scheduler.matchAll(/\bid="([a-z][a-z0-9_]*)"/g)]
      .map((match) => match[1])
      .sort();
    const contractedIds = inventory
      .filter((entry) => entry.objectType === "scheduler")
      .map((entry) => entry.objectName)
      .sort();

    expect(contractedIds).toEqual(scheduledIds);
    expect(
      inventory
        .filter((entry) => entry.objectType === "background_writer")
        .map((entry) => entry.objectName),
    ).toEqual(
      [...main.matchAll(/asyncio\.create_task\(\s*(run_[a-z][a-z0-9_]*)\(\)\s*\)/g)].map(
        (match) => match[1],
      ),
    );
    expect(scheduler).toContain("async def poll_channex_messages");
    const manualWriters = ["pms:poll_channex_messages", ...FROZEN_MARKETPLACE_SOURCE.manualWriters];
    for (const sourceDatabase of ["booking", "pms"] as const) {
      for (const filename of readdirSync(join(repoRoot, `apps/${sourceDatabase}-api/scripts`))) {
        if (filename.endsWith(".py") && filename !== "run_migrations.py") {
          manualWriters.push(`${sourceDatabase}:scripts/${filename}`);
        }
      }
    }
    expect(
      inventory
        .filter((entry) => entry.objectType === "manual_writer")
        .map((entry) => `${entry.sourceDatabase}:${entry.objectName}`)
        .sort(),
    ).toEqual(manualWriters.sort());
  });

  it("covers every guarded legacy provider-control surface", () => {
    const channexCutover = readFiles("apps/pms-api/app/services/channex_admin_cutover.py");
    const enumBody = /class ChannexAdminRouteGroup\(StrEnum\):([\s\S]*?)\n\n@dataclass/.exec(
      channexCutover,
    )?.[1];
    expect(enumBody).toBeDefined();
    const controls = [...enumBody!.matchAll(/^\s+[A-Z_]+\s*=\s*"([^"]+)"/gm)].map(
      (match) => `channex:${match[1]}`,
    );
    const financeCutover = readFiles("apps/pms-api/app/services/finance_payout_cutover.py");
    controls.push(/"route": "([^"]+)"/.exec(financeCutover)![1]);

    expect(
      inventory
        .filter((entry) => entry.objectType === "provider_control")
        .map((entry) => entry.objectName),
    ).toEqual(controls);
  });

  it("covers every provider webhook writer", () => {
    const webhooks = readFiles("apps/pms-api/app/routers/webhooks.py");
    const routes = [...webhooks.matchAll(/@router\.post\("([^"]*webhooks?[^\"]*)"\)/g)]
      .map((match) => match[1])
      .sort();
    const contractedRoutes = inventory
      .filter((entry) => entry.objectType === "webhook")
      .map((entry) => entry.objectName)
      .sort();

    expect(contractedRoutes).toEqual(routes);
  });

  it("covers every managed legacy object-store prefix", () => {
    expect(
      inventory
        .filter(
          (entry) => entry.sourceDatabase === "marketplace" && entry.objectType === "object_prefix",
        )
        .map((entry) => entry.objectName)
        .sort(),
    ).toEqual(FROZEN_MARKETPLACE_SOURCE.objectPrefixes);
    const sources: Array<[ScannedSourceDatabase, string]> = [
      [
        "pms",
        readFiles(
          "apps/pms-api/app/routers/upload.py",
          "apps/pms-api/app/repositories/platform_media_repo.py",
        ),
      ],
    ];

    for (const [sourceDatabase, source] of sources) {
      const prefixes = new Set<string>();
      for (const match of source.matchAll(
        /(?:prefix(?:\s*:\s*str)?\s*=\s*|generate_file_key\(\s*)["']([a-z][a-z0-9_-]*)["']/g,
      )) {
        prefixes.add(match[1]);
      }
      if (/\bprefix\s*:\s*str\s*=/.test(source) && /generate_file_key\(\s*prefix\b/.test(source)) {
        prefixes.add("client-supplied:*");
      }
      for (const match of source.matchAll(/storage_key\s*=\s*\(\s*f"([a-z][a-z0-9_-]*)\//g)) {
        prefixes.add(match[1]);
      }
      const contracted = inventory
        .filter(
          (entry) =>
            entry.sourceDatabase === sourceDatabase && entry.objectType === "object_prefix",
        )
        .map((entry) => entry.objectName)
        .sort();
      expect(contracted).toEqual([...prefixes].sort());
    }

    const objectStores = ["booking", "marketplace", "pms"]
      .filter((source) =>
        source === "marketplace"
          ? FROZEN_MARKETPLACE_SOURCE.hasObjectStore
          : existsSync(join(repoRoot, `apps/${source}-api/app/s3_service.py`)),
      )
      .map((source) => `${source}:S3_BUCKET_NAME`);
    expect(
      inventory
        .filter((entry) => entry.objectType === "object_store")
        .map((entry) => `${entry.sourceDatabase}:${entry.objectName}`),
    ).toEqual(objectStores);

    const discoveredReferences = new Set<string>(FROZEN_MARKETPLACE_SOURCE.mediaReferences);
    for (const sourceDatabase of Object.keys(migrationDirectories) as ScannedSourceDatabase[]) {
      for (const reference of discoverMediaReferences(
        sourceDatabase,
        readMigrationSql(sourceDatabase),
      )) {
        discoveredReferences.add(reference);
      }
    }
    // The legacy room importer accepts a URL from an external feed rather than a DB column.
    discoveredReferences.add("pms:external.room_image_imports.source_url");

    const contractedReferences = inventory
      .filter((entry) => entry.objectType === "object_reference")
      .map((entry) => `${entry.sourceDatabase}:${entry.objectName}`)
      .sort();
    expect(contractedReferences).toEqual([...discoveredReferences].sort());

    const mediaManifest = JSON.parse(
      readFiles("packages/backend-migration/fixtures/cases/media-url-migration/manifest.json"),
    ) as { knownCoverageGaps: string[]; sourceReferences: string[] };
    expect(
      mediaManifest.sourceReferences.every((reference) => discoveredReferences.has(reference)),
    ).toBe(true);
    expect(mediaManifest.knownCoverageGaps.sort()).toEqual(
      inventory
        .filter(
          (entry) =>
            entry.objectType === "object_reference" &&
            entry.lifecycle === "active" &&
            entry.fixtureCase === "none",
        )
        .map((entry) => `${entry.sourceDatabase}:${entry.objectName}`)
        .sort(),
    );
  });

  it("defines immutable snapshot inputs and read-only count/fingerprint queries", () => {
    expect(REQUIRED_SOURCE_SNAPSHOT_ARGUMENTS).toEqual([
      "--auth-snapshot-arn",
      "--booking-snapshot-arn",
      "--marketplace-snapshot-arn",
      "--pms-snapshot-arn",
    ]);
    expect(REQUIRED_SOURCE_REVISION_ARGUMENT).toBe("--source-schema-revision");
    expect(SOURCE_READ_ONLY_TRANSACTION_SQL).toContain("READ ONLY");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).toContain("pg_catalog.pg_extension");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).toContain("pg_catalog.pg_get_viewdef");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).toContain("pg_catalog.pg_sequence");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).toContain("pg_catalog.pg_enum");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).toContain("vayada_migration_evidence");
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL.match(/vayada_migration_evidence/g)).toHaveLength(7);
    expect(SOURCE_SCHEMA_FINGERPRINT_SQL).not.toMatch(/\b(?:DELETE|DROP|INSERT|UPDATE)\b/i);

    const authCounts = buildSourceRowCountQueries(inventory, "auth");
    expect(authCounts).toHaveLength(13);
    expect(authCounts[0]?.sql).toMatch(/^SELECT count\(\*\)::bigint AS row_count FROM "public"\./);
    expect(authCounts.every(({ sql }) => !/\b(?:DELETE|DROP|INSERT|UPDATE)\b/i.test(sql))).toBe(
      true,
    );
    expect(
      buildSourceRowCountQueries(inventory, "booking").map(({ objectName }) => objectName),
    ).not.toContain("public.lodgify_connections");
  });
});
