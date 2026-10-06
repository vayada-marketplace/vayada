import { createHash } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import {
  createHotelSetupActorCredentialResolver,
  HotelSetupAssignmentMissingError,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";
import { assertHotelSetupProfilePrivileges } from "./hotelSetupProfilePrivileges.js";
import {
  propertyProfileWritePayload,
  toSharedPropertyProfile,
  type SharedPropertyProfileRow,
} from "./platform/sharedHotelSetupStatusReadModel.js";
import type {
  HotelSetupPropertyProfileCommand,
  HotelSetupPropertyProfileResult,
} from "./routes/sharedHotelSetupStatus.js";

type ProfileScope = { propertyId: string; organizationId: string; actorUserId: string };

/** Private executor only; no ambient pool, fallback or credential caching. */
export function createHotelSetupProfileCommands(options: HotelSetupCredentialOptions) {
  const resolveCredential = createHotelSetupActorCredentialResolver(options, "property_profile");
  return {
    async updatePropertyProfile(
      context: RequestContext,
      propertyId: string,
      command: HotelSetupPropertyProfileCommand,
    ): Promise<HotelSetupPropertyProfileResult> {
      const scope = {
        propertyId,
        organizationId: context.selectedOrganization.organizationId,
        actorUserId: context.actor.internalUserId,
      };
      let pool: pg.Pool | undefined;
      try {
        const connectionString = await resolveCredential(
          scope.propertyId,
          scope.organizationId,
          scope.actorUserId,
        );
        pool = new pg.Pool({ connectionString, max: 1 });
        const correlation = (context.audit.correlationId ?? context.audit.requestId).slice(0, 200);
        return await writeHotelSetupPropertyProfile(pool, scope, correlation, command);
      } catch (error) {
        if (error instanceof AuthorizationError) throw error;
        // Credentials are provisioned per property and Owner; retrying cannot help.
        if (error instanceof HotelSetupAssignmentMissingError) return { status: "not_provisioned" };
        throw new Error("Hotel setup profile command unavailable");
      } finally {
        await pool?.end().catch(() => undefined);
      }
    },
  };
}

/** One READ COMMITTED transaction: attest, locked snapshot, shared parse, fixed writer. */
export async function writeHotelSetupPropertyProfile(
  pool: Pick<pg.Pool, "connect">,
  scope: ProfileScope,
  correlation: string,
  command: HotelSetupPropertyProfileCommand,
): Promise<HotelSetupPropertyProfileResult> {
  const ids = [scope.propertyId, scope.organizationId, scope.actorUserId];
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await assertHotelSetupProfilePrivileges(client);
    const snapshot = await client.query<{ value: SharedPropertyProfileRow }>(
      "SELECT platform.hotel_setup_property_profile_snapshot($1,$2,$3) AS value",
      ids,
    );
    const update = command.merge(toSharedPropertyProfile(snapshot.rows[0]!.value).profile);
    if ("fields" in update) {
      await client.query("ROLLBACK");
      return { status: "invalid", fields: update.fields };
    }
    const written = await client.query<{
      value:
        | { status: "updated" | "replayed"; profile: SharedPropertyProfileRow }
        | { status: "conflict"; currentRevision: number }
        | { status: "idempotency_conflict" }
        | { status: "private_contact_conflict" };
    }>("SELECT platform.hotel_setup_update_property_profile($1,$2,$3,$4,$5,$6,$7,$8) AS value", [
      ...ids,
      update.expectedProfileRevision,
      JSON.stringify(propertyProfileWritePayload(update.profile)),
      createHash("sha256").update(command.idempotencyKey).digest("hex"),
      command.fingerprint,
      correlation,
    ]);
    const result = written.rows[0]!.value;
    await client.query("COMMIT");
    return "profile" in result
      ? { status: result.status, profile: toSharedPropertyProfile(result.profile) }
      : result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Only the definer authority check raises HSP03; a grant/RLS gap (42501) is unavailability.
    if ((error as { code?: unknown } | null)?.code === "HSP03") throw new AuthorizationError();
    throw error;
  } finally {
    client.release();
  }
}
