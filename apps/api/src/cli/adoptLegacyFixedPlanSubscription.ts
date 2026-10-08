#!/usr/bin/env node
/**
 * VAY-1362: adopt a live legacy fixed-plan Stripe subscription into the target,
 * or clear a stale legacy billing reference. Dry run by default; one hotel per
 * run. See engineering/legacy-fixed-plan-billing-handover.md §3.
 *
 *   TARGET_DATABASE_URL=... STRIPE_SECRET_KEY=... \
 *   npm --workspace vayada-api run finance:legacy-subscription:adopt -- \
 *     --property-id <uuid> --subscription-id sub_... [--apply-for-property <uuid>]
 *
 *   ... --mode clear-stale-reference --property-id <uuid> [--revert-legacy-fixed]
 *       [--apply-for-property <uuid>]
 *
 *   ... --mode inventory     (read-only; exits 2 while the reopen gate is closed)
 *
 * BOOKING_HOST_BASE (optional) lets an applied run refresh public bookability.
 */
import { parseArgs } from "node:util";

import pg from "pg";

import {
  adoptLegacyFixedPlanSubscription,
  clearStaleLegacyBillingReference,
  createPgLegacyAdoptionStore,
} from "../domains/financeLegacySubscriptionAdoption.js";
import { inventoryLegacyFixedPlanSubscriptions } from "../domains/financeLegacySubscriptionInventory.js";
import { createTargetPmsRoomInventoryReadPort } from "../domains/pmsRoomInventoryReadModel.js";
import { createStripeLegacySubscriptionAdoption } from "../domains/stripeLegacySubscriptionAdoption.js";
import { createTargetPublicBookabilityPublicationCommandPort } from "../platform/publicBookabilityPublication.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    "property-id": { type: "string" },
    "subscription-id": { type: "string" },
    "apply-for-property": { type: "string" },
    "revert-legacy-fixed": { type: "boolean" },
  },
});
const mode = values.mode ?? "adopt";
// Legacy hotel_id metadata and target UUIDs are lowercase; normalize operator input.
const propertyId = (values["property-id"] ?? "").toLowerCase();
const subscriptionId = values["subscription-id"] ?? "";
const apply = values["apply-for-property"] !== undefined;
const revertLegacyFixed = values["revert-legacy-fixed"] === true;
const databaseUrl = process.env["TARGET_DATABASE_URL"];
const stripeSecretKey = process.env["STRIPE_SECRET_KEY"];
if (mode !== "adopt" && mode !== "clear-stale-reference" && mode !== "inventory") {
  throw new Error("--mode must be adopt, clear-stale-reference or inventory");
}
if (!databaseUrl || !stripeSecretKey) {
  throw new Error("TARGET_DATABASE_URL and STRIPE_SECRET_KEY are required");
}
if (revertLegacyFixed && mode !== "clear-stale-reference") {
  throw new Error("--revert-legacy-fixed only applies to --mode clear-stale-reference");
}
if (mode === "inventory") {
  if (apply || propertyId || subscriptionId) {
    throw new Error("--mode inventory is read-only and takes no property or subscription");
  }
  await runInventory(databaseUrl, stripeSecretKey);
} else {
  await runForProperty(databaseUrl, stripeSecretKey);
}

async function runInventory(databaseUrl: string, stripeSecretKey: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const report = await inventoryLegacyFixedPlanSubscriptions({
      store: createPgLegacyAdoptionStore(pool),
      stripe: createStripeLegacySubscriptionAdoption({ secretKey: stripeSecretKey }),
    });
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.reopenAllowed) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ error: error instanceof Error ? error.message : "inventory_failed" }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function runForProperty(databaseUrl: string, stripeSecretKey: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) {
    throw new Error("--property-id must be a UUID");
  }
  if (mode === "adopt" && !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    throw new Error("--subscription-id must be a Stripe subscription ID (sub_...)");
  }
  if (apply && values["apply-for-property"]?.toLowerCase() !== propertyId.toLowerCase()) {
    throw new Error("--apply-for-property must match --property-id");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const roomInventory = createTargetPmsRoomInventoryReadPort({ connectionString: databaseUrl });
  const bookability = process.env["BOOKING_HOST_BASE"]
    ? createTargetPublicBookabilityPublicationCommandPort({
        connectionString: databaseUrl,
        bookingHostBase: process.env["BOOKING_HOST_BASE"],
      })
    : undefined;
  const dependencies = {
    store: createPgLegacyAdoptionStore(pool),
    stripe: createStripeLegacySubscriptionAdoption({ secretKey: stripeSecretKey }),
    roomInventory,
    refreshPublicBookability: bookability
      ? async (id: string) => {
          await bookability.publish({ propertyId: id });
        }
      : undefined,
  };
  try {
    const report =
      mode === "adopt"
        ? await adoptLegacyFixedPlanSubscription(
            { propertyId, subscriptionId, apply },
            dependencies,
          )
        : await clearStaleLegacyBillingReference(
            { propertyId, apply, revertLegacyFixed },
            dependencies,
          );
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.outcome === "refused" || report.reasons.length > 0) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ error: error instanceof Error ? error.message : "adoption_failed" }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    await bookability?.close?.();
    await roomInventory.close?.();
    await pool.end();
  }
}
