import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { lockAndVerifyLegacyOwnerSetupApprovals } from "./legacyOwnerSetupApprovalLocks.js";
import { hashLegacyOwnerSetupEnvelope } from "./legacyOwnerSetupApprovals.js";
import { verifyLegacyOwnerSetupRequest } from "./legacyOwnerSetupRequest.js";
import {
  hashLegacyOwnerSetupValue,
  legacyOwnerSetupReceiptHashes,
  LEGACY_OWNER_SETUP_AFTER_HASH_SQL,
} from "./legacyOwnerSetupReceiptHashes.js";

/** Request/registry-before-receipt composition, NOT the complete executor.
 * Trusted caller authenticates evidence artifacts, database and policy first.
 * Requires a dedicated bounded READ COMMITTED transaction. Retain all locks
 * through later target checks/checkpoint/commit; roll back ALL on failure.
 * Immutable command/authority uniqueness serializes same-command callers via
 * the approval row locks. Receipt storage/append-only enforcement are trusted.
 * No receipt is write authority, current user state or proof of outer commit. */
export async function inspectLegacyOwnerSetupReplay(
  client: AdoptionQueryClient,
  input: Parameters<typeof verifyLegacyOwnerSetupRequest>[0],
  expected: Parameters<typeof verifyLegacyOwnerSetupRequest>[1],
  policy: Parameters<typeof lockAndVerifyLegacyOwnerSetupApprovals>[2],
  clock: () => Date = () => new Date(),
) {
  let savepoint = false;
  try {
    const captured = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const context = structuredClone(expected);
    const trusted = {
      ...policy,
      signingPrincipals: new Map(policy.signingPrincipals),
      actors: structuredClone(new Map(policy.actors)),
      singleHumanDualAuthority: policy.singleHumanDualAuthority
        ? { ...policy.singleHumanDualAuthority }
        : undefined,
    };
    const { command, commandSha256 } = verifyLegacyOwnerSetupRequest(captured, context, clock());
    const audit = {
      approvalEnvelopeSha256: hashLegacyOwnerSetupEnvelope(captured.envelopePayload),
      executorPrincipalSha256: hashLegacyOwnerSetupValue(
        "executor-principal",
        trusted.executionPrincipal,
      ),
    };
    const { sourceHash, beforeHash } = legacyOwnerSetupReceiptHashes(command);
    await client.query("SAVEPOINT vay2017_setup_replay");
    savepoint = true;
    await lockAndVerifyLegacyOwnerSetupApprovals(
      client,
      {
        canonicalPayload: captured.envelopePayload,
        detachedSignature: captured.detachedSignature,
        verificationKeys: captured.verificationKeys,
        expectedCommandSha256: commandSha256,
        environment: context.environment,
      },
      trusted,
      clock,
    );
    await client.query("SET LOCAL search_path = pg_catalog");
    // Always produce a visibility result, even when RLS hides every receipt.
    const result = await client.query<{
      visible: boolean;
      commandId: string | null;
      valid: boolean | null;
      afterHash: string | null;
    }>(
      `WITH wanted AS (
        SELECT id,email,name,'pending'::text AS status,$12::timestamptz AS created_at,
          $12::timestamptz AS updated_at
        FROM jsonb_to_recordset($11::jsonb) AS w(id uuid,email text,name text)
      ) SELECT NOT row_security_active('platform.legacy_owner_bootstrap_receipts'::regclass) AS visible,
        r.command_id::text AS "commandId",r.target_after_sha256 AS "afterHash",
        r.contract_version='legacy-owner-internal-setup.v1' AND r.environment=$2
        AND r.payload_sha256=$3 AND r.owner_user_ids=$4::uuid[] AND r.source_run_id=$5
        AND r.source_evidence_sha256=$6 AND r.target_before_sha256=$7
        AND r.approval_envelope_sha256=$8 AND r.executor_principal_sha256=$9
        AND r.checkpoint=$10 AND isfinite(r.recorded_at)
        AND r.target_after_sha256=(SELECT ${LEGACY_OWNER_SETUP_AFTER_HASH_SQL} FROM wanted) AS valid
      FROM (SELECT 1) seed LEFT JOIN platform.legacy_owner_bootstrap_receipts r ON r.command_id=$1::uuid`,
      [
        command.commandId,
        command.environment,
        commandSha256,
        command.owners.map((o) => o.ownerId),
        command.sourceRunId,
        sourceHash,
        beforeHash,
        audit.approvalEnvelopeSha256,
        audit.executorPrincipalSha256,
        "internal_users_prepared",
        JSON.stringify(
          command.owners.map((o) => ({ id: o.ownerId, email: o.email, name: o.name })),
        ),
        command.issuedAt,
      ],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row?.visible !== true ||
      (row.commandId !== null && (row.commandId !== command.commandId || row.valid !== true))
    )
      throw new Error();
    verifyLegacyOwnerSetupRequest(captured, context, clock());
    await client.query("RELEASE SAVEPOINT vay2017_setup_replay");
    savepoint = false;
    return {
      outcome:
        row.commandId === null
          ? ("no_receipt_requires_evidence_and_target_checks" as const)
          : ("matching_receipt_found" as const),
      executable: false as const,
      audit,
      receipt:
        row.commandId === null
          ? null
          : {
              commandId: row.commandId,
              checkpoint: "internal_users_prepared" as const,
              targetAfterSha256: row.afterHash!,
            },
    };
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_setup_replay");
        await client.query("RELEASE SAVEPOINT vay2017_setup_replay");
      } catch {
        throw new Error("LEGACY_OWNER_SETUP_REPLAY_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_SETUP_REPLAY_INVALID");
  }
}
