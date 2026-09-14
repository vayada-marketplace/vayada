import { z } from "zod";
import type { Pool } from "pg";
import type { AirbnbImportRoutesOptions } from "../routes/airbnbImports.js";
import { readChannexImportResponse } from "./channexImportResponse.js";

const evidenceSchema = z.strictObject({
  contractVersion: z.literal("channex-property-creation.v1"),
  environment: z.enum(["staging", "production"]),
  externalPropertyId: z.uuid().transform((id) => id.toLowerCase()),
  jobId: z.uuid(),
});
const propertySchema = z.object({
  data: z.object({
    type: z.literal("property"),
    id: z.uuid().transform((id) => id.toLowerCase()),
    relationships: z.object({
      groups: z.object({
        data: z.array(z.object({ type: z.literal("group"), id: z.uuid() })).length(1),
      }),
    }),
  }),
});

/** Internal route port: caller must authorize actor, organization and property access. */
export function createChannexAirbnbBindingResolver(options: {
  database: Pick<Pool, "query">;
  environment: "staging" | "production";
  apiKey: string;
  fetcher?: typeof fetch;
}): AirbnbImportRoutesOptions["resolveBinding"] {
  if (!["staging", "production"].includes(options.environment) || !options.apiKey)
    throw new Error("Invalid Airbnb binding configuration");
  const origin =
    options.environment === "staging" ? "https://staging.channex.io" : "https://app.channex.io";
  async function readEvidence(propertyId: string) {
    const result = await options.database.query(
      `SELECT c.external_property_id, c.connection_metadata->'airbnbCreationEvidence' AS evidence
       FROM pms.channel_connections c
       JOIN pms.channel_binding_claims b ON b.property_id=c.property_id
         AND b.provider=c.provider AND b.external_property_id=c.external_property_id
       WHERE c.property_id=$1::uuid AND c.provider='channex'
         AND c.connection_status='connected' AND b.claim_state='active' AND b.claim_source='enable'`,
      [propertyId],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0];
    const proof = evidenceSchema.safeParse(row.evidence);
    if (
      !proof.success ||
      proof.data.environment !== options.environment ||
      typeof row.external_property_id !== "string" ||
      proof.data.externalPropertyId !== row.external_property_id.toLowerCase()
    )
      return null;
    return proof.data;
  }
  return async (scope) => {
    if (!z.uuid().safeParse(scope.propertyId).success) return null;
    const proof = await readEvidence(scope.propertyId);
    if (!proof) return null;
    try {
      const response = await (options.fetcher ?? fetch)(
        `${origin}/api/v1/properties/${proof.externalPropertyId}`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: { "user-api-key": options.apiKey, Accept: "application/json" },
        },
      );
      const parsed = propertySchema.safeParse(await readChannexImportResponse(response));
      if (!parsed.success || parsed.data.data.id !== proof.externalPropertyId) return null;
      // Recheck after provider I/O: disconnect or replacement must invalidate this lookup.
      const current = await readEvidence(scope.propertyId);
      if (
        !current ||
        current.jobId !== proof.jobId ||
        current.externalPropertyId !== proof.externalPropertyId
      )
        return null;
      return {
        environment: proof.environment,
        externalPropertyId: proof.externalPropertyId,
        groupId: parsed.data.data.relationships.groups.data[0]!.id.toLowerCase(),
      };
    } catch {
      throw new Error("Airbnb property binding could not be verified");
    }
  };
}
