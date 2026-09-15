import { createHash } from "node:crypto";
import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { parseLegacyOwnerSetupCommand } from "./legacyOwnerSetupCommand.js";

const hash = (kind: string, value: unknown) =>
  createHash("sha256")
    .update(`vayada:legacy-owner-internal-setup:v1\0${kind}\0`)
    .update(canonicalizeJson(value))
    .digest("hex");

/** Final storage stage only, NOT an authorized executor. Trusted caller must
 * verify evidence/signature/approvals BEFORE replay lookup, retain all approval,
 * conflict and DDL locks, and verify the scoped email index before calling.
 * No runtime/CLI consumer. Caller commits only after its remaining checks. */
export async function writeLegacyOwnerSetupCheckpoint(
  client: AdoptionQueryClient,
  payload: string,
  expected: Parameters<typeof parseLegacyOwnerSetupCommand>[1],
  audit: { approvalEnvelopeSha256: string; executorPrincipalSha256: string },
  now: Date,
): Promise<{ outcome: "checkpoint_written_uncommitted"; commandId: string }> {
  let savepoint = false;
  try {
    const { command, commandSha256 } = parseLegacyOwnerSetupCommand(payload, expected, now);
    const approvalHash = audit.approvalEnvelopeSha256,
      executorHash = audit.executorPrincipalSha256;
    if (
      ![approvalHash, executorHash].every(
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
      )
    )
      throw new Error();
    const sourceHash = hash("source-evidence", {
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
    });
    const beforeHash = hash(
      "target-before",
      command.owners.map((owner) => ({
        ownerId: owner.ownerId,
        targetBeforeSha256: owner.targetBeforeSha256,
      })),
    );
    const rows = command.owners.map((owner) => ({
      id: owner.ownerId,
      email: owner.email,
      name: owner.name,
    }));
    // SAVEPOINT requires an existing transaction; do not allow implicit commit.
    await client.query("SAVEPOINT vay2017_setup_checkpoint");
    savepoint = true;
    const result = await client.query<{ commandId: string; valid: boolean }>(
      `WITH wanted AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS w(id uuid,email text,name text)
       ), inserted AS (
         INSERT INTO identity.users(id,email,name,status,created_at,updated_at)
         SELECT id,email,name,'pending',$2::timestamptz,$2::timestamptz FROM wanted ORDER BY id
         RETURNING id,email,name,status,created_at,updated_at
       ), checked AS (
         SELECT count(*)=$3::int AND bool_and(i.email=w.email AND i.name IS NOT DISTINCT FROM w.name
           AND i.status='pending' AND i.created_at=$2::timestamptz AND i.updated_at=$2::timestamptz) AS valid
         FROM inserted i JOIN wanted w USING(id)
       ), after_state AS (
         SELECT encode(sha256(convert_to('vayada:legacy-owner-internal-setup:v1:target-after','UTF8')
           ||decode('00','hex')||convert_to(jsonb_agg(jsonb_build_object(
             'id',id,'email',email,'name',name,'status',status,
             'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) ORDER BY id)::text,'UTF8')),'hex') AS sha FROM inserted
       )
       INSERT INTO platform.legacy_owner_bootstrap_receipts
         (command_id,contract_version,environment,payload_sha256,owner_user_ids,
          source_run_id,source_evidence_sha256,target_before_sha256,target_after_sha256,
          approval_envelope_sha256,executor_principal_sha256,checkpoint)
       SELECT $4::uuid,'legacy-owner-internal-setup.v1',$5,$6,
         ARRAY(SELECT id FROM inserted ORDER BY id),$7,$8,$9,
         (SELECT sha FROM after_state),
         $10,$11,'internal_users_prepared'
       WHERE (SELECT valid FROM checked) AND (SELECT count(*) FROM inserted)=$3::int
       RETURNING command_id::text AS "commandId",
         contract_version='legacy-owner-internal-setup.v1' AND environment=$5 AND payload_sha256=$6
         AND owner_user_ids=ARRAY(SELECT id FROM inserted ORDER BY id) AND source_run_id=$7
         AND source_evidence_sha256=$8 AND target_before_sha256=$9
         AND target_after_sha256=(SELECT sha FROM after_state) AND approval_envelope_sha256=$10
         AND executor_principal_sha256=$11 AND checkpoint='internal_users_prepared'
         AND recorded_at>=statement_timestamp() AND recorded_at<=clock_timestamp() AS valid`,
      [
        JSON.stringify(rows),
        command.issuedAt,
        rows.length,
        command.commandId,
        command.environment,
        commandSha256,
        command.sourceRunId,
        sourceHash,
        beforeHash,
        approvalHash,
        executorHash,
      ],
    );
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.commandId !== command.commandId ||
      result.rows[0]?.valid !== true
    )
      throw new Error();
    await client.query("RELEASE SAVEPOINT vay2017_setup_checkpoint");
    savepoint = false;
    return { outcome: "checkpoint_written_uncommitted", commandId: command.commandId };
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_setup_checkpoint");
        await client.query("RELEASE SAVEPOINT vay2017_setup_checkpoint");
      } catch {
        throw new Error("LEGACY_OWNER_SETUP_CHECKPOINT_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_SETUP_CHECKPOINT_FAILED");
  }
}
