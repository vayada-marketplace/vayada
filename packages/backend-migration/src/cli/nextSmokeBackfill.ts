#!/usr/bin/env node
import {
  NEXT_SMOKE_AFFILIATE_EMAIL,
  NEXT_SMOKE_AFFILIATE_RESOURCE_ID,
  NEXT_SMOKE_BOOKING_HOTEL_ID,
  NEXT_SMOKE_CONFIRM,
  normalizeModuleIds,
  runNextSmokeBackfill,
  type NextSmokeBackfillMode,
} from "../nextSmokeBackfill.js";

function parseArgs(argv: string[]): {
  mode: NextSmokeBackfillMode;
  targetConnectionString: string;
  bookingHotelId: string;
  hotelOrganizationId?: string;
  marketplaceHotelProfileResourceId?: string;
  affiliateUserEmail: string;
  affiliateOrganizationId?: string;
  affiliateResourceId: string;
  affiliateWorkosOrgId?: string;
  affiliateWorkosMembershipId?: string;
  pmsConnectionString?: string;
  pmsHotelId?: string;
  moduleIds: string[];
  confirm: string;
} {
  const args = argv.slice(2);
  let mode: NextSmokeBackfillMode = "dry-run";
  let targetConnectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let bookingHotelId = NEXT_SMOKE_BOOKING_HOTEL_ID;
  let hotelOrganizationId = "";
  let marketplaceHotelProfileResourceId = "";
  let affiliateUserEmail = NEXT_SMOKE_AFFILIATE_EMAIL;
  let affiliateOrganizationId = "";
  let affiliateResourceId = NEXT_SMOKE_AFFILIATE_RESOURCE_ID;
  let affiliateWorkosOrgId = "";
  let affiliateWorkosMembershipId = "";
  let pmsConnectionString = process.env["PMS_DATABASE_URL"] ?? "";
  let pmsHotelId = "";
  const moduleIds: string[] = [];
  let confirm = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--apply") mode = "apply";
    else if (arg === "--connection-string" && args[i + 1]) targetConnectionString = args[++i]!;
    else if (arg === "--booking-hotel-id" && args[i + 1]) bookingHotelId = args[++i]!;
    else if (arg === "--hotel-organization-id" && args[i + 1]) {
      hotelOrganizationId = args[++i]!;
    } else if (arg === "--marketplace-hotel-profile-resource-id" && args[i + 1]) {
      marketplaceHotelProfileResourceId = args[++i]!;
    } else if (arg === "--affiliate-user-email" && args[i + 1]) {
      affiliateUserEmail = args[++i]!;
    } else if (arg === "--affiliate-organization-id" && args[i + 1]) {
      affiliateOrganizationId = args[++i]!;
    } else if (arg === "--affiliate-resource-id" && args[i + 1]) {
      affiliateResourceId = args[++i]!;
    } else if (arg === "--affiliate-workos-org-id" && args[i + 1]) {
      affiliateWorkosOrgId = args[++i]!;
    } else if (arg === "--affiliate-workos-membership-id" && args[i + 1]) {
      affiliateWorkosMembershipId = args[++i]!;
    } else if (arg === "--pms-connection-string" && args[i + 1]) {
      pmsConnectionString = args[++i]!;
    } else if (arg === "--pms-hotel-id" && args[i + 1]) {
      pmsHotelId = args[++i]!;
    } else if (arg === "--module-id" && args[i + 1]) {
      moduleIds.push(args[++i]!);
    } else if (arg === "--confirm" && args[i + 1]) {
      confirm = args[++i]!;
    }
  }

  return {
    mode,
    targetConnectionString,
    bookingHotelId,
    hotelOrganizationId: hotelOrganizationId || undefined,
    marketplaceHotelProfileResourceId: marketplaceHotelProfileResourceId || undefined,
    affiliateUserEmail,
    affiliateOrganizationId: affiliateOrganizationId || undefined,
    affiliateResourceId,
    affiliateWorkosOrgId: affiliateWorkosOrgId || undefined,
    affiliateWorkosMembershipId: affiliateWorkosMembershipId || undefined,
    pmsConnectionString: pmsConnectionString || undefined,
    pmsHotelId: pmsHotelId || undefined,
    moduleIds: normalizeModuleIds(moduleIds),
    confirm,
  };
}

const args = parseArgs(process.argv);

if (!args.targetConnectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}
if (args.mode === "apply" && args.confirm !== NEXT_SMOKE_CONFIRM) {
  console.error(`Error: --apply requires --confirm ${NEXT_SMOKE_CONFIRM}.`);
  process.exit(1);
}

const result = await runNextSmokeBackfill(args);
console.log(JSON.stringify(result, null, 2));
if (args.mode === "dry-run") {
  console.log(`Dry run only. Re-run with --apply --confirm ${NEXT_SMOKE_CONFIRM} to write.`);
}
if (result.blockers.length > 0) {
  process.exitCode = 2;
}
