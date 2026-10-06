import { randomBytes } from "node:crypto";
import {
  assertHotelSetupBootstrapLock,
  HotelSetupHelperGrantInspection,
  type grantFreshHotelSetupHelpers,
} from "./hotelSetupHelperOwnerGrants.js";
import type { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import type { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import {
  hotelSetupOrganizationConnection,
  lockHotelSetupOrganizationBootstrapAuthority,
  stageHotelSetupOrganizationRole,
} from "./hotelSetupOrganizationRoleStaging.js";
import { activateVerifiedHotelSetupOrganizationRole } from "./hotelSetupOrganizationRoleActivation.js";
import {
  lockHotelSetupPropertyBootstrapAuthority,
  stageHotelSetupPropertyRole,
} from "./hotelSetupPropertyRoleStaging.js";
import { activateVerifiedHotelSetupPropertyRole } from "./hotelSetupPropertyRoleActivation.js";
import {
  advanceHotelSetupAutomaticCursor,
  discoverHotelSetupAutomaticCandidates,
  inspectHotelSetupAutomaticIdentity,
  HOTEL_SETUP_AUTOMATIC_PURPOSES,
  type HotelSetupAutomaticMode,
} from "./hotelSetupAutomaticDiscovery.js";

/** Fixed operational CLI only. Helpers independently reread authority on their own connections. */
export async function reconcileHotelSetupAutomaticScopes(input: {
  mode: HotelSetupAutomaticMode;
  adminDatabaseUrl: string;
  databaseEndpoint: string;
  helperOwnerDatabaseUrl?: string;
  onHelperPhase?: (
    receipt:
      | Parameters<NonNullable<Parameters<typeof grantFreshHotelSetupHelpers>[0]["onPhase"]>>[0]
      | undefined,
  ) => void;
  proveOrganization?: typeof checkHotelSetupCreationCredential;
  proveProperty?: typeof checkHotelSetupPropertyCredential;
}) {
  const { mode, adminDatabaseUrl, databaseEndpoint } = input;
  if (
    (mode !== "organization" && mode !== "property") ||
    typeof (mode === "organization" ? input.proveOrganization : input.proveProperty) !== "function"
  )
    throw new Error();
  const admin = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
  let failed = false;
  admin.on("error", () => {
    failed = true;
  });
  const assertConnected = () => {
    if (failed) throw new Error();
  };
  const receipts: Array<{
    scopeId: string;
    organizationId: string;
    purpose: string;
    status: string;
  }> = [];
  const deadline = Date.now() + 120_000;
  try {
    await admin.connect();
    // A member of a native scope is treated as a native identity by setup RLS: its discovery and
    // authority reads silently see nothing. Fail the pass loudly instead of reporting no work.
    const member = await admin.query<{ member: boolean }>(
      `SELECT pg_catalog.bool_or(pg_catalog.pg_has_role(current_user,scope,'MEMBER')) AS member
       FROM pg_catalog.unnest($1::text[]) scope`,
      [
        [
          "vayada_next_hotel_setup_scope",
          "vayada_next_hotel_setup_property_scope",
          "vayada_next_hotel_setup_logo_scope",
        ],
      ],
    );
    if (member.rows[0]?.member !== false)
      throw new Error("Hotel setup operator must not be a native scope member");
    if (input.helperOwnerDatabaseUrl) {
      const lock = await admin.query<{ held: boolean }>(
        "SELECT pg_catalog.pg_try_advisory_lock_shared(8734516) AS held",
      );
      if (lock.rows[0]?.held !== true) throw new Error();
    }
    const claim = await admin.query<{ claimed: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1,0)) AS claimed",
      [`hotel_setup_reconciliation_pass:${mode}`],
    );
    assertConnected();
    if (claim.rows[0]?.claimed !== true) return { status: "busy", receipts };
    const candidates = await discoverHotelSetupAutomaticCandidates(admin, mode);
    assertConnected();
    if (!candidates.length) await advanceHotelSetupAutomaticCursor(admin, mode);
    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      await advanceHotelSetupAutomaticCursor(admin, mode, candidate);
      assertConnected();
      for (const purpose of mode === "organization"
        ? [undefined]
        : HOTEL_SETUP_AUTOMATIC_PURPOSES) {
        if (Date.now() >= deadline) break;
        const key = `hotel_setup_reconciliation_scope:${mode}:${candidate.scopeId}:${purpose ?? "creation"}`;
        const locked = await admin.query<{ claimed: boolean }>(
          "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended($1,0)) AS claimed",
          [key],
        );
        assertConnected();
        if (locked.rows[0]?.claimed !== true) continue;
        let status = "inspection_required";
        try {
          const existing = await inspectHotelSetupAutomaticIdentity(admin, candidate, purpose);
          assertConnected();
          if (existing !== "inspection_required") {
            const scope = Object.freeze({
              organizationId: candidate.organizationId,
              actorUserId: candidate.actorUserId,
            });
            const propertyScope = Object.freeze({
              ...scope,
              propertyId: candidate.scopeId,
              operation: purpose!,
              automatic: true as const,
            });
            let eligible = false;
            await admin.query("BEGIN");
            try {
              if (purpose) await lockHotelSetupPropertyBootstrapAuthority(admin, propertyScope);
              else await lockHotelSetupOrganizationBootstrapAuthority(admin, scope);
              eligible = true;
            } catch {
              /* Authority is unavailable; no identity has been staged by this attempt. */
            } finally {
              await admin.query("ROLLBACK");
            }
            assertConnected();
            status = "pending_authority";
            if (eligible) {
              status = existing;
              if (existing === "fresh") {
                status = "inspection_required";
                // Keep this candidate actor for the entire attempt, including both native proofs.
                input.onHelperPhase?.(undefined);
                const config = {
                  adminDatabaseUrl,
                  databaseEndpoint,
                  ...(input.helperOwnerDatabaseUrl ? { bootstrapHolder: admin } : {}),
                  ...(input.helperOwnerDatabaseUrl
                    ? {
                        helperOwner: {
                          databaseUrl: input.helperOwnerDatabaseUrl,
                          holder: admin,
                          onPhase: input.onHelperPhase,
                        },
                      }
                    : {}),
                };
                const staged = purpose
                  ? await stageHotelSetupPropertyRole({ ...config, scope: propertyScope })
                  : await stageHotelSetupOrganizationRole({ ...config, scope });
                assertConnected();
                if (input.helperOwnerDatabaseUrl) await assertHotelSetupBootstrapLock(admin);
                const native = new URL(adminDatabaseUrl);
                native.username = staged.login;
                native.password = randomBytes(36).toString("base64url");
                if (purpose)
                  await activateVerifiedHotelSetupPropertyRole({
                    ...config,
                    staged: staged as Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>,
                    nativeDatabaseUrl: native.toString(),
                    proveSecondary: input.proveProperty!,
                    publish: true,
                  });
                else
                  await activateVerifiedHotelSetupOrganizationRole({
                    ...config,
                    staged,
                    nativeDatabaseUrl: native.toString(),
                    proveSecondary: input.proveOrganization!,
                  });
                assertConnected();
                status = "provisioned";
              }
            }
          }
        } catch (error) {
          assertConnected();
          if (error instanceof HotelSetupHelperGrantInspection) throw error;
        } finally {
          await admin.query(
            "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))",
            [key],
          );
        }
        receipts.push({
          scopeId: candidate.scopeId,
          organizationId: candidate.organizationId,
          purpose: purpose ?? "creation",
          status,
        });
      }
    }
    assertConnected();
    return { status: "PASS", receipts };
  } finally {
    await admin.end().catch(() => undefined);
  }
}
