import type { AiActionLogRetentionStore } from "../ai/actionLog/aiActivity.js";

/**
 * VAY-2508: deletes AI action log rows after two years and empties Inbox assist results whose
 * 30-day retention passed (design note §7.3); VAY-2518: deletes assistant conversations 30 days
 * after their last activity. Runs every six hours, batch by batch.
 */
export const AI_ACTION_LOG_RETENTION_BATCH_SIZE = 500;
export const AI_ACTION_LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startAiActionLogRetentionWorker(options: {
  store: AiActionLogRetentionStore;
  enabled: boolean;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger: {
    info(
      context: { logRows: number; assistResults: number; conversations: number },
      message: string,
    ): void;
    error(context: { err: unknown }, message: string): void;
  };
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? AI_ACTION_LOG_RETENTION_BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const drain = async (cutoff: Date) => {
    const total = { logRows: 0, assistResults: 0, conversations: 0 };
    for (;;) {
      const batch = await options.store.purgeExpiredBatch(cutoff, batchSize);
      total.logRows += batch.logRows;
      total.assistResults += batch.assistResults;
      total.conversations += batch.conversations;
      const full = Math.max(batch.logRows, batch.assistResults, batch.conversations) >= batchSize;
      if (closing || !full) break;
    }
    if (total.logRows + total.assistResults + total.conversations > 0)
      options.logger.info(
        total,
        "Purged expired AI action log rows, Inbox assist results and assistant conversations",
      );
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= drain(now())
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "AI action log retention failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled
    ? setInterval(() => void runNow(), options.intervalMs ?? AI_ACTION_LOG_RETENTION_INTERVAL_MS)
    : undefined;
  timer?.unref();
  if (options.enabled) void runNow();

  return {
    runNow,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await activeRun;
      await options.store.close();
    },
  };
}
