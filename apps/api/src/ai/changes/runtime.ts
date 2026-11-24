// AI changes in the API (VAY-2524): the record of every change, how an AI asks for one, the one
// executor, its recovery job and the Yes/No routes, switched on together by AI_CHANGES_ENABLED
// (off by default). server.ts wires this; nothing outside apps/api/src/ai touches the executor
// (delegationBoundary.test.ts).
import { randomBytes } from "node:crypto";

import type { AuthorizationResolver, IdentityRepository } from "@vayada/backend-auth";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import pg from "pg";

import { createPgAiActionLog } from "../actionLog/actionLog.js";
import { createAiChangeExecutor, type AiChangeExecutor } from "../executor/executor.js";
import { createPgAiOperationStore } from "../executor/operationStore.js";
import { startAiChangeRecoveryWorker } from "../executor/recoveryWorker.js";
import type { PendingActionRouteOptions } from "./pendingActions.js";
import { createAiChangeProposer } from "./proposeChange.js";

export function createAiChangesRuntime(config: {
  connectionString: string;
  identity: IdentityRepository;
  authorizationResolver: AuthorizationResolver;
  /** AI is on for the account: its monthly budget is above 0. */
  aiEnabled(organizationId: string): Promise<boolean>;
  /**
   * The in-app chat still exists and is the person's (VAY-2518's conversationStore.exists).
   * Without the assistant there is no chat, so no in-app change can be answered.
   */
  chatExists(
    owner: { organizationId: string; propertyId: string; userId: string },
    conversationId: string,
  ): Promise<boolean>;
  allowedOrigins: readonly string[];
  /** The recovery job runs only where background workers do. */
  backgroundWorkersEnabled: boolean;
}) {
  if (!config.connectionString.trim())
    throw new Error("AI changes connectionString must not be empty");
  // A chat turn waits on these: a connection that can't be had in 5 s fails the call, as the
  // other AI pools do.
  const pool = (max: number) =>
    new pg.Pool({ connectionString: config.connectionString, max, connectionTimeoutMillis: 5_000 });
  const storePool = pool(4);
  const store = createPgAiOperationStore({
    connectionString: config.connectionString,
    pool: storePool,
  });
  const log = createPgAiActionLog({ connectionString: config.connectionString, pool: pool(2) });
  // This API task, as leases name it.
  const holder = `api-${process.pid}-${randomBytes(4).toString("hex")}`;
  let executor: AiChangeExecutor | undefined;
  let worker: ReturnType<typeof startAiChangeRecoveryWorker> | undefined;
  let appLog: FastifyBaseLogger | undefined;
  const logFailure = (error: unknown) =>
    appLog?.error({ err: error }, "AI action log row not written");

  return {
    /**
     * How an AI asks for a change: the in-app assistant's change tool calls it with the tool
     * call's own delegated context and returns the result as the tool's output; the card finds
     * the change by its `pendingActionId`. It records the ask and runs nothing.
     */
    proposeChange: createAiChangeProposer({ store, log, onLogFailure: logFailure }),
    /** For buildApp: the Yes/No routes. */
    routes: {
      store,
      startAndRun(operationId) {
        if (!executor) throw new Error("AI changes are not started");
        return executor.startAndRun(operationId);
      },
      aiEnabled: config.aiEnabled,
      // An in-app change needs its chat. No MCP change can be answered before its connection can
      // be checked (VAY-2528).
      channelActive: async (operation) =>
        operation.surface === "in_app" && operation.conversationId
          ? config.chatExists(
              {
                organizationId: operation.organizationId,
                propertyId: operation.propertyId,
                userId: operation.userId,
              },
              operation.conversationId,
            )
          : false,
      allowedOrigins: config.allowedOrigins,
    } satisfies Omit<PendingActionRouteOptions, "root">,

    /** Once the app exists: the executor runs its changes in it, and the recovery job starts. */
    start(app: FastifyInstance) {
      appLog = app.log;
      executor = createAiChangeExecutor({
        app,
        store,
        identity: config.identity,
        authorizationResolver: config.authorizationResolver,
        log,
        holder,
        onLogFailure: logFailure,
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
        await storePool.end();
        await log.close();
      });
    },
  };
}
