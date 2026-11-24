// AI changes in the API (VAY-2524): the record of every change, the one executor, its recovery job
// and the Yes/No routes, switched on together by AI_CHANGES_ENABLED (off by default). server.ts
// wires this; nothing outside apps/api/src/ai touches the executor (delegationBoundary.test.ts).
import { randomBytes } from "node:crypto";

import type { AuthorizationResolver, IdentityRepository } from "@vayada/backend-auth";
import type { FastifyInstance } from "fastify";

import { createPgAiActionLog } from "../actionLog/actionLog.js";
import { createAiChangeExecutor, type AiChangeExecutor } from "../executor/executor.js";
import { createPgAiOperationStore, type AiOperation } from "../executor/operationStore.js";
import { startAiChangeRecoveryWorker } from "../executor/recoveryWorker.js";
import type { PendingActionRouteOptions } from "./pendingActions.js";

/**
 * Until conversations (VAY-2518) and MCP connections (VAY-2528) exist, an in-app conversation
 * always counts as still there and an MCP connection never does: no MCP change can be answered
 * before its connection can be checked. Their own checks replace this when they land.
 */
export async function interimChannelActive(operation: AiOperation): Promise<boolean> {
  return operation.surface === "in_app";
}

export function createAiChangesRuntime(config: {
  connectionString: string;
  identity: IdentityRepository;
  authorizationResolver: AuthorizationResolver;
  /** AI is on for the account: its monthly budget is above 0. */
  aiEnabled(organizationId: string): Promise<boolean>;
  allowedOrigins: readonly string[];
  /** The recovery job runs only where background workers do. */
  backgroundWorkersEnabled: boolean;
}) {
  const store = createPgAiOperationStore({ connectionString: config.connectionString, max: 4 });
  const log = createPgAiActionLog({ connectionString: config.connectionString, max: 2 });
  // This API task, as leases name it.
  const holder = `api-${process.pid}-${randomBytes(4).toString("hex")}`;
  let executor: AiChangeExecutor | undefined;
  let worker: ReturnType<typeof startAiChangeRecoveryWorker> | undefined;

  return {
    /** For buildApp: the Yes/No routes. */
    routes: {
      store,
      startAndRun(operationId) {
        if (!executor) throw new Error("AI changes are not started");
        return executor.startAndRun(operationId);
      },
      aiEnabled: config.aiEnabled,
      channelActive: interimChannelActive,
      allowedOrigins: config.allowedOrigins,
    } satisfies Omit<PendingActionRouteOptions, "root">,

    /** Once the app exists: the executor runs its changes in it, and the recovery job starts. */
    start(app: FastifyInstance) {
      executor = createAiChangeExecutor({
        app,
        store,
        identity: config.identity,
        authorizationResolver: config.authorizationResolver,
        log,
        holder,
        onLogFailure: (error) => app.log.error({ err: error }, "AI action log row not written"),
        onRunFailure: (error, operation) =>
          app.log.error(
            { err: error, operationId: operation.id },
            "AI change run broke; the recovery job takes it over",
          ),
      });
      worker = startAiChangeRecoveryWorker({
        executor,
        enabled: config.backgroundWorkersEnabled,
        logger: app.log,
      });
      app.addHook("onClose", async () => {
        await worker?.close();
        await store.end();
        await log.close();
      });
    },
  };
}
