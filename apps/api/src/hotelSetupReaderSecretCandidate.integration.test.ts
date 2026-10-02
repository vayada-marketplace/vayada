import { randomBytes } from "node:crypto";
import {
  DescribeSecretCommand,
  ListSecretVersionIdsCommand,
  GetSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { stageHotelSetupReaderRole } from "./hotelSetupReaderRoleStaging.js";
import { stageVerifiedHotelSetupReaderSecret } from "./hotelSetupReaderSecretCandidate.js";

const connectionString = process.env.HOTEL_SETUP_READER_CANDIDATE_TEST_DATABASE_URL;
describe.runIf(connectionString)("verified secret candidate on isolated TLS PostgreSQL", () => {
  it("stores nothing until the real native reader passes and never writes hotel data", async () => {
    const url = new URL(connectionString!);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.pathname.startsWith("/vay1092_") ||
      !process.env.NODE_EXTRA_CA_CERTS
    )
      throw new Error("Secret candidate requires an owned local TLS cluster and test CA");
    const admin = new pg.Client({ connectionString });
    await admin.connect();
    const role = "vayada_next_hotel_setup_reader";
    const password = randomBytes(36).toString("base64url");
    const databases = (
      await admin.query<{ name: string; privileges: string[] }>(`
      SELECT d.datname AS name, COALESCE(array_agg(a.privilege_type)
        FILTER (WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_catalog.pg_database d LEFT JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
    ).rows;
    let created = false;
    let isolated = false;
    const counts = async () =>
      (
        await admin.query(`SELECT
      (SELECT count(*) FROM platform.product_audit_events)::text AS audits,
      (SELECT count(*) FROM finance.expense_categories)::text AS categories,
      (SELECT count(*) FROM pms.property_pricing_settings)::text AS pricing`)
      ).rows;
    try {
      await stageHotelSetupReaderRole({ connectionString });
      created = true;
      await admin.query("BEGIN");
      await admin.query("SELECT pg_catalog.set_config('vay1092.test_password',$1,true)", [
        password,
      ]);
      await admin.query(`DO $$ BEGIN EXECUTE pg_catalog.format('ALTER ROLE ${role} LOGIN PASSWORD %L',
        pg_catalog.current_setting('vay1092.test_password')); END $$`);
      await admin.query("COMMIT"); // Test-only activation; helper never enables this login.
      const before = await counts();
      const reader = new URL(url);
      reader.username = role;
      reader.password = password;
      reader.search = "?sslmode=verify-full";
      const endpoint = new URL(reader);
      endpoint.username = endpoint.password = endpoint.search = "";
      const secretArn =
        "arn:aws:secretsmanager:eu-west-1:269416271598:secret:hotel-setup-command/prod/reader-database-url-ABC123";
      const calls: unknown[] = [];
      let candidate: CreateSecretCommand["input"];
      const secrets = {
        async send(
          command:
            | DescribeSecretCommand
            | ListSecretVersionIdsCommand
            | CreateSecretCommand
            | GetSecretValueCommand,
        ) {
          calls.push(command);
          if (command instanceof DescribeSecretCommand)
            return {
              ARN: secretArn,
              Name: "hotel-setup-command/prod/reader-database-url",
              VersionIdsToStages: {},
            };
          if (command instanceof ListSecretVersionIdsCommand)
            return { ARN: secretArn, Versions: [] };
          if (command instanceof CreateSecretCommand) {
            candidate = command.input;
            return {
              ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${candidate.Name}-DEF456`,
              Name: candidate.Name,
              VersionId: candidate.ClientRequestToken,
            };
          }
          return {
            ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${candidate!.Name}-DEF456`,
            VersionId: candidate!.ClientRequestToken,
            SecretString: candidate!.SecretString,
            VersionStages: ["AWSCURRENT"],
          };
        },
      } as never;
      const input = {
        secrets,
        secretArn,
        readerDatabaseUrl: reader.toString(),
        databaseEndpoint: endpoint.toString(),
      };
      await expect(stageVerifiedHotelSetupReaderSecret(input)).rejects.toThrow(
        "secret candidate failed",
      );
      expect(calls).toEqual([]); // Default PUBLIC database access is unsafe.
      isolated = true;
      for (const database of databases)
        await admin.query(
          `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
        );
      const version = await stageVerifiedHotelSetupReaderSecret(input);
      expect(calls).toHaveLength(4);
      expect(candidate!.SecretString).toBe(reader.toString());
      expect(candidate!.Name).toBe(
        `hotel-setup-command/prod/reader-candidate/${version.versionId}`,
      );
      expect(version.secretArn).not.toBe(secretArn);
      calls.length = 0;
      reader.password = randomBytes(36).toString("base64url");
      await expect(
        stageVerifiedHotelSetupReaderSecret({ ...input, readerDatabaseUrl: reader.toString() }),
      ).rejects.toThrow("secret candidate failed");
      expect(calls).toEqual([]);
      expect(await counts()).toEqual(before);
    } finally {
      await admin.query("ROLLBACK");
      if (created) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      if (isolated)
        for (const database of databases) {
          await admin.query(
            `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
          );
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
            );
        }
      await admin.end();
    }
  }, 60000);
});
