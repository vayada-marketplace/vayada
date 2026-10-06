import pg from "pg";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { parseHotelSetupHelperOwnerConfiguration } from "./hotelSetupAutomaticProvisioning.js";
import {
  runHotelSetupLogoCleanup,
  type HotelSetupLogoCleanupTarget,
} from "../hotelSetupLogoCleanup.js";
import { pathToFileURL } from "node:url";

export async function runProtectedHotelSetupLogoCleanup(env: NodeJS.ProcessEnv = process.env) {
  let pool: pg.Pool | undefined;
  let s3: S3Client | undefined;
  try {
    if (
      import.meta.url !== "file:///app/apps/api/dist/cli/hotelSetupLogoCleanup.js" ||
      env.PLATFORM_MEDIA_BUCKET !== "vayada-media-production"
    )
      throw new Error();
    if (
      env.HOTEL_SETUP_LOGO_CLEANUP_APPLY !== undefined &&
      env.HOTEL_SETUP_LOGO_CLEANUP_APPLY !== "blocked" &&
      env.HOTEL_SETUP_LOGO_CLEANUP_APPLY !== "enabled"
    )
      throw new Error();
    const expectedManifestSha256 =
      env.HOTEL_SETUP_LOGO_CLEANUP_APPLY === "enabled"
        ? env.HOTEL_SETUP_LOGO_CLEANUP_EXPECTED_MANIFEST_SHA256
        : undefined;
    if (
      env.HOTEL_SETUP_LOGO_CLEANUP_APPLY === "enabled" &&
      !/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? "")
    )
      throw new Error();
    const databaseUrl = parseHotelSetupHelperOwnerConfiguration(env, "/tmp/hotel-setup-rds.pem");
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
    });
    s3 = new S3Client({
      requestHandler: NodeHttpHandler.create({
        connectionTimeout: 3_000,
        requestTimeout: 15_000,
        socketTimeout: 15_000,
        throwOnRequestTimeout: true,
      }),
    });
    const receipt = await runHotelSetupLogoCleanup({
      pool,
      expectedManifestSha256,
      target: {
        kind: env.HOTEL_SETUP_LOGO_CLEANUP_KIND as HotelSetupLogoCleanupTarget["kind"],
        targetId: env.HOTEL_SETUP_LOGO_CLEANUP_TARGET_ID ?? "",
        propertyId: env.HOTEL_SETUP_COMMAND_PROPERTY_ID ?? "",
        organizationId: env.HOTEL_SETUP_COMMAND_ORGANIZATION_ID ?? "",
        actorUserId: env.HOTEL_SETUP_COMMAND_ACTOR_USER_ID ?? "",
      },
      deleteKey: async (key) => {
        await s3!.send(new DeleteObjectCommand({ Bucket: "vayada-media-production", Key: key }));
      },
    });
    console.log(JSON.stringify(receipt));
    return 0;
  } catch {
    console.error(
      JSON.stringify({ status: "FAIL", code: "hotel_setup_logo_cleanup_inspection_required" }),
    );
    return 1;
  } finally {
    s3?.destroy();
    await pool?.end().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runProtectedHotelSetupLogoCleanup();
