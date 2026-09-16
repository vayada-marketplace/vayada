import {
  prepareAdminTransferProof,
  resolveAdminTransferCommandSource,
  resolveAdminTransferSource,
  runAdminTransfer,
  type AdminTransferSessionSource,
} from "@vayada/backend-auth";
import type { Pool } from "pg";
import type { createWorkOSAdminReauthentication } from "./workosAdminReauthentication.js";

type Reauthentication = ReturnType<typeof createWorkOSAdminReauthentication>;

/** Coordinates the database proof lifecycle with hosted reauthentication.
 * The HTTP adapter must supply a freshly authenticated, still-live browser session.
 */
export function createAdminTransferCoordinator(options: {
  pool: Pool;
  reauthentication: Reauthentication;
}) {
  return {
    async start(source: AdminTransferSessionSource, request: unknown, loginHint: string) {
      const resolved = await resolveAdminTransferSource(options.pool, source);
      if (!resolved) return { outcome: "rejected", reason: "forbidden" } as const;
      const prepared = await prepareAdminTransferProof(options.pool, resolved, request);
      if (prepared.outcome === "rejected") return prepared;
      const flow = await options.reauthentication.start(
        prepared.binding,
        prepared.state,
        loginHint,
      );
      return { outcome: "prepared", ...flow } as const;
    },

    async completeReauthentication(input: {
      source: AdminTransferSessionSource;
      flowCookie: string;
      state: string;
      code: string;
      ipAddress?: string;
      userAgent?: string;
    }) {
      const resolved = await resolveAdminTransferSource(options.pool, input.source);
      if (!resolved) return null;
      return options.reauthentication.complete({ ...input, source: resolved });
    },

    async transfer(source: AdminTransferSessionSource, request: unknown, proofId: string) {
      const resolved = await resolveAdminTransferCommandSource(options.pool, source);
      return resolved
        ? runAdminTransfer(options.pool, resolved, request, proofId)
        : ({ outcome: "rejected", reason: "forbidden" } as const);
    },
  };
}

export type AdminTransferCoordinator = ReturnType<typeof createAdminTransferCoordinator>;
