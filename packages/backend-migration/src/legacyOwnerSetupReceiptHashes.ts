import { createHash } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import type { LegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";

export const hashLegacyOwnerSetupValue = (kind: string, value: unknown): string =>
  createHash("sha256")
    .update(`vayada:legacy-owner-internal-setup:v1\0${kind}\0`)
    .update(canonicalizeJson(value))
    .digest("hex");

// Shared by storage and replay; fingerprints are bindings, not authenticated evidence.
export function legacyOwnerSetupReceiptHashes(command: LegacyOwnerSetupCommand) {
  return {
    sourceHash: hashLegacyOwnerSetupValue("source-evidence", {
      ledger: command.sourceLedgerSha256,
      owners: command.owners.map(
        ({
          email: _email,
          name: _name,
          status: _status,
          expectedTarget: _target,
          targetBeforeSha256: _before,
          ...source
        }) => source,
      ),
    }),
    beforeHash: hashLegacyOwnerSetupValue(
      "target-before",
      command.owners.map((owner) => ({
        ownerId: owner.ownerId,
        targetBeforeSha256: owner.targetBeforeSha256,
      })),
    ),
  };
}

export const LEGACY_OWNER_SETUP_AFTER_HASH_SQL = `encode(sha256(convert_to('vayada:legacy-owner-internal-setup:v1:target-after','UTF8')
  ||decode('00','hex')||convert_to(jsonb_agg(jsonb_build_object(
    'id',id,'email',email,'name',name,'status',status,
    'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY id)::text,'UTF8')),'hex')`;
